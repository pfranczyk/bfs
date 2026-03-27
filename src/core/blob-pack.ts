import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { FileEntry, IgnoreFilter } from '../types/index.js';
import type { SkippedFile } from './errors.js';
import { hashBuffer } from './hash.js';

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

async function scanDir(
  rootDir: string,
  ignoreFilter: IgnoreFilter,
): Promise<FileMeta[]> {
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
  const buf = Buffer.allocUnsafe(2 + pathBuf.length + 8 + 8 + 32 + 4 + 8);
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
  pos += 32;
  buf.writeUInt32LE(entry.mode, pos);
  pos += 4;
  buf.writeBigUInt64LE(entry.modified_at, pos);
  pos += 8;

  return buf;
}

/**
 * Packs a directory into a BFS blob (custom binary format).
 * Files that cannot be read (e.g. permission denied) are skipped and listed in the
 * returned `skipped` array instead of aborting the entire operation.
 *
 * @param rootDir      - Directory to pack
 * @param ignoreFilter - Filter function (returns true = ignore the file)
 * @param vaultId      - Optional 16-byte vault UUID to embed in blob header (defaults to zeros)
 * @returns            - `{ blob, skipped }` — the packed buffer and any files that could not be read
 */
export async function packBlob(
  rootDir: string,
  ignoreFilter: IgnoreFilter,
  vaultId?: Buffer,
): Promise<{ blob: Buffer; skipped: SkippedFile[] }> {
  // 1. Scan directory recursively
  const metas = await scanDir(rootDir, ignoreFilter);

  // 2. Sort by relative path (deterministic output)
  metas.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

  // 3. Read file data, compute hashes, build entries
  const fileDataList: Buffer[] = [];
  const fileEntries: FileEntry[] = [];
  const hashBuffers: Buffer[] = [];
  const skipped: SkippedFile[] = [];
  let currentDataOffset = 0n;

  for (const meta of metas) {
    const absPath = path.join(rootDir, meta.relativePath);
    try {
      const [data, stat] = await Promise.all([
        fs.readFile(absPath),
        fs.stat(absPath),
      ]);
      const hashHex = hashBuffer(data);
      const hashBytes = Buffer.from(hashHex, 'hex');

      fileEntries.push({
        path: meta.relativePath,
        size: BigInt(data.length),
        data_offset: currentDataOffset,
        hash: hashHex,
        mode: stat.mode,
        modified_at: BigInt(Math.round(stat.mtimeMs)),
      });
      hashBuffers.push(hashBytes);
      fileDataList.push(data);
      currentDataOffset += BigInt(data.length);
    } catch (e: unknown) {
      skipped.push({
        path: meta.relativePath,
        reason: e instanceof Error ? e.message : String(e),
      });
    }
  }

  // 4. Build file table
  const fileTableParts: Buffer[] = [];
  for (let i = 0; i < fileEntries.length; i++) {
    fileTableParts.push(buildFileTableEntry(fileEntries[i], hashBuffers[i]));
  }
  const fileTable =
    fileTableParts.length > 0 ? Buffer.concat(fileTableParts) : Buffer.alloc(0);

  // 5. Build data section
  const dataSection =
    fileDataList.length > 0 ? Buffer.concat(fileDataList) : Buffer.alloc(0);

  // 6. Calculate offsets
  const fileTableOffset = BigInt(HEADER_SIZE);
  const dataSectionOffset = fileTableOffset + BigInt(fileTable.length);

  // 7. Build header
  const header = Buffer.alloc(HEADER_SIZE);
  let pos = 0;

  // Magic: "BFS\0"
  header.write('BFS', pos, 'ascii');
  pos += 3;
  header.writeUInt8(0, pos);
  pos += 1;
  // Format version: 1
  header.writeUInt16LE(1, pos);
  pos += 2;
  // Vault UUID: 16 bytes
  const vaultIdBuf = vaultId ?? Buffer.alloc(16);
  vaultIdBuf.copy(header, pos);
  pos += 16;
  // Flags: 0
  header.writeUInt32LE(0, pos);
  pos += 4;
  // Created timestamp (unix ms)
  header.writeBigUInt64LE(BigInt(Date.now()), pos);
  pos += 8;
  // File count
  header.writeUInt32LE(fileEntries.length, pos);
  pos += 4;
  // File table offset
  header.writeBigUInt64LE(fileTableOffset, pos);
  pos += 8;
  // File table length
  header.writeBigUInt64LE(BigInt(fileTable.length), pos);
  pos += 8;
  // Data section offset
  header.writeBigUInt64LE(dataSectionOffset, pos);
  pos += 8;
  // Data section length
  header.writeBigUInt64LE(BigInt(dataSection.length), pos);
  pos += 8;

  // 8. Assemble blob without checksum
  const blobBody = Buffer.concat([header, fileTable, dataSection]);

  // 9. Append SHA-256 checksum (32 bytes)
  const checksum = Buffer.from(hashBuffer(blobBody), 'hex');
  return { blob: Buffer.concat([blobBody, checksum]), skipped };
}
