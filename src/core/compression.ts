import { constants as BUFFER_CONSTANTS } from 'node:buffer';
import { createHash } from 'node:crypto';
import fs, { type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';

import { BfsError } from './errors.js';

// ─── ZIP format constants ──────────────────────────────────────────────────────

const SIG_LFH = 0x04034b50; // Local File Header signature
const SIG_DD = 0x08074b50; // Data Descriptor signature
const SIG_CDE = 0x02014b50; // Central Directory Entry signature
const SIG_EOCD = 0x06054b50; // End of Central Directory signature
const SIG_ZIP64_EOCD = 0x06064b50; // ZIP64 End of Central Directory Record
const SIG_ZIP64_LOCATOR = 0x07064b50; // ZIP64 End of Central Directory Locator
const METHOD_DEFLATE = 0x0008;
const FLAGS_DD_UTF8 = 0x0808; // bit3=data descriptor, bit11=UTF-8
const VERSION_NEEDED_ZIP64 = 0x002d; // ZIP 4.5 (required for ZIP64)
const VERSION_MADE_ZIP64 = 0x032d; // Unix, ZIP 4.5
const ZIP64_EXTRA_ID = 0x0001;
const MARKER_32 = 0xffffffff;
const MARKER_16 = 0xffff;
// Unix -rw-r--r-- (0o100644 << 16, forced unsigned via >>> 0 to avoid signed-int overflow)
const EXT_ATTR_UNIX = (0o100644 << 16) >>> 0;

// ─── Decompression bomb guard ──────────────────────────────────────────────────

/**
 * Maximum expansion ratio a single raw-DEFLATE stream can physically achieve.
 * Real deflate output never exceeds compressedBytes * MAX_DEFLATE_RATIO, so the
 * total decompressed size of a ZIP is bounded by zipSize * MAX_DEFLATE_RATIO —
 * a trusted ceiling, since the ZIP size is validated against the real blob size
 * upstream and cannot be inflated by an attacker.
 */
const MAX_DEFLATE_RATIO = 1032;

/**
 * Fraction of total machine RAM allowed as the absolute decompression ceiling.
 * Half leaves headroom for the compressed buffer and the in-RAM result set that
 * the rest of the unpack path holds alongside the decompressed output.
 */
const INFLATE_RAM_FRACTION = 0.5;

// ─── Public interfaces ────────────────────────────────────────────────────────

/** Entry returned by extractZip() for each file in the archive. */
export interface ZipExtractResult {
  filename: string;
  data: Buffer;
}

/** Options for extractZip(). */
export interface ExtractZipOptions {
  /**
   * Explicit cap (in bytes) on the total decompressed output across all entries.
   * Overrides the default cap derived from the ZIP size and machine RAM.
   */
  maxTotalOutput?: number;
}

// ─── Internal types ───────────────────────────────────────────────────────────

interface CdEntry {
  filename: Buffer;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
  dosTime: number;
  dosDate: number;
}

// ─── DOS time conversion ──────────────────────────────────────────────────────

function _toDosDateTime(): { dosTime: number; dosDate: number } {
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { dosTime, dosDate };
}

// ─── ZIP64 extra fields ──────────────────────────────────────────────────────

function _buildZip64ExtraLfh(compressedSize: number, uncompressedSize: number): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  buf.writeUInt16LE(16, 2); // data size: 8 + 8
  buf.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  buf.writeBigUInt64LE(BigInt(compressedSize), 12);
  return buf;
}

function _buildZip64ExtraCde(compressedSize: number, uncompressedSize: number, localHeaderOffset: number): Buffer {
  const buf = Buffer.alloc(28);
  buf.writeUInt16LE(ZIP64_EXTRA_ID, 0);
  buf.writeUInt16LE(24, 2); // data size: 8 + 8 + 8
  buf.writeBigUInt64LE(BigInt(uncompressedSize), 4);
  buf.writeBigUInt64LE(BigInt(compressedSize), 12);
  buf.writeBigUInt64LE(BigInt(localHeaderOffset), 20);
  return buf;
}

function _buildZip64Eocd(entryCount: number, cdSize: number, cdOffset: number): Buffer {
  const buf = Buffer.alloc(56);
  let pos = 0;
  buf.writeUInt32LE(SIG_ZIP64_EOCD, pos);
  pos += 4;
  buf.writeBigUInt64LE(44n, pos);
  pos += 8; // size of remaining record
  buf.writeUInt16LE(VERSION_MADE_ZIP64, pos);
  pos += 2;
  buf.writeUInt16LE(VERSION_NEEDED_ZIP64, pos);
  pos += 2;
  buf.writeUInt32LE(0, pos);
  pos += 4; // disk number
  buf.writeUInt32LE(0, pos);
  pos += 4; // CD start disk
  buf.writeBigUInt64LE(BigInt(entryCount), pos);
  pos += 8;
  buf.writeBigUInt64LE(BigInt(entryCount), pos);
  pos += 8;
  buf.writeBigUInt64LE(BigInt(cdSize), pos);
  pos += 8;
  buf.writeBigUInt64LE(BigInt(cdOffset), pos);
  pos += 8;
  return buf;
}

function _buildZip64EocdLocator(zip64EocdOffset: number): Buffer {
  const buf = Buffer.alloc(20);
  buf.writeUInt32LE(SIG_ZIP64_LOCATOR, 0);
  buf.writeUInt32LE(0, 4); // disk with ZIP64 EOCD
  buf.writeBigUInt64LE(BigInt(zip64EocdOffset), 8);
  buf.writeUInt32LE(1, 16); // total disks
  return buf;
}

function _buildEocdZip64Marker(): Buffer {
  const buf = Buffer.alloc(22);
  buf.writeUInt32LE(SIG_EOCD, 0);
  buf.writeUInt16LE(0, 4); // disk number
  buf.writeUInt16LE(0, 6); // cd start disk
  buf.writeUInt16LE(MARKER_16, 8);
  buf.writeUInt16LE(MARKER_16, 10);
  buf.writeUInt32LE(MARKER_32, 12);
  buf.writeUInt32LE(MARKER_32, 16);
  buf.writeUInt16LE(0, 20); // comment length
  return buf;
}

// ─── ZIP building blocks (always ZIP64) ───────────────────────────────────────

function _buildLfh(filenameBuf: Buffer, crc32: number, compressedSize: number, uncompressedSize: number, dosTime: number, dosDate: number): Buffer {
  const extra = _buildZip64ExtraLfh(compressedSize, uncompressedSize);
  const buf = Buffer.alloc(30 + filenameBuf.length + extra.length);
  let pos = 0;
  buf.writeUInt32LE(SIG_LFH, pos);
  pos += 4;
  buf.writeUInt16LE(VERSION_NEEDED_ZIP64, pos);
  pos += 2;
  buf.writeUInt16LE(FLAGS_DD_UTF8, pos);
  pos += 2;
  buf.writeUInt16LE(METHOD_DEFLATE, pos);
  pos += 2;
  buf.writeUInt16LE(dosTime, pos);
  pos += 2;
  buf.writeUInt16LE(dosDate, pos);
  pos += 2;
  buf.writeUInt32LE(crc32, pos);
  pos += 4;
  buf.writeUInt32LE(MARKER_32, pos);
  pos += 4; // ZIP64: marker
  buf.writeUInt32LE(MARKER_32, pos);
  pos += 4; // ZIP64: marker
  buf.writeUInt16LE(filenameBuf.length, pos);
  pos += 2;
  buf.writeUInt16LE(extra.length, pos);
  pos += 2;
  filenameBuf.copy(buf, pos);
  pos += filenameBuf.length;
  extra.copy(buf, pos);
  return buf;
}

function _buildDataDescriptor(crc32: number, compressedSize: number, uncompressedSize: number): Buffer {
  const buf = Buffer.alloc(24); // ZIP64: 4+4+8+8 = 24 (was 16)
  buf.writeUInt32LE(SIG_DD, 0);
  buf.writeUInt32LE(crc32, 4);
  buf.writeBigUInt64LE(BigInt(compressedSize), 8);
  buf.writeBigUInt64LE(BigInt(uncompressedSize), 16);
  return buf;
}

function _buildCde(entry: CdEntry): Buffer {
  const extra = _buildZip64ExtraCde(entry.compressedSize, entry.uncompressedSize, entry.localHeaderOffset);
  const buf = Buffer.alloc(46 + entry.filename.length + extra.length);
  let pos = 0;
  buf.writeUInt32LE(SIG_CDE, pos);
  pos += 4;
  buf.writeUInt16LE(VERSION_MADE_ZIP64, pos);
  pos += 2;
  buf.writeUInt16LE(VERSION_NEEDED_ZIP64, pos);
  pos += 2;
  buf.writeUInt16LE(FLAGS_DD_UTF8, pos);
  pos += 2;
  buf.writeUInt16LE(METHOD_DEFLATE, pos);
  pos += 2;
  buf.writeUInt16LE(entry.dosTime, pos);
  pos += 2;
  buf.writeUInt16LE(entry.dosDate, pos);
  pos += 2;
  buf.writeUInt32LE(entry.crc32, pos);
  pos += 4;
  buf.writeUInt32LE(MARKER_32, pos);
  pos += 4; // ZIP64: marker
  buf.writeUInt32LE(MARKER_32, pos);
  pos += 4; // ZIP64: marker
  buf.writeUInt16LE(entry.filename.length, pos);
  pos += 2;
  buf.writeUInt16LE(extra.length, pos);
  pos += 2; // extra field length
  buf.writeUInt16LE(0, pos);
  pos += 2; // comment length
  buf.writeUInt16LE(0, pos);
  pos += 2; // disk number start
  buf.writeUInt16LE(0, pos);
  pos += 2; // internal attrs
  buf.writeUInt32LE(EXT_ATTR_UNIX, pos);
  pos += 4;
  buf.writeUInt32LE(MARKER_32, pos);
  pos += 4; // ZIP64: marker for offset
  entry.filename.copy(buf, pos);
  pos += entry.filename.length;
  extra.copy(buf, pos);
  return buf;
}

// ─── ZIP packer ───────────────────────────────────────────────────────────────

interface ZipPackerInternal {
  addFile(filename: string, data: Buffer): void;
  finalize(): Buffer;
}

/**
 * Creates a synchronous ZIP packer using deflate compression.
 * Writes compressed_size into both the Local File Header and Data Descriptor,
 * so extractZip() can read sizes directly from the LFH without scanning for signatures.
 * @returns Object with addFile() and finalize() methods
 */
export function createZipPacker(): ZipPackerInternal {
  const parts: Buffer[] = [];
  const cdEntries: CdEntry[] = [];
  let currentOffset = 0;

  function addFile(filename: string, data: Buffer): void {
    const filenameBuf = Buffer.from(filename, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc32 = zlib.crc32(data);
    const { dosTime, dosDate } = _toDosDateTime();

    const lfh = _buildLfh(filenameBuf, crc32, compressed.length, data.length, dosTime, dosDate);
    const dd = _buildDataDescriptor(crc32, compressed.length, data.length);

    cdEntries.push({ filename: filenameBuf, crc32, compressedSize: compressed.length, uncompressedSize: data.length, localHeaderOffset: currentOffset, dosTime, dosDate });

    parts.push(lfh, compressed, dd);
    currentOffset += lfh.length + compressed.length + dd.length;
  }

  function finalize(): Buffer {
    const cdOffset = currentOffset;
    const cdParts = cdEntries.map(_buildCde);
    const cdSize = cdParts.reduce((s, b) => s + b.length, 0);
    const zip64EocdOffset = cdOffset + cdSize;
    const zip64Eocd = _buildZip64Eocd(cdEntries.length, cdSize, cdOffset);
    const zip64Locator = _buildZip64EocdLocator(zip64EocdOffset);
    const eocd = _buildEocdZip64Marker();
    return Buffer.concat([...parts, ...cdParts, zip64Eocd, zip64Locator, eocd]);
  }

  return { addFile, finalize };
}

// ─── Streaming ZIP packer (writes directly to disk) ─────────────────────────

/** Streaming ZIP packer — writes ZIP entries directly to a FileHandle. */
export interface StreamingZipPacker {
  /** Compresses data and writes LFH + compressed data + DD to the file handle. */
  addFile(filename: string, data: Buffer): Promise<void>;
  /** Writes Central Directory + ZIP64 EOCD. Returns total bytes written and SHA-256 hash. */
  finalize(): Promise<{ totalSize: number; hash: string }>;
}

/**
 * Creates a streaming ZIP packer that writes directly to disk via a FileHandle.
 * Each addFile() writes LFH + compressed data + DD immediately.
 * Peak RAM: O(single file size) instead of O(total archive size).
 * The hash is computed incrementally (SHA-256 of all bytes written).
 *
 * @param handle - Open FileHandle positioned where ZIP data should start
 * @returns StreamingZipPacker with addFile() and finalize()
 */
export function createStreamingZipPacker(handle: FileHandle): StreamingZipPacker {
  const cdEntries: CdEntry[] = [];
  const hasher = createHash('sha256');
  let currentOffset = 0;

  async function _writeAndHash(buf: Buffer): Promise<void> {
    await handle.write(buf);
    hasher.update(buf);
    currentOffset += buf.length;
  }

  async function addFile(filename: string, data: Buffer): Promise<void> {
    const filenameBuf = Buffer.from(filename, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc32 = zlib.crc32(data);
    const { dosTime, dosDate } = _toDosDateTime();

    const lfh = _buildLfh(filenameBuf, crc32, compressed.length, data.length, dosTime, dosDate);
    const dd = _buildDataDescriptor(crc32, compressed.length, data.length);

    cdEntries.push({ filename: filenameBuf, crc32, compressedSize: compressed.length, uncompressedSize: data.length, localHeaderOffset: currentOffset, dosTime, dosDate });

    await _writeAndHash(lfh);
    await _writeAndHash(compressed);
    await _writeAndHash(dd);
  }

  async function finalize(): Promise<{ totalSize: number; hash: string }> {
    const cdOffset = currentOffset;
    for (const entry of cdEntries) {
      await _writeAndHash(_buildCde(entry));
    }
    const cdSize = currentOffset - cdOffset;
    const zip64EocdOffset = currentOffset;
    await _writeAndHash(_buildZip64Eocd(cdEntries.length, cdSize, cdOffset));
    await _writeAndHash(_buildZip64EocdLocator(zip64EocdOffset));
    await _writeAndHash(_buildEocdZip64Marker());

    return { totalSize: currentOffset, hash: hasher.digest('hex') };
  }

  return { addFile, finalize };
}

// ─── ZIP64 extra field parser ────────────────────────────────────────────────

/** Parses ZIP64 extra field from LFH extra area to get real sizes. */
function _parseZip64ExtraLfh(extraBuf: Buffer): { compressedSize: number; uncompressedSize: number } {
  let offset = 0;
  while (offset + 4 <= extraBuf.length) {
    const headerId = extraBuf.readUInt16LE(offset);
    const dataSize = extraBuf.readUInt16LE(offset + 2);
    if (headerId === ZIP64_EXTRA_ID) {
      if (offset + 4 + 16 > extraBuf.length) {
        throw new BfsError('ZIP: truncated ZIP64 extra field in LFH');
      }
      const uncompressedSize = Number(extraBuf.readBigUInt64LE(offset + 4));
      const compressedSize = Number(extraBuf.readBigUInt64LE(offset + 12));
      return { compressedSize, uncompressedSize };
    }
    offset += 4 + dataSize;
  }
  throw new BfsError('ZIP: ZIP64 extra field (0x0001) not found but size marker is 0xFFFFFFFF');
}

/**
 * Computes the trusted upper bound on total decompressed output for a ZIP buffer.
 * Combines the physical deflate-ratio bound (from the ZIP size, validated against
 * the real blob size upstream) with an absolute RAM ceiling, so a crafted archive
 * cannot expand into an out-of-memory condition. An explicit override takes
 * precedence.
 * @param zipSize - Size of the ZIP buffer in bytes (equals the blob data section length)
 * @param override - Optional explicit cap in bytes
 * @returns Maximum allowed sum of decompressed bytes across all entries
 */
function _computeInflateCap(zipSize: number, override?: number): number {
  if (override !== undefined) return override;
  return Math.min(zipSize * MAX_DEFLATE_RATIO, Math.floor(os.totalmem() * INFLATE_RAM_FRACTION));
}

// ─── ZIP extractor (dual-mode: legacy + ZIP64) ──────────────────────────────

/**
 * Extracts all files from a ZIP buffer using sequential Local File Header scan.
 * Supports both legacy ZIP (UInt32 sizes) and ZIP64 (marker + extra field).
 * Verifies CRC-32 for each entry and caps the total decompressed output to guard
 * against decompression bombs (see _computeInflateCap).
 * @param zipBuffer - Full ZIP file as Buffer
 * @param options - Optional extraction options (e.g. an explicit output cap)
 * @returns Array of extracted entries with filename and decompressed data
 * @throws BfsError on corrupt ZIP (bad signature, CRC mismatch, inflate error) or
 *   when the decompressed output would exceed the allowed limit
 */
export function extractZip(zipBuffer: Buffer, options?: ExtractZipOptions): ZipExtractResult[] {
  const results: ZipExtractResult[] = [];
  const maxTotalOutput = _computeInflateCap(zipBuffer.length, options?.maxTotalOutput);
  let totalOutput = 0;
  let pos = 0;

  while (pos + 4 <= zipBuffer.length) {
    const sig = zipBuffer.readUInt32LE(pos);

    // Stop at Central Directory or EOCD structures
    if (sig === SIG_CDE || sig === SIG_EOCD || sig === SIG_ZIP64_EOCD) break;

    if (sig !== SIG_LFH) {
      if (sig === SIG_DD) {
        pos += 16;
        continue;
      }
      throw new BfsError(`ZIP: unexpected signature 0x${sig.toString(16)} at offset ${pos}`);
    }

    if (pos + 30 > zipBuffer.length) {
      throw new BfsError('ZIP: truncated Local File Header');
    }

    const versionNeeded = zipBuffer.readUInt16LE(pos + 4);
    const isZip64 = versionNeeded >= VERSION_NEEDED_ZIP64;

    const filenameLen = zipBuffer.readUInt16LE(pos + 26);
    const extraLen = zipBuffer.readUInt16LE(pos + 28);
    const rawCompressedSize = zipBuffer.readUInt32LE(pos + 18);
    const rawUncompressedSize = zipBuffer.readUInt32LE(pos + 22);
    const storedCrc32 = zipBuffer.readUInt32LE(pos + 14);

    const headerEnd = pos + 30 + filenameLen + extraLen;
    if (headerEnd > zipBuffer.length) {
      throw new BfsError('ZIP: truncated filename/extra in Local File Header');
    }

    let compressedSize: number;
    let uncompressedSize: number;
    if (rawCompressedSize === MARKER_32 || rawUncompressedSize === MARKER_32) {
      const extraStart = pos + 30 + filenameLen;
      const extraBuf = zipBuffer.subarray(extraStart, extraStart + extraLen);
      const z64 = _parseZip64ExtraLfh(extraBuf);
      compressedSize = z64.compressedSize;
      uncompressedSize = z64.uncompressedSize;
    } else {
      compressedSize = rawCompressedSize;
      uncompressedSize = rawUncompressedSize;
    }

    const filename = zipBuffer.toString('utf8', pos + 30, pos + 30 + filenameLen);
    const dataStart = headerEnd;
    const dataEnd = dataStart + compressedSize;

    if (dataEnd > zipBuffer.length) {
      throw new BfsError(`ZIP: compressed data for "${filename}" exceeds buffer`);
    }

    const compressedData = zipBuffer.subarray(dataStart, dataEnd);
    const remaining = maxTotalOutput - totalOutput;
    if (remaining <= 0) {
      throw new BfsError(`ZIP: decompressed output exceeds the ${maxTotalOutput}-byte limit (possible decompression bomb)`);
    }
    let decompressed: Buffer;
    try {
      decompressed = zlib.inflateRawSync(compressedData, { maxOutputLength: Math.min(remaining, BUFFER_CONSTANTS.MAX_LENGTH) });
    } catch (e) {
      const code = e instanceof Error ? (e as NodeJS.ErrnoException).code : undefined;
      if (code === 'ERR_BUFFER_TOO_LARGE') {
        throw new BfsError(`ZIP: decompressed output for "${filename}" exceeds the ${maxTotalOutput}-byte limit (possible decompression bomb)`);
      }
      throw new BfsError(`ZIP: inflate failed for "${filename}": ${e instanceof Error ? e.message : String(e)}`);
    }
    totalOutput += decompressed.length;

    if (decompressed.length !== uncompressedSize) {
      throw new BfsError(`ZIP: size mismatch for "${filename}": expected ${uncompressedSize}, got ${decompressed.length}`);
    }

    const actualCrc32 = zlib.crc32(decompressed);
    if (actualCrc32 !== storedCrc32) {
      throw new BfsError(`ZIP: CRC-32 mismatch for "${filename}": expected 0x${storedCrc32.toString(16)}, got 0x${actualCrc32.toString(16)}`);
    }

    results.push({ filename, data: decompressed });

    // ZIP64 data descriptor: 24 bytes (4+4+8+8); legacy: 16 bytes (4+4+4+4)
    const ddSize = isZip64 ? 24 : 16;
    pos = dataEnd + ddSize;
  }

  return results;
}

// ─── Compressibility estimation ──────────────────────────────────────────────

/**
 * File extensions that are already compressed and won't benefit from deflate.
 * `.ts` is intentionally excluded — TypeScript files are compressible.
 */
const INCOMPRESSIBLE_EXTS = new Set([
  // Images
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.webp',
  '.avif',
  '.heic',
  '.heif',
  '.bmp',
  '.tiff',
  // Video
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.wmv',
  '.flv',
  '.webm',
  '.m4v',
  // Audio
  '.mp3',
  '.aac',
  '.ogg',
  '.flac',
  '.m4a',
  '.wma',
  '.opus',
  // Archives
  '.zip',
  '.gz',
  '.bz2',
  '.xz',
  '.7z',
  '.rar',
  '.zst',
  '.lz4',
  // Compressed documents / packages
  '.pdf',
  '.docx',
  '.xlsx',
  '.pptx',
  '.odt',
  '.ods',
  '.odp',
  '.jar',
  '.war',
  '.ear',
  '.apk',
  '.ipa',
]);

/** Result of a directory compressibility scan. */
export interface CompressibilityResult {
  totalBytes: number;
  compressibleBytes: number;
  incompressibleBytes: number;
  /** Fraction incompressibleBytes / totalBytes (0–1). 0 when totalBytes === 0. */
  ratio: number;
  /** Top 3 extensions by incompressible byte count, for user display. */
  topIncompressible: string[];
}

/**
 * Estimates whether files in a directory are worth compressing, based on extensions.
 * Skips `.bfs/` entirely. Files under `.git/` are counted as incompressible regardless
 * of extension (pack files, loose objects, etc.).
 * Unknown extensions are treated as compressible (conservative default).
 *
 * @param rootDir - Directory to analyse
 * @returns Compressibility statistics
 */
export async function estimateCompressibility(rootDir: string): Promise<CompressibilityResult> {
  let compressibleBytes = 0;
  let incompressibleBytes = 0;
  const extBytes = new Map<string, number>();

  const entries = await fs.readdir(rootDir, { recursive: true, withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    const fullPath = path.join(entry.parentPath, entry.name);
    const rel = path.relative(rootDir, fullPath);
    const segments = rel.split(path.sep);

    if (segments[0] === '.bfs') continue;

    const ext = path.extname(entry.name).toLowerCase();
    const isIncompressible = segments[0] === '.git' || INCOMPRESSIBLE_EXTS.has(ext);

    const { size } = await fs.stat(fullPath);

    if (isIncompressible) {
      incompressibleBytes += size;
      const key = ext || '(no ext)';
      extBytes.set(key, (extBytes.get(key) ?? 0) + size);
    } else {
      compressibleBytes += size;
    }
  }

  const totalBytes = compressibleBytes + incompressibleBytes;
  const ratio = totalBytes === 0 ? 0 : incompressibleBytes / totalBytes;

  const topIncompressible = [...extBytes.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([ext]) => ext);

  return { totalBytes, compressibleBytes, incompressibleBytes, ratio, topIncompressible };
}

// ─── Detection ────────────────────────────────────────────────────────────────

/**
 * Returns true if the buffer starts with ZIP Local File Header magic (PK\x03\x04).
 * Detects a compressed blob without reading its full structure.
 * @param buf - Buffer to probe (data section of a BFS blob)
 */
export function isZipBuffer(buf: Buffer): boolean {
  return buf.length >= 4 && buf.readUInt32LE(0) === SIG_LFH;
}
