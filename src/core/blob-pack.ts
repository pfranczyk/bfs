import { createHash, type Hash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { BLOB_FLAGS, type FileEntry, type IgnoreFilter } from '../types/index.js';
import { createStreamingZipPacker, createZipPacker } from './compression.js';
import type { SkippedFile } from './errors.js';
import { BfsError } from './errors.js';
import { hashBuffer, hashStream, SHA256_BYTES } from './hash.js';

// BFS Blob header: 70 bytes
// 0x00  4  Magic: "BFS\0"
// 0x04  2  Format version: uint16 LE (1)
// 0x06  16 Vault UUID: 16 bytes binary
// 0x16  4  Flags: uint32 LE
// 0x1A  8  Created timestamp: uint64 LE (unix ms)
// 0x22  4  File count: uint32 LE
// 0x26  8  File table offset: uint64 LE
// 0x2E  8  File table length: uint64 LE
// 0x36  8  Data section offset: uint64 LE
// 0x3E  8  Data section length: uint64 LE
// 0x46  .. [FILE TABLE]
// ..    .. [DATA SECTION]
// EOF-32 32 SHA-256 checksum
const HEADER_SIZE = 70;

interface FileMeta {
  relativePath: string;
}

async function scanDir(rootDir: string, ignoreFilter: IgnoreFilter): Promise<FileMeta[]> {
  const results: FileMeta[] = [];

  async function recurse(dir: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (ignoreFilter(relPath)) continue;
      if (entry.isDirectory()) {
        await recurse(path.join(dir, entry.name), relPath);
      } else if (entry.isFile()) {
        results.push({ relativePath: relPath });
      }
    }
  }

  await recurse(rootDir, '');
  return results;
}

function buildFileTableEntry(entry: FileEntry, hashBytes: Buffer): Buffer {
  const pathBuf = Buffer.from(entry.path, 'utf8');
  const entrySize = 2 + pathBuf.length + 8 + 8 + SHA256_BYTES + 4 + 8;
  const buf = Buffer.alloc(entrySize);
  let pos = 0;

  buf.writeUInt16LE(pathBuf.length, pos);
  pos += 2;
  pathBuf.copy(buf, pos);
  pos += pathBuf.length;
  buf.writeBigUInt64LE(entry.size, pos);
  pos += 8;
  buf.writeBigUInt64LE(entry.data_offset, pos);
  pos += 8;
  hashBytes.copy(buf, pos);
  pos += SHA256_BYTES;
  buf.writeUInt32LE(entry.mode, pos);
  pos += 4;
  buf.writeBigUInt64LE(entry.modified_at, pos);
  pos += 8;

  if (pos !== entrySize) {
    throw new BfsError(`buildFileTableEntry offset mismatch: wrote ${pos} B, expected ${entrySize} B`);
  }

  return buf;
}

/**
 * Packs a directory into a BFS blob (custom binary format) held in RAM.
 * Files that cannot be read are skipped and listed in `skipped`.
 * When `compressed=true`, the data section is a ZIP file and file_count=1 (entry: "bfs.pack.zip").
 *
 * @param rootDir      - Directory to pack
 * @param ignoreFilter - Filter function (returns true = ignore the file)
 * @param vaultId      - Optional 16-byte vault UUID (defaults to zeros)
 * @param compressed   - When true, deflate-compress all files into a ZIP data section
 * @returns `{ blob, skipped }` — the packed buffer and any files that could not be read
 */
export async function packBlob(rootDir: string, ignoreFilter: IgnoreFilter, vaultId?: Buffer, compressed?: boolean): Promise<{ blob: Buffer; skipped: SkippedFile[] }> {
  // 1. Scan directory recursively
  const metas = await scanDir(rootDir, ignoreFilter);
  metas.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const skipped: SkippedFile[] = [];

  if (compressed) {
    return _packBlobCompressed(metas, rootDir, vaultId, skipped);
  }
  return _packBlobRaw(metas, rootDir, vaultId, skipped);
}

/** Raw (uncompressed) RAM path — multiple file table entries, surowe dane. */
async function _packBlobRaw(metas: FileMeta[], rootDir: string, vaultId: Buffer | undefined, skipped: SkippedFile[]): Promise<{ blob: Buffer; skipped: SkippedFile[] }> {
  const fileDataList: Buffer[] = [];
  const fileEntries: FileEntry[] = [];
  const hashBuffers: Buffer[] = [];
  let currentDataOffset = 0n;

  for (const meta of metas) {
    const absPath = path.join(rootDir, meta.relativePath);
    try {
      const [data, stat] = await Promise.all([fs.readFile(absPath), fs.stat(absPath)]);
      const hashHex = hashBuffer(data);
      fileEntries.push({ path: meta.relativePath, size: BigInt(data.length), data_offset: currentDataOffset, hash: hashHex, mode: stat.mode, modified_at: BigInt(Math.round(stat.mtimeMs)) });
      hashBuffers.push(Buffer.from(hashHex, 'hex'));
      fileDataList.push(data);
      currentDataOffset += BigInt(data.length);
    } catch (e: unknown) {
      skipped.push({ path: meta.relativePath, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const fileTableParts = fileEntries.map((fe, i) => {
    const hashBuf = hashBuffers[i];
    if (hashBuf === undefined) throw new BfsError(`Missing hash buffer at index ${i}`);
    return buildFileTableEntry(fe, hashBuf);
  });
  const fileTable = fileTableParts.length > 0 ? Buffer.concat(fileTableParts) : Buffer.alloc(0);
  const dataSection = fileDataList.length > 0 ? Buffer.concat(fileDataList) : Buffer.alloc(0);
  const blob = _assembleBlobBuffer(fileEntries.length, 0, fileTable, dataSection, vaultId);
  return { blob, skipped };
}

/** Compressed RAM path — builds ZIP, single file table entry "bfs.pack.zip". */
async function _packBlobCompressed(metas: FileMeta[], rootDir: string, vaultId: Buffer | undefined, skipped: SkippedFile[]): Promise<{ blob: Buffer; skipped: SkippedFile[] }> {
  const packer = createZipPacker();

  for (const meta of metas) {
    const absPath = path.join(rootDir, meta.relativePath);
    try {
      const data = await fs.readFile(absPath);
      packer.addFile(meta.relativePath, data);
    } catch (e: unknown) {
      skipped.push({ path: meta.relativePath, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  const zipBuffer = packer.finalize();
  const zipHashHex = hashBuffer(zipBuffer);
  const zipEntry: FileEntry = { path: 'bfs.pack.zip', size: BigInt(zipBuffer.length), data_offset: 0n, hash: zipHashHex, mode: 0, modified_at: BigInt(Date.now()) };
  const fileTable = buildFileTableEntry(zipEntry, Buffer.from(zipHashHex, 'hex'));
  const blob = _assembleBlobBuffer(1, BLOB_FLAGS.COMPRESSED, fileTable, zipBuffer, vaultId);
  return { blob, skipped };
}

/**
 * Assembles a complete BFS blob: header + fileTable + dataSection + trailing SHA-256.
 * Mutation note: header Buffer is built inline for performance — no external state.
 */
function _assembleBlobBuffer(fileCount: number, flags: number, fileTable: Buffer, dataSection: Buffer, vaultId?: Buffer): Buffer {
  const fileTableOffset = BigInt(HEADER_SIZE);
  const dataSectionOffset = fileTableOffset + BigInt(fileTable.length);
  const header = Buffer.alloc(HEADER_SIZE);
  let pos = 0;
  header.write('BFS', pos, 'ascii');
  pos += 3;
  header.writeUInt8(0, pos);
  pos += 1;
  header.writeUInt16LE(1, pos);
  pos += 2;
  (vaultId ?? Buffer.alloc(16)).copy(header, pos);
  pos += 16;
  header.writeUInt32LE(flags, pos);
  pos += 4;
  header.writeBigUInt64LE(BigInt(Date.now()), pos);
  pos += 8;
  header.writeUInt32LE(fileCount, pos);
  pos += 4;
  header.writeBigUInt64LE(fileTableOffset, pos);
  pos += 8;
  header.writeBigUInt64LE(BigInt(fileTable.length), pos);
  pos += 8;
  header.writeBigUInt64LE(dataSectionOffset, pos);
  pos += 8;
  header.writeBigUInt64LE(BigInt(dataSection.length), pos);
  pos += 8;
  if (pos !== HEADER_SIZE) {
    throw new BfsError(`_assembleBlobBuffer header offset mismatch: wrote ${pos} B, expected ${HEADER_SIZE} B`);
  }
  const blobBody = Buffer.concat([header, fileTable, dataSection]);
  const checksum = Buffer.from(hashBuffer(blobBody), 'hex');
  return Buffer.concat([blobBody, checksum]);
}

/**
 * Estimates the total byte size of a BFS blob for the given directory.
 * Scans recursively and stats each file — does NOT read file contents.
 * Used to decide between RAM path (packBlob) and disk path (packBlobToFile).
 * @returns Estimated blob size in bytes (exact: based on paths + stat sizes)
 */
export async function estimateBlobSize(rootDir: string, ignoreFilter: IgnoreFilter): Promise<number> {
  const metas = await scanDir(rootDir, ignoreFilter);
  let total = HEADER_SIZE + SHA256_BYTES; // header + trailing SHA-256 checksum
  for (const meta of metas) {
    const absPath = path.join(rootDir, meta.relativePath);
    try {
      const stat = await fs.stat(absPath);
      const pathLen = Buffer.byteLength(meta.relativePath, 'utf8');
      // File table entry: 2 (path_len) + path bytes + 8 (size) + 8 (offset) + 32 (hash) + 4 (mode) + 8 (mtime)
      total += 2 + pathLen + 60;
      total += stat.size;
    } catch {
      // Unreadable files are skipped — they won't appear in the blob
    }
  }
  return total;
}

/**
 * Packs a directory into a BFS blob written directly to a file on disk.
 * Unlike packBlob(), the blob is never fully loaded into RAM: files are read twice
 * (hash pass, then write pass), one chunk at a time.
 * Peak RAM: approximately one read-chunk per file (4 MiB).
 * @param rootDir      - Directory to pack
 * @param outputPath   - Destination file (e.g. .bfs/cache/push.blob.pending)
 * @param ignoreFilter - Filter: returns true = ignore path
 * @param vaultId      - Optional 16-byte vault UUID (defaults to zeros)
 * @returns blobSize in bytes, fileCount of included files, and any skipped entries
 */
export async function packBlobToFile(rootDir: string, outputPath: string, ignoreFilter: IgnoreFilter, vaultId?: Buffer): Promise<{ blobSize: number; fileCount: number; totalSize: number; skipped: SkippedFile[] }> {
  // ── Pass 1: scan + stat + compute per-file SHA-256 hashes ──────────────
  const metas = await scanDir(rootDir, ignoreFilter);
  metas.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const skipped: SkippedFile[] = [];
  const entries: Array<{ relativePath: string; size: bigint; mode: number; modifiedAt: bigint; hashHex: string }> = [];

  for (const meta of metas) {
    const absPath = path.join(rootDir, meta.relativePath);
    try {
      const [stat, hashHex] = await Promise.all([fs.stat(absPath), _hashFileByStream(absPath)]);
      entries.push({ relativePath: meta.relativePath, size: BigInt(stat.size), mode: stat.mode, modifiedAt: BigInt(Math.round(stat.mtimeMs)), hashHex });
    } catch (e: unknown) {
      skipped.push({ path: meta.relativePath, reason: e instanceof Error ? e.message : String(e) });
    }
  }

  // ── Build file table (all metadata now available) ──────────────────────
  const fileTableParts: Buffer[] = [];
  let currentDataOffset = 0n;
  for (const entry of entries) {
    const hashBytes = Buffer.from(entry.hashHex, 'hex');
    const fe: FileEntry = { path: entry.relativePath, size: entry.size, data_offset: currentDataOffset, hash: entry.hashHex, mode: entry.mode, modified_at: entry.modifiedAt };
    fileTableParts.push(buildFileTableEntry(fe, hashBytes));
    currentDataOffset += entry.size;
  }
  const fileTable = fileTableParts.length > 0 ? Buffer.concat(fileTableParts) : Buffer.alloc(0);

  const fileTableOffset = BigInt(HEADER_SIZE);
  const dataSectionOffset = fileTableOffset + BigInt(fileTable.length);
  const dataSectionLength = currentDataOffset;

  // ── Build header ───────────────────────────────────────────────────────
  const header = Buffer.alloc(HEADER_SIZE);
  let pos = 0;
  header.write('BFS', pos, 'ascii');
  pos += 3;
  header.writeUInt8(0, pos);
  pos += 1;
  header.writeUInt16LE(1, pos);
  pos += 2;
  const vaultIdBuf = vaultId ?? Buffer.alloc(16);
  vaultIdBuf.copy(header, pos);
  pos += 16;
  header.writeUInt32LE(0, pos);
  pos += 4;
  header.writeBigUInt64LE(BigInt(Date.now()), pos);
  pos += 8;
  header.writeUInt32LE(entries.length, pos);
  pos += 4;
  header.writeBigUInt64LE(fileTableOffset, pos);
  pos += 8;
  header.writeBigUInt64LE(BigInt(fileTable.length), pos);
  pos += 8;
  header.writeBigUInt64LE(dataSectionOffset, pos);
  pos += 8;
  header.writeBigUInt64LE(dataSectionLength, pos);
  pos += 8;
  if (pos !== HEADER_SIZE) {
    throw new BfsError(`packBlobToFile header offset mismatch: wrote ${pos} B, expected ${HEADER_SIZE} B`);
  }

  // ── Pass 2: write header + file table + data section + checksum ────────
  const hasher = createHash('sha256');
  const outputHandle = await fs.open(outputPath, 'w');
  try {
    await _writeAndHash(outputHandle, hasher, header);
    await _writeAndHash(outputHandle, hasher, fileTable);
    for (const entry of entries) {
      const absPath = path.join(rootDir, entry.relativePath);
      await _streamFileToHandle(absPath, outputHandle, hasher);
    }
    const checksum = hasher.digest();
    await outputHandle.write(checksum);
  } finally {
    await outputHandle.close();
  }

  const blobSize = HEADER_SIZE + fileTable.length + Number(dataSectionLength) + SHA256_BYTES;
  return { blobSize, fileCount: entries.length, totalSize: Number(dataSectionLength), skipped };
}

/**
 * Packs a directory into a compressed BFS blob written to disk.
 * All files are deflated into a single ZIP (data section). File table has one entry: "bfs.pack.zip".
 * BLOB_FLAGS.COMPRESSED bit is set in the header.
 * Uses streaming ZIP packer: each file is compressed and written directly to disk.
 * Peak RAM: O(single file size) instead of O(total compressed data).
 *
 * @param rootDir      - Directory to pack
 * @param outputPath   - Destination file (e.g. .bfs/cache/push.blob.pending)
 * @param ignoreFilter - Filter: returns true = ignore path
 * @param vaultId      - Optional 16-byte vault UUID (defaults to zeros)
 * @returns blobSize, fileCount (actual directory files), totalSize (uncompressed sum), skipped
 */
export async function packBlobToFileZipped(rootDir: string, outputPath: string, ignoreFilter: IgnoreFilter, vaultId?: Buffer): Promise<{ blobSize: number; fileCount: number; totalSize: number; skipped: SkippedFile[] }> {
  const metas = await scanDir(rootDir, ignoreFilter);
  metas.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  const skipped: SkippedFile[] = [];
  let totalSize = 0;
  let fileCount = 0;

  // File table for compressed blobs always has 1 entry ("bfs.pack.zip").
  // Entry size: 2 (path_len) + 12 ("bfs.pack.zip") + 8 (size) + 8 (offset) + 32 (hash) + 4 (mode) + 8 (mtime) = 74
  const FILE_TABLE_ENTRY_SIZE = 74;
  const dataStartOffset = HEADER_SIZE + FILE_TABLE_ENTRY_SIZE;

  const outputHandle = await fs.open(outputPath, 'w');
  try {
    // Write placeholder for header + file table (overwritten after ZIP is complete)
    await outputHandle.write(Buffer.alloc(dataStartOffset));

    // Stream ZIP data directly to disk starting at dataStartOffset
    const packer = createStreamingZipPacker(outputHandle);
    for (const meta of metas) {
      const absPath = path.join(rootDir, meta.relativePath);
      try {
        const data = await fs.readFile(absPath);
        await packer.addFile(meta.relativePath, data);
        totalSize += data.length;
        fileCount++;
      } catch (e: unknown) {
        skipped.push({ path: meta.relativePath, reason: e instanceof Error ? e.message : String(e) });
      }
    }

    const { totalSize: zipSize, hash: zipHashHex } = await packer.finalize();

    // Build file table entry for "bfs.pack.zip"
    const zipEntry: FileEntry = { path: 'bfs.pack.zip', size: BigInt(zipSize), data_offset: 0n, hash: zipHashHex, mode: 0, modified_at: BigInt(Date.now()) };
    const fileTable = buildFileTableEntry(zipEntry, Buffer.from(zipHashHex, 'hex'));

    // Build BFS header with known data_section_length
    const fileTableOffset = BigInt(HEADER_SIZE);
    const dataSectionOffset = fileTableOffset + BigInt(fileTable.length);
    const header = Buffer.alloc(HEADER_SIZE);
    let pos = 0;
    header.write('BFS', pos, 'ascii');
    pos += 3;
    header.writeUInt8(0, pos);
    pos += 1;
    header.writeUInt16LE(1, pos);
    pos += 2;
    (vaultId ?? Buffer.alloc(16)).copy(header, pos);
    pos += 16;
    header.writeUInt32LE(BLOB_FLAGS.COMPRESSED, pos);
    pos += 4;
    header.writeBigUInt64LE(BigInt(Date.now()), pos);
    pos += 8;
    header.writeUInt32LE(1, pos);
    pos += 4;
    header.writeBigUInt64LE(fileTableOffset, pos);
    pos += 8;
    header.writeBigUInt64LE(BigInt(fileTable.length), pos);
    pos += 8;
    header.writeBigUInt64LE(dataSectionOffset, pos);
    pos += 8;
    header.writeBigUInt64LE(BigInt(zipSize), pos);
    pos += 8;
    if (pos !== HEADER_SIZE) {
      throw new BfsError(`packBlobToFileZipped header offset mismatch: wrote ${pos} B, expected ${HEADER_SIZE} B`);
    }

    // Seek to start, overwrite placeholder with real header + file table
    await outputHandle.write(header, 0, header.length, 0);
    await outputHandle.write(fileTable, 0, fileTable.length, HEADER_SIZE);

    // Compute blob checksum: re-read entire file (header + file table + ZIP data)
    const blobSize = dataStartOffset + zipSize + SHA256_BYTES;
    const blobHasher = createHash('sha256');
    const readHandle = await fs.open(outputPath, 'r');
    try {
      for await (const chunk of readHandle.createReadStream({ start: 0, end: dataStartOffset + zipSize - 1 })) {
        blobHasher.update(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
      }
    } finally {
      await readHandle.close();
    }
    const checksum = blobHasher.digest();
    await outputHandle.write(checksum);

    return { blobSize, fileCount, totalSize, skipped };
  } finally {
    await outputHandle.close();
  }
}

// ─── Private helpers for packBlobToFile ───────────────────────────────────

/** Hashes a file by streaming it through SHA-256 without loading it fully into RAM. */
async function _hashFileByStream(absPath: string): Promise<string> {
  const handle = await fs.open(absPath, 'r');
  try {
    return await hashStream(handle.createReadStream());
  } finally {
    await handle.close();
  }
}

/** Writes a buffer to a file handle and updates the running SHA-256 hasher. */
async function _writeAndHash(handle: FileHandle, hasher: Hash, data: Buffer): Promise<void> {
  await handle.write(data);
  hasher.update(data);
}

/** Streams a source file to an output handle while updating the running hasher. */
async function _streamFileToHandle(absPath: string, outHandle: FileHandle, hasher: Hash): Promise<void> {
  const inHandle = await fs.open(absPath, 'r');
  try {
    for await (const chunk of inHandle.createReadStream()) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      await _writeAndHash(outHandle, hasher, buf);
    }
  } finally {
    await inHandle.close();
  }
}
