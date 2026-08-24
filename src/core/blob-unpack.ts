import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { BLOB_ENTRY_KIND, BLOB_FLAGS, type FileEntry } from '../types/index.js';
import { extractZip } from './compression.js';
import type { SkippedFile } from './errors.js';
import { BfsError } from './errors.js';
import { resolveSafeChildPath } from './fs-utils.js';
import { hashBuffer, SHA256_BYTES } from './hash.js';

// Blob header size - 70 bytes for both v1 and v2 (the version bump lives in the
// file-table entry, which gains a `kind` byte and a `created_at` field in v2).
const HEADER_SIZE = 70;
const CHECKSUM_SIZE = SHA256_BYTES;

// Smallest possible file-table entry, used to cap a header-declared fileCount
// before it drives any allocation or loop. A v1 entry with a 0-byte path is
// pathLen(2) + size(8) + dataOffset(8) + hash(32) + mode(4) + modifiedAt(8) = 62;
// a v2 entry is larger (kind + created_at), so 62 is a safe conservative floor.
const MIN_FILE_ENTRY_SIZE = 62;
const CHUNK = 4 * 1024 * 1024;

/**
 * Parses one file-table entry from `buf` starting at `pos`, dispatching on the
 * blob's `formatVersion`. v1 entries have no `kind`/`created_at` (defaults:
 * NEW_FILE / 0); v2 entries carry `kind` right after the path and a trailing
 * `created_at`. Every field is bounds-checked against `end` so a truncated or
 * tampered table throws a BfsError instead of reading out of range.
 *
 * @throws BfsError on truncation, or on a v2 `kind` other than NEW_FILE (the
 *         METADATA_ONLY / DELETED kinds are reserved for incremental restore).
 */
function _parseFileTableEntry(buf: Buffer, pos: number, end: number, formatVersion: number, index: number): { entry: FileEntry; next: number } {
  if (pos + 2 > end) throw new BfsError(`File table truncated at entry ${index}`);
  const pathLen = buf.readUInt16LE(pos);
  pos += 2;
  if (pos + pathLen > end) throw new BfsError(`File table path truncated at entry ${index}`);
  const filePath = buf.toString('utf8', pos, pos + pathLen);
  pos += pathLen;

  let kind: number = BLOB_ENTRY_KIND.NEW_FILE;
  if (formatVersion >= 2) {
    if (pos + 1 > end) throw new BfsError(`File table truncated at entry ${index}`);
    kind = buf.readUInt8(pos);
    pos += 1;
    if (kind !== BLOB_ENTRY_KIND.NEW_FILE) {
      throw new BfsError(`File table entry ${index}: kind ${kind} requires incremental-restore support (not implemented)`);
    }
  }

  // NEW_FILE tail: size(8) + data_offset(8) + hash(32) + mode(4) + modified_at(8) [+ created_at(8) for v2].
  const tail = 8 + 8 + SHA256_BYTES + 4 + 8 + (formatVersion >= 2 ? 8 : 0);
  if (pos + tail > end) throw new BfsError(`File table entry ${index} truncated`);
  const size = buf.readBigUInt64LE(pos);
  pos += 8;
  const dataOffset = buf.readBigUInt64LE(pos);
  pos += 8;
  const hash = buf.subarray(pos, pos + SHA256_BYTES).toString('hex');
  pos += SHA256_BYTES;
  const mode = buf.readUInt32LE(pos);
  pos += 4;
  const modifiedAt = buf.readBigUInt64LE(pos);
  pos += 8;
  let createdAt = 0n;
  if (formatVersion >= 2) {
    createdAt = buf.readBigUInt64LE(pos);
    pos += 8;
  }

  return { entry: { path: filePath, kind, size, data_offset: dataOffset, hash, mode, modified_at: modifiedAt, created_at: createdAt }, next: pos };
}

/** Parses `fileCount` file-table entries from a buffer window [0, end). */
function _parseEntriesFromBuffer(buf: Buffer, fileCount: number, end: number, formatVersion: number): FileEntry[] {
  const entries: FileEntry[] = [];
  let pos = 0;
  for (let i = 0; i < fileCount; i++) {
    const { entry, next } = _parseFileTableEntry(buf, pos, end, formatVersion, i);
    entries.push(entry);
    pos = next;
  }
  return entries;
}

/**
 * Reapplies a restored file's metadata. mtime is always restored (portable via
 * fs.utimes). mode is reapplied only for v2 blobs (`applyMode`) - v1 blobs keep
 * the legacy behaviour where mode was never restored. `created_at` is carried in
 * the entry but not reapplied: no portable API sets a file's birth time. Every
 * call is best-effort, so failing to set mode/mtime never fails the byte restore.
 */
async function applyFileMetadata(targetPath: string, entry: FileEntry, applyMode: boolean): Promise<void> {
  const mtimeSec = Number(entry.modified_at) / 1000;
  await fs.utimes(targetPath, mtimeSec, mtimeSec).catch(() => {});
  if (applyMode) {
    await fs.chmod(targetPath, entry.mode).catch(() => {});
  }
}

/**
 * Parses the file table from a BFS blob - pure logic, no I/O. Dispatches on the
 * header's format_version so v1 and v2 entry shapes are both read correctly.
 *
 * @throws BfsError if the blob is too short, the magic is invalid, or the file
 *         table is truncated
 */
export function parseBlobFileTable(blob: Buffer): FileEntry[] {
  if (blob.length < HEADER_SIZE + CHECKSUM_SIZE) {
    throw new BfsError('Blob too short to be valid');
  }

  const magic = `${blob.toString('ascii', 0, 3)}\0`;
  if (magic !== 'BFS\0') {
    throw new BfsError(`Invalid blob magic: expected BFS\\0, got ${JSON.stringify(blob.toString('ascii', 0, 4))}`);
  }

  const formatVersion = blob.readUInt16LE(0x04);
  const fileCount = blob.readUInt32LE(0x22);
  const fileTableOffset = Number(blob.readBigUInt64LE(0x26));

  const entries: FileEntry[] = [];
  let pos = fileTableOffset;
  for (let i = 0; i < fileCount; i++) {
    const { entry, next } = _parseFileTableEntry(blob, pos, blob.length, formatVersion, i);
    entries.push(entry);
    pos = next;
  }
  return entries;
}

/**
 * Unpacks a BFS blob to targetDir, verifying checksums.
 * Files that cannot be written (e.g. permission denied, disk full) are skipped and
 * listed in the returned `skipped` array instead of aborting the entire operation.
 * Data-corruption errors (checksum/hash mismatch) still throw.
 *
 * @param blob      - Full BFS blob buffer (including trailing SHA-256)
 * @param targetDir - Directory to write files into
 * @param filter    - Optional: unpack only entries where filter returns true (raw path only)
 * @returns         - `{ extracted, skipped }` - written entries and any that could not be written
 * @throws BfsError on data corruption (checksum / hash mismatch)
 * @throws UnsafePathError when an entry path escapes targetDir - this aborts the
 *         restore rather than being collected as skipped
 */
export async function unpackBlob(blob: Buffer, targetDir: string, filter?: (entry: FileEntry) => boolean): Promise<{ extracted: FileEntry[]; skipped: SkippedFile[] }> {
  if (blob.length < HEADER_SIZE + CHECKSUM_SIZE) {
    throw new BfsError('Blob too short to be valid');
  }

  // 1. Verify trailing SHA-256 checksum
  const storedChecksum = blob.subarray(blob.length - CHECKSUM_SIZE);
  const blobBody = blob.subarray(0, blob.length - CHECKSUM_SIZE);
  const computedChecksum = Buffer.from(hashBuffer(blobBody), 'hex');
  if (!storedChecksum.equals(computedChecksum)) {
    throw new BfsError('Blob checksum mismatch - data is corrupted or tampered');
  }

  // 2. Header: version, flags, data-section window
  const formatVersion = blob.readUInt16LE(0x04);
  const applyMode = formatVersion >= 2;
  const flags = blob.readUInt32LE(0x16);
  const isCompressed = (flags & BLOB_FLAGS.COMPRESSED) !== 0;
  const dataSectionOffset = Number(blob.readBigUInt64LE(0x36));
  const dataSectionLength = Number(blob.readBigUInt64LE(0x3e));

  // 3. File table (per-file entries with metadata, both raw and v2-compressed)
  const entries = parseBlobFileTable(blob);

  if (isCompressed) {
    const zipBuffer = blob.subarray(dataSectionOffset, dataSectionOffset + dataSectionLength);
    return _extractZipToDir(zipBuffer, targetDir, entries, formatVersion);
  }

  // 4. Raw path - slice each file out of the data section
  const extracted: FileEntry[] = [];
  const skipped: SkippedFile[] = [];

  for (const entry of entries) {
    if (filter !== undefined && !filter(entry)) continue;

    const start = dataSectionOffset + Number(entry.data_offset);
    const end = start + Number(entry.size);

    // Data-corruption checks still throw - these are not permission issues
    if (end > blob.length - CHECKSUM_SIZE) {
      throw new BfsError(`Data section out of bounds for file: ${entry.path}`);
    }

    const data = blob.subarray(start, end);
    if (hashBuffer(data) !== entry.hash) {
      throw new BfsError(`File hash mismatch for: ${entry.path}`);
    }

    // resolveSafeChildPath runs before the try so an UnsafePathError (path
    // escaping targetDir) propagates and aborts the restore instead of being
    // demoted to a skipped entry - consistent with the hash-mismatch throw above.
    const targetPath = resolveSafeChildPath(targetDir, entry.path);
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, data);
      await applyFileMetadata(targetPath, entry, applyMode);
      extracted.push(entry);
    } catch (e: unknown) {
      skipped.push({ path: entry.path, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { extracted, skipped };
}

/**
 * Parses the file table from a BFS blob file without loading the full file into memory.
 * Reads the 70-byte header and the file table section; the table is located via
 * the header's file_table_offset and read with the format-version-aware parser,
 * so v1 and v2 blobs both work.
 *
 * @param blobPath - Path to the blob file on disk
 * @returns Array of FileEntry records
 * @throws BfsError if the file is too short, magic is invalid, or table is truncated
 */
export async function parseBlobFileTableFromFile(blobPath: string): Promise<FileEntry[]> {
  const fh = await fs.open(blobPath, 'r');
  try {
    const { size: fileSize } = await fh.stat();
    // A blob is never smaller than its header plus the trailing checksum. The
    // buffer-based parser rejects that up front; without the same floor here a
    // header-only leftover from an interrupted pack would read as a valid blob.
    if (fileSize < HEADER_SIZE + CHECKSUM_SIZE) throw new BfsError('Blob file too short to be a valid blob');
    const header = Buffer.alloc(HEADER_SIZE);
    const { bytesRead: hRead } = await fh.read(header, 0, HEADER_SIZE, 0);
    if (hRead < HEADER_SIZE) throw new BfsError('Blob file too short to contain header');

    const magic = `${header.toString('ascii', 0, 3)}\0`;
    if (magic !== 'BFS\0') {
      throw new BfsError(`Invalid blob magic: expected BFS\\0, got ${JSON.stringify(header.toString('ascii', 0, 4))}`);
    }

    const formatVersion = header.readUInt16LE(0x04);
    const fileCount = header.readUInt32LE(0x22);
    const fileTableOffset = Number(header.readBigUInt64LE(0x26));
    const fileTableLength = Number(header.readBigUInt64LE(0x2e));

    assertSectionWithinFile({ offset: fileTableOffset, length: fileTableLength }, fileSize, 'file table');
    assertFileCountFits(fileCount, fileTableLength);

    const ftBuf = Buffer.alloc(fileTableLength);
    const { bytesRead: ftRead } = await fh.read(ftBuf, 0, fileTableLength, fileTableOffset);
    if (ftRead < fileTableLength) throw new BfsError('Blob file table truncated');

    return _parseEntriesFromBuffer(ftBuf, fileCount, ftBuf.length, formatVersion);
  } finally {
    await fh.close();
  }
}

/**
 * Unpacks a BFS blob from a file path using random-access I/O.
 * Works for blobs of any size - does not load the full blob into memory (raw path).
 * Files are read in 4 MiB chunks; per-file and whole-blob checksums are verified.
 *
 * @param blobPath  - Path to the blob file on disk
 * @param targetDir - Directory to write extracted files into
 * @param filter    - Optional: unpack only entries where filter returns true (raw path only)
 * @returns `{ extracted, skipped }` - written entries and any that could not be written
 * @throws BfsError on data corruption (checksum / hash mismatch)
 * @throws UnsafePathError when an entry path escapes targetDir - this aborts the
 *         restore rather than being collected as skipped
 */
export async function unpackBlobFromFile(blobPath: string, targetDir: string, filter?: (entry: FileEntry) => boolean): Promise<{ extracted: FileEntry[]; skipped: SkippedFile[] }> {
  const fileStat = await fs.stat(blobPath);
  if (fileStat.size < HEADER_SIZE + CHECKSUM_SIZE) throw new BfsError('Blob too short to be valid');

  const fh = await fs.open(blobPath, 'r');
  try {
    // -- 1. Read header (version, offsets, counts) --------------------------
    const header = Buffer.alloc(HEADER_SIZE);
    await fh.read(header, 0, HEADER_SIZE, 0);

    const magic = `${header.toString('ascii', 0, 3)}\0`;
    if (magic !== 'BFS\0') {
      throw new BfsError(`Invalid blob magic: expected BFS\\0, got ${JSON.stringify(header.toString('ascii', 0, 4))}`);
    }

    const formatVersion = header.readUInt16LE(0x04);
    const applyMode = formatVersion >= 2;
    const fileCount = header.readUInt32LE(0x22);
    const fileTableOffset = Number(header.readBigUInt64LE(0x26));
    const fileTableLength = Number(header.readBigUInt64LE(0x2e));
    const dataSectionOffset = Number(header.readBigUInt64LE(0x36));

    assertSectionWithinFile({ offset: fileTableOffset, length: fileTableLength }, fileStat.size, 'file table');
    assertFileCountFits(fileCount, fileTableLength);

    // -- 2. Read + parse file table -----------------------------------------
    const ftBuf = Buffer.alloc(fileTableLength);
    await fh.read(ftBuf, 0, fileTableLength, fileTableOffset);
    const entries = _parseEntriesFromBuffer(ftBuf, fileCount, ftBuf.length, formatVersion);

    // -- 3. Verify trailing SHA-256 checksum (streaming, 4 MiB chunks) ------
    const hashLen = fileStat.size - CHECKSUM_SIZE;
    const checksumHash = createHash('sha256');
    let readPos = 0;
    while (readPos < hashLen) {
      const toRead = Math.min(CHUNK, hashLen - readPos);
      // eslint-disable-next-line no-await-in-loop
      const chunk = Buffer.alloc(toRead);
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await fh.read(chunk, 0, toRead, readPos);
      checksumHash.update(chunk.subarray(0, bytesRead));
      readPos += bytesRead;
    }
    const computedChecksum = checksumHash.digest();
    const storedChecksum = Buffer.alloc(CHECKSUM_SIZE);
    await fh.read(storedChecksum, 0, CHECKSUM_SIZE, fileStat.size - CHECKSUM_SIZE);
    if (!computedChecksum.equals(storedChecksum)) {
      throw new BfsError('Blob checksum mismatch - data is corrupted or tampered');
    }

    // -- 4. Compressed data section -> ZIP (loaded into RAM to extract) ------
    const flags = header.readUInt32LE(0x16);
    const isCompressed = (flags & BLOB_FLAGS.COMPRESSED) !== 0;
    const dataSectionLength = Number(header.readBigUInt64LE(0x3e));

    if (isCompressed) {
      assertSectionWithinFile({ offset: dataSectionOffset, length: dataSectionLength }, fileStat.size, 'data section');
      const zipBuffer = Buffer.alloc(dataSectionLength);
      await fh.read(zipBuffer, 0, dataSectionLength, dataSectionOffset);
      return _extractZipToDir(zipBuffer, targetDir, entries, formatVersion);
    }

    // -- 5. Raw path - extract each file using random-access reads ----------
    const extracted: FileEntry[] = [];
    const skipped: SkippedFile[] = [];

    for (const entry of entries) {
      if (filter !== undefined && !filter(entry)) continue;

      const fileStart = dataSectionOffset + Number(entry.data_offset);
      const fileEnd = fileStart + Number(entry.size);

      if (fileEnd > hashLen) {
        throw new BfsError(`Data section out of bounds for file: ${entry.path}`);
      }

      const targetPath = resolveSafeChildPath(targetDir, entry.path);
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const wfh = await fs.open(targetPath, 'w');
        const fileHash = createHash('sha256');
        try {
          let fp = fileStart;
          while (fp < fileEnd) {
            const toRead = Math.min(CHUNK, fileEnd - fp);
            const chunk = Buffer.alloc(toRead);
            // eslint-disable-next-line no-await-in-loop
            const { bytesRead } = await fh.read(chunk, 0, toRead, fp);
            const data = chunk.subarray(0, bytesRead);
            fileHash.update(data);
            // eslint-disable-next-line no-await-in-loop
            await wfh.write(data);
            fp += bytesRead;
          }
        } finally {
          await wfh.close().catch(() => {});
        }

        if (fileHash.digest('hex') !== entry.hash) {
          throw new BfsError(`File hash mismatch for: ${entry.path}`);
        }

        await applyFileMetadata(targetPath, entry, applyMode);
        extracted.push(entry);
      } catch (e: unknown) {
        if (e instanceof BfsError) throw e; // data corruption - propagate
        skipped.push({ path: entry.path, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    return { extracted, skipped };
  } finally {
    await fh.close();
  }
}

// --- Private helpers ----------------------------------------------------------

/** A byte window inside a blob file, declared by the (untrusted) header. */
interface FileWindow {
  offset: number;
  length: number;
}

/**
 * Validates a header-declared (offset, length) window against the actual blob
 * file size before a buffer is allocated for it. A tampered header could
 * declare a multi-GiB length and crash the process at Buffer.alloc - long
 * before the bounds-checked parsing loop would reject it.
 *
 * @throws BfsError if offset/length are not safe integers, are negative, or
 *         describe a window that extends past the end of the file.
 */
function assertSectionWithinFile(window: FileWindow, fileSize: number, label: string): void {
  const { offset, length } = window;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0) {
    throw new BfsError(`${label}: invalid header offset/length (${offset}/${length})`);
  }
  if (offset > fileSize || length > fileSize - offset) {
    throw new BfsError(`${label}: section out of file bounds (offset ${offset}, length ${length}, file ${fileSize})`);
  }
}

/**
 * Caps a header-declared file count against the byte budget of the file table.
 * Each entry needs at least MIN_FILE_ENTRY_SIZE bytes, so a count larger than
 * the table can hold signals a corrupt or tampered header.
 *
 * @throws BfsError if fileCount cannot fit within fileTableLength.
 */
function assertFileCountFits(fileCount: number, fileTableLength: number): void {
  if (!Number.isSafeInteger(fileCount) || fileCount < 0) {
    throw new BfsError(`Invalid file count in header: ${fileCount}`);
  }
  if (fileCount > Math.floor(fileTableLength / MIN_FILE_ENTRY_SIZE)) {
    throw new BfsError(`File count ${fileCount} exceeds file table capacity (${fileTableLength} bytes)`);
  }
}

/**
 * Extracts a compressed (ZIP) data section to targetDir. CRC-32 is verified by
 * extractZip() for each entry. Dispatches on format_version:
 *  - v1: the file table held only the "bfs.pack.zip" pseudo-entry, so per-file
 *    identity is the ZIP entry names - each is restored directly, with no mode or
 *    mtime.
 *  - v2: the file table lists one entry per user file carrying mode/mtime plus the
 *    uncompressed size/hash; the ZIP provides content. Entries drive the restore,
 *    content is matched by path, size/hash are verified (per-file integrity on top
 *    of the ZIP CRC), and mode/mtime are reapplied.
 * I/O errors (permission denied, disk full) are collected as skipped - not thrown.
 */
async function _extractZipToDir(zipBuffer: Buffer, targetDir: string, entries: FileEntry[], formatVersion: number): Promise<{ extracted: FileEntry[]; skipped: SkippedFile[] }> {
  const zipEntries = extractZip(zipBuffer); // throws BfsError on corrupt ZIP
  const extracted: FileEntry[] = [];
  const skipped: SkippedFile[] = [];

  if (formatVersion < 2) {
    for (const entry of zipEntries) {
      const targetPath = resolveSafeChildPath(targetDir, entry.filename);
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.writeFile(targetPath, entry.data);
        extracted.push({ path: entry.filename, kind: BLOB_ENTRY_KIND.NEW_FILE, size: BigInt(entry.data.length), data_offset: 0n, hash: '', mode: 0, modified_at: 0n, created_at: 0n });
      } catch (e: unknown) {
        skipped.push({ path: entry.filename, reason: e instanceof Error ? e.message : String(e) });
      }
    }
    return { extracted, skipped };
  }

  const zipMap = new Map(zipEntries.map((z) => [z.filename, z.data]));
  for (const entry of entries) {
    const data = zipMap.get(entry.path);
    if (data === undefined) {
      throw new BfsError(`Compressed entry missing from ZIP: ${entry.path}`);
    }
    if (BigInt(data.length) !== entry.size) {
      throw new BfsError(`File size mismatch for: ${entry.path}`);
    }
    if (hashBuffer(data) !== entry.hash) {
      throw new BfsError(`File hash mismatch for: ${entry.path}`);
    }

    const targetPath = resolveSafeChildPath(targetDir, entry.path);
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, data);
      await applyFileMetadata(targetPath, entry, true);
      extracted.push(entry);
    } catch (e: unknown) {
      skipped.push({ path: entry.path, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  return { extracted, skipped };
}
