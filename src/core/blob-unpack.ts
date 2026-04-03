import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileEntry } from '../types/index.js';
import type { SkippedFile } from './errors.js';
import { BfsError } from './errors.js';
import { hashBuffer } from './hash.js';

const HEADER_SIZE = 70;
const CHECKSUM_SIZE = 32;

/**
 * Parses the file table from a BFS blob — pure logic, no I/O.
 */
export function parseBlobFileTable(blob: Buffer): FileEntry[] {
  if (blob.length < HEADER_SIZE + CHECKSUM_SIZE) {
    throw new BfsError('Blob too short to be valid');
  }

  const magic = `${blob.toString('ascii', 0, 3)}\0`;
  if (magic !== 'BFS\0') {
    throw new BfsError(
      `Invalid blob magic: expected BFS\\0, got ${JSON.stringify(blob.toString('ascii', 0, 4))}`,
    );
  }

  const fileCount = blob.readUInt32LE(0x22); // 34
  const fileTableOffset = blob.readBigUInt64LE(0x26); // 38

  const entries: FileEntry[] = [];
  let pos = Number(fileTableOffset);

  for (let i = 0; i < fileCount; i++) {
    if (pos + 2 > blob.length)
      throw new BfsError(`File table truncated at entry ${i}`);
    const pathLen = blob.readUInt16LE(pos);
    pos += 2;
    if (pos + pathLen > blob.length)
      throw new BfsError(`File table path truncated at entry ${i}`);
    const filePath = blob.toString('utf8', pos, pos + pathLen);
    pos += pathLen;
    const size = blob.readBigUInt64LE(pos);
    pos += 8;
    const dataOffset = blob.readBigUInt64LE(pos);
    pos += 8;
    const hash = blob.subarray(pos, pos + 32).toString('hex');
    pos += 32;
    const mode = blob.readUInt32LE(pos);
    pos += 4;
    const modifiedAt = blob.readBigUInt64LE(pos);
    pos += 8;

    entries.push({
      path: filePath,
      size,
      data_offset: dataOffset,
      hash,
      mode,
      modified_at: modifiedAt,
    });
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
 * @param filter    - Optional: unpack only entries where filter returns true
 * @returns         - `{ extracted, skipped }` — written entries and any that could not be written
 */
export async function unpackBlob(
  blob: Buffer,
  targetDir: string,
  filter?: (entry: FileEntry) => boolean,
): Promise<{ extracted: FileEntry[]; skipped: SkippedFile[] }> {
  if (blob.length < HEADER_SIZE + CHECKSUM_SIZE) {
    throw new BfsError('Blob too short to be valid');
  }

  // 1. Verify trailing SHA-256 checksum
  const storedChecksum = blob.subarray(blob.length - CHECKSUM_SIZE);
  const blobBody = blob.subarray(0, blob.length - CHECKSUM_SIZE);
  const computedChecksum = Buffer.from(hashBuffer(blobBody), 'hex');

  if (!storedChecksum.equals(computedChecksum)) {
    throw new BfsError(
      'Blob checksum mismatch — data is corrupted or tampered',
    );
  }

  // 2. Parse file table
  const entries = parseBlobFileTable(blob);

  // 3. Read data section offset from header
  const dataSectionOffset = blob.readBigUInt64LE(0x36); // 54

  // 4. Extract files
  const extracted: FileEntry[] = [];
  const skipped: SkippedFile[] = [];

  for (const entry of entries) {
    if (filter !== undefined && !filter(entry)) continue;

    const start = Number(dataSectionOffset) + Number(entry.data_offset);
    const end = start + Number(entry.size);

    // Data-corruption checks still throw — these are not permission issues
    if (end > blob.length - CHECKSUM_SIZE) {
      throw new BfsError(`Data section out of bounds for file: ${entry.path}`);
    }

    const data = blob.subarray(start, end);

    // 5. Verify per-file hash (throws on corruption)
    const computedFileHash = hashBuffer(data);
    if (computedFileHash !== entry.hash) {
      throw new BfsError(`File hash mismatch for: ${entry.path}`);
    }

    // 6. Write file to disk — skip on I/O failure (permission, disk full, etc.)
    const targetPath = path.join(targetDir, entry.path);
    try {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.writeFile(targetPath, data);

      // 7. Restore mtime — best-effort, does not block success
      const mtimeSec = Number(entry.modified_at) / 1000;
      await fs.utimes(targetPath, mtimeSec, mtimeSec).catch(() => {});

      extracted.push(entry);
    } catch (e: unknown) {
      skipped.push({
        path: entry.path,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return { extracted, skipped };
}

/**
 * Parses the file table from a BFS blob file without loading the full file into memory.
 * Reads only the 70-byte header and the file table section.
 *
 * @param blobPath - Path to the blob file on disk
 * @returns Array of FileEntry records
 * @throws BfsError if the file is too short, magic is invalid, or table is truncated
 */
export async function parseBlobFileTableFromFile(
  blobPath: string,
): Promise<FileEntry[]> {
  const fh = await fs.open(blobPath, 'r');
  try {
    const header = Buffer.alloc(HEADER_SIZE);
    const { bytesRead: hRead } = await fh.read(header, 0, HEADER_SIZE, 0);
    if (hRead < HEADER_SIZE)
      throw new BfsError('Blob file too short to contain header');

    const magic = `${header.toString('ascii', 0, 3)}\0`;
    if (magic !== 'BFS\0') {
      throw new BfsError(
        `Invalid blob magic: expected BFS\\0, got ${JSON.stringify(header.toString('ascii', 0, 4))}`,
      );
    }

    const fileCount = header.readUInt32LE(0x22);
    const fileTableOffset = Number(header.readBigUInt64LE(0x26));
    const fileTableLength = Number(header.readBigUInt64LE(0x2e));

    const ftBuf = Buffer.alloc(fileTableLength);
    const { bytesRead: ftRead } = await fh.read(
      ftBuf,
      0,
      fileTableLength,
      fileTableOffset,
    );
    if (ftRead < fileTableLength)
      throw new BfsError('Blob file table truncated');

    const entries: FileEntry[] = [];
    let pos = 0;
    for (let i = 0; i < fileCount; i++) {
      if (pos + 2 > ftBuf.length)
        throw new BfsError(`File table truncated at entry ${i}`);
      const pathLen = ftBuf.readUInt16LE(pos);
      pos += 2;
      if (pos + pathLen > ftBuf.length)
        throw new BfsError(`File table path truncated at entry ${i}`);
      const entryPath = ftBuf.toString('utf8', pos, pos + pathLen);
      pos += pathLen;
      const size = ftBuf.readBigUInt64LE(pos);
      pos += 8;
      const dataOffset = ftBuf.readBigUInt64LE(pos);
      pos += 8;
      const entryHash = ftBuf.subarray(pos, pos + 32).toString('hex');
      pos += 32;
      const mode = ftBuf.readUInt32LE(pos);
      pos += 4;
      const modifiedAt = ftBuf.readBigUInt64LE(pos);
      pos += 8;
      entries.push({
        path: entryPath,
        size,
        data_offset: dataOffset,
        hash: entryHash,
        mode,
        modified_at: modifiedAt,
      });
    }
    return entries;
  } finally {
    await fh.close();
  }
}

/**
 * Unpacks a BFS blob from a file path using random-access I/O.
 * Works for blobs of any size — does not load the full blob into memory.
 * Files are read in 4 MiB chunks; per-file and whole-blob checksums are verified.
 *
 * @param blobPath  - Path to the blob file on disk
 * @param targetDir - Directory to write extracted files into
 * @param filter    - Optional: unpack only entries where filter returns true
 * @returns `{ extracted, skipped }` — written entries and any that could not be written
 * @throws BfsError on data corruption (checksum / hash mismatch)
 */
export async function unpackBlobFromFile(
  blobPath: string,
  targetDir: string,
  filter?: (entry: FileEntry) => boolean,
): Promise<{ extracted: FileEntry[]; skipped: SkippedFile[] }> {
  const fileStat = await fs.stat(blobPath);
  if (fileStat.size < HEADER_SIZE + CHECKSUM_SIZE)
    throw new BfsError('Blob too short to be valid');

  const fh = await fs.open(blobPath, 'r');
  try {
    // ── 1. Read header (offsets, counts) ───────────────────────────────────
    const header = Buffer.alloc(HEADER_SIZE);
    await fh.read(header, 0, HEADER_SIZE, 0);

    const magic = `${header.toString('ascii', 0, 3)}\0`;
    if (magic !== 'BFS\0') {
      throw new BfsError(
        `Invalid blob magic: expected BFS\\0, got ${JSON.stringify(header.toString('ascii', 0, 4))}`,
      );
    }

    const fileCount = header.readUInt32LE(0x22);
    const fileTableOffset = Number(header.readBigUInt64LE(0x26));
    const fileTableLength = Number(header.readBigUInt64LE(0x2e));
    const dataSectionOffset = Number(header.readBigUInt64LE(0x36));

    // ── 2. Read file table ─────────────────────────────────────────────────
    const ftBuf = Buffer.alloc(fileTableLength);
    await fh.read(ftBuf, 0, fileTableLength, fileTableOffset);

    const entries: FileEntry[] = [];
    let pos = 0;
    for (let i = 0; i < fileCount; i++) {
      if (pos + 2 > ftBuf.length)
        throw new BfsError(`File table truncated at entry ${i}`);
      const pathLen = ftBuf.readUInt16LE(pos);
      pos += 2;
      if (pos + pathLen > ftBuf.length)
        throw new BfsError(`File table path truncated at entry ${i}`);
      const entryPath = ftBuf.toString('utf8', pos, pos + pathLen);
      pos += pathLen;
      const size = ftBuf.readBigUInt64LE(pos);
      pos += 8;
      const dataOffset = ftBuf.readBigUInt64LE(pos);
      pos += 8;
      const entryHash = ftBuf.subarray(pos, pos + 32).toString('hex');
      pos += 32;
      const mode = ftBuf.readUInt32LE(pos);
      pos += 4;
      const modifiedAt = ftBuf.readBigUInt64LE(pos);
      pos += 8;
      entries.push({
        path: entryPath,
        size,
        data_offset: dataOffset,
        hash: entryHash,
        mode,
        modified_at: modifiedAt,
      });
    }

    // ── 3. Verify trailing SHA-256 checksum (streaming, 4 MiB chunks) ──────
    const CHUNK = 4 * 1024 * 1024;
    const hashLen = fileStat.size - CHECKSUM_SIZE;
    const checksumHash = createHash('sha256');
    let readPos = 0;
    while (readPos < hashLen) {
      const toRead = Math.min(CHUNK, hashLen - readPos);
      // eslint-disable-next-line no-await-in-loop
      const chunk = Buffer.allocUnsafe(toRead);
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await fh.read(chunk, 0, toRead, readPos);
      checksumHash.update(chunk.subarray(0, bytesRead));
      readPos += bytesRead;
    }
    const computedChecksum = checksumHash.digest();
    const storedChecksum = Buffer.alloc(CHECKSUM_SIZE);
    await fh.read(
      storedChecksum,
      0,
      CHECKSUM_SIZE,
      fileStat.size - CHECKSUM_SIZE,
    );
    if (!computedChecksum.equals(storedChecksum)) {
      throw new BfsError(
        'Blob checksum mismatch — data is corrupted or tampered',
      );
    }

    // ── 4. Extract each file using random-access reads ─────────────────────
    const extracted: FileEntry[] = [];
    const skipped: SkippedFile[] = [];

    for (const entry of entries) {
      if (filter !== undefined && !filter(entry)) continue;

      const fileStart = dataSectionOffset + Number(entry.data_offset);
      const fileSize = Number(entry.size);
      const fileEnd = fileStart + fileSize;

      if (fileEnd > hashLen) {
        throw new BfsError(
          `Data section out of bounds for file: ${entry.path}`,
        );
      }

      const targetPath = path.join(targetDir, entry.path);
      try {
        await fs.mkdir(path.dirname(targetPath), { recursive: true });
        const wfh = await fs.open(targetPath, 'w');
        const fileHash = createHash('sha256');
        try {
          let fp = fileStart;
          while (fp < fileEnd) {
            const toRead = Math.min(CHUNK, fileEnd - fp);
            const chunk = Buffer.allocUnsafe(toRead);
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

        const computedFileHash = fileHash.digest('hex');
        if (computedFileHash !== entry.hash) {
          throw new BfsError(`File hash mismatch for: ${entry.path}`);
        }

        const mtimeSec = Number(entry.modified_at) / 1000;
        await fs.utimes(targetPath, mtimeSec, mtimeSec).catch(() => {});
        extracted.push(entry);
      } catch (e: unknown) {
        if (e instanceof BfsError) throw e; // data corruption — propagate
        skipped.push({
          path: entry.path,
          reason: e instanceof Error ? e.message : String(e),
        });
      }
    }

    return { extracted, skipped };
  } finally {
    await fh.close();
  }
}
