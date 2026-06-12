import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as zlib from 'node:zlib';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { createZipPacker, estimateCompressibility, extractZip, isZipBuffer } from '../../src/core/compression.js';
import { BfsError } from '../../src/core/errors.js';

// ─── createZipPacker + extractZip roundtrip ───────────────────────────────────

describe('createZipPacker + extractZip', () => {
  it('should roundtrip a single file byte-for-byte', () => {
    const packer = createZipPacker();
    const data = Buffer.from('hello world');
    packer.addFile('hello.txt', data);
    const zip = packer.finalize();

    const results = extractZip(zip);

    expect(results).toHaveLength(1);
    const [result] = results;
    assert(result !== undefined);
    expect(result.filename).toBe('hello.txt');
    expect(Buffer.compare(result.data, data)).toBe(0);
  });

  it('should roundtrip multiple files byte-for-byte', () => {
    const packer = createZipPacker();
    const files = [
      { name: 'a.txt', data: Buffer.from('aaaa') },
      { name: 'sub/b.bin', data: Buffer.from([0x00, 0xff, 0x42]) },
      { name: 'empty.dat', data: Buffer.alloc(0) },
    ];
    for (const f of files) packer.addFile(f.name, f.data);
    const zip = packer.finalize();

    const results = extractZip(zip);

    expect(results).toHaveLength(3);
    for (let i = 0; i < files.length; i++) {
      const r = results[i];
      const f = files[i];
      assert(r !== undefined, `results[${i}] should be defined`);
      assert(f !== undefined, `files[${i}] should be defined`);
      expect(r.filename).toBe(f.name);
      expect(Buffer.compare(r.data, f.data)).toBe(0);
    }
  });

  it('should handle filenames with Polish characters (UTF-8)', () => {
    const packer = createZipPacker();
    const name = 'zażółć/gęślą.txt';
    const data = Buffer.from('treść pliku');
    packer.addFile(name, data);
    const zip = packer.finalize();

    const results = extractZip(zip);

    const [result] = results;
    assert(result !== undefined);
    expect(result.filename).toBe(name);
    expect(Buffer.compare(result.data, data)).toBe(0);
  });

  it('should handle large compressible data', () => {
    const packer = createZipPacker();
    const data = Buffer.alloc(64 * 1024, 0x41); // 64 KiB of 'A' — highly compressible
    packer.addFile('large.bin', data);
    const zip = packer.finalize();

    const results = extractZip(zip);

    const [result] = results;
    assert(result !== undefined);
    expect(Buffer.compare(result.data, data)).toBe(0);
    expect(zip.length).toBeLessThan(data.length); // deflate should shrink it significantly
  });

  it('should handle incompressible binary data', () => {
    const packer = createZipPacker();
    const data = Buffer.from(Array.from({ length: 256 }, (_, i) => i % 256));
    packer.addFile('random.bin', data);
    const zip = packer.finalize();

    const results = extractZip(zip);

    const [result] = results;
    assert(result !== undefined);
    expect(Buffer.compare(result.data, data)).toBe(0);
  });

  it('should produce valid ZIP magic bytes (PK\\x03\\x04)', () => {
    const packer = createZipPacker();
    packer.addFile('f.txt', Buffer.from('x'));
    const zip = packer.finalize();

    expect(zip[0]).toBe(0x50); // P
    expect(zip[1]).toBe(0x4b); // K
    expect(zip[2]).toBe(0x03);
    expect(zip[3]).toBe(0x04);
  });

  it('should store correct CRC-32 for each entry', () => {
    const packer = createZipPacker();
    const data = Buffer.from('test data for crc');
    packer.addFile('crc.txt', data);
    const zip = packer.finalize();

    // CRC-32 is at offset 14 in Local File Header
    const storedCrc = zip.readUInt32LE(14);
    const expectedCrc = zlib.crc32(data);

    expect(storedCrc).toBe(expectedCrc);
  });

  it('should finalize empty packer (no files)', () => {
    const packer = createZipPacker();
    const zip = packer.finalize();

    const results = extractZip(zip);

    expect(results).toHaveLength(0);
    // ZIP64 EOCD signature at start of an empty ZIP (always-ZIP64 packer)
    expect(zip.readUInt32LE(0)).toBe(0x06064b50);
  });
});

// ─── extractZip error handling ────────────────────────────────────────────────

describe('extractZip', () => {
  it('should throw BfsError on bad ZIP signature', () => {
    const buf = Buffer.from('NOT A ZIP FILE');

    expect(() => extractZip(buf)).toThrow(BfsError);
  });

  it('should throw BfsError on truncated Local File Header', () => {
    const buf = Buffer.alloc(10);
    buf.writeUInt32LE(0x04034b50, 0); // LFH signature but truncated

    expect(() => extractZip(buf)).toThrow(BfsError);
  });

  it('should throw BfsError on CRC-32 mismatch', () => {
    const packer = createZipPacker();
    packer.addFile('f.txt', Buffer.from('original'));
    const zip = packer.finalize();

    // Corrupt the CRC-32 field in LFH (offset 14)
    const corrupted = Buffer.from(zip);
    corrupted.writeUInt32LE(0xdeadbeef, 14);

    expect(() => extractZip(corrupted)).toThrow(BfsError);
  });

  it('should throw BfsError on truncated compressed data', () => {
    const packer = createZipPacker();
    packer.addFile('f.txt', Buffer.from('hello world'));
    const zip = packer.finalize();

    // Truncate zip to cut off compressed data
    const truncated = zip.subarray(0, 40);

    expect(() => extractZip(truncated)).toThrow(BfsError);
  });
});

// ─── extractZip decompression bomb guard ──────────────────────────────────────

// extractZip caps total decompressed output so a crafted archive cannot expand
// into an out-of-memory condition. The cap is exercised via the maxTotalOutput
// override because real deflate output never exceeds the physical ratio bound
// used by the default cap.
describe('extractZip decompression bomb guard', () => {
  it('should reject a single entry that exceeds the output cap', () => {
    const packer = createZipPacker();
    packer.addFile('big.txt', Buffer.alloc(4096, 0x41));
    const zip = packer.finalize();

    expect(() => extractZip(zip, { maxTotalOutput: 100 })).toThrow(BfsError);
  });

  it('should reject cumulative output across entries that exceeds the cap', () => {
    const packer = createZipPacker();
    packer.addFile('a.txt', Buffer.alloc(2000, 0x42));
    packer.addFile('b.txt', Buffer.alloc(2000, 0x43));
    const zip = packer.finalize();

    // First entry (2000B) fits under 3000; the second pushes the total over.
    expect(() => extractZip(zip, { maxTotalOutput: 3000 })).toThrow(BfsError);
  });

  it('should extract normally when total output stays within the cap', () => {
    const packer = createZipPacker();
    const a = Buffer.alloc(2000, 0x42);
    const b = Buffer.alloc(2000, 0x43);
    packer.addFile('a.txt', a);
    packer.addFile('b.txt', b);
    const zip = packer.finalize();

    const results = extractZip(zip, { maxTotalOutput: 5000 });

    expect(results).toHaveLength(2);
    assert(results[0] !== undefined && results[1] !== undefined);
    expect(Buffer.compare(results[0].data, a)).toBe(0);
    expect(Buffer.compare(results[1].data, b)).toBe(0);
  });
});

// ─── ZIP64 / legacy compatibility ────────────────────────────────────────────

describe('ZIP64 format', () => {
  it('should extract legacy (non-ZIP64) archives', () => {
    // Build a legacy ZIP by hand: LFH + compressed data + DD(16B) + CDE + EOCD
    const filename = Buffer.from('test.txt', 'utf8');
    const data = Buffer.from('hello legacy');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    // Legacy LFH (VERSION_NEEDED = 0x0014, no extra field)
    const lfh = Buffer.alloc(30 + filename.length);
    let p = 0;
    lfh.writeUInt32LE(0x04034b50, p);
    p += 4;
    lfh.writeUInt16LE(0x0014, p);
    p += 2; // legacy version
    lfh.writeUInt16LE(0x0808, p);
    p += 2;
    lfh.writeUInt16LE(0x0008, p);
    p += 2;
    lfh.writeUInt16LE(0, p);
    p += 2; // dosTime
    lfh.writeUInt16LE(0, p);
    p += 2; // dosDate
    lfh.writeUInt32LE(crc, p);
    p += 4;
    lfh.writeUInt32LE(compressed.length, p);
    p += 4;
    lfh.writeUInt32LE(data.length, p);
    p += 4;
    lfh.writeUInt16LE(filename.length, p);
    p += 2;
    lfh.writeUInt16LE(0, p);
    p += 2;
    filename.copy(lfh, p);

    // Legacy DD (16 bytes)
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeUInt32LE(compressed.length, 8);
    dd.writeUInt32LE(data.length, 12);

    // Legacy CDE
    const cde = Buffer.alloc(46 + filename.length);
    p = 0;
    cde.writeUInt32LE(0x02014b50, p);
    p += 4;
    cde.writeUInt16LE(0x0314, p);
    p += 2;
    cde.writeUInt16LE(0x0014, p);
    p += 2;
    cde.writeUInt16LE(0x0808, p);
    p += 2;
    cde.writeUInt16LE(0x0008, p);
    p += 2;
    cde.writeUInt16LE(0, p);
    p += 2;
    cde.writeUInt16LE(0, p);
    p += 2;
    cde.writeUInt32LE(crc, p);
    p += 4;
    cde.writeUInt32LE(compressed.length, p);
    p += 4;
    cde.writeUInt32LE(data.length, p);
    p += 4;
    cde.writeUInt16LE(filename.length, p);
    p += 2;
    cde.writeUInt16LE(0, p);
    p += 2;
    cde.writeUInt16LE(0, p);
    p += 2;
    cde.writeUInt16LE(0, p);
    p += 2;
    cde.writeUInt16LE(0, p);
    p += 2;
    cde.writeUInt32LE(0, p);
    p += 4;
    cde.writeUInt32LE(0, p);
    p += 4; // local header offset
    filename.copy(cde, p);

    // Legacy EOCD
    const eocd = Buffer.alloc(22);
    const cdOffset = lfh.length + compressed.length + dd.length;
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(1, 8);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(cde.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);

    const legacyZip = Buffer.concat([lfh, compressed, dd, cde, eocd]);

    const results = extractZip(legacyZip);

    expect(results).toHaveLength(1);
    expect(results[0]?.filename).toBe('test.txt');
    expect(Buffer.compare(results[0]?.data ?? Buffer.alloc(0), data)).toBe(0);
  });

  it('should parse ZIP64 extra field when size markers are 0xFFFFFFFF', () => {
    // Use a small file but simulate ZIP64 markers in LFH + ZIP64 extra field
    const filename = Buffer.from('z64.txt', 'utf8');
    const data = Buffer.from('zip64 test data');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    // ZIP64 extra field for LFH: headerID(2) + dataSize(2) + uncompressed(8) + compressed(8) = 20
    const extra = Buffer.alloc(20);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(16, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(compressed.length), 12);

    // LFH with ZIP64 version and markers
    const lfh = Buffer.alloc(30 + filename.length + extra.length);
    let p = 0;
    lfh.writeUInt32LE(0x04034b50, p);
    p += 4;
    lfh.writeUInt16LE(0x002d, p);
    p += 2; // ZIP64 version
    lfh.writeUInt16LE(0x0808, p);
    p += 2;
    lfh.writeUInt16LE(0x0008, p);
    p += 2;
    lfh.writeUInt16LE(0, p);
    p += 2;
    lfh.writeUInt16LE(0, p);
    p += 2;
    lfh.writeUInt32LE(crc, p);
    p += 4;
    lfh.writeUInt32LE(0xffffffff, p);
    p += 4; // marker
    lfh.writeUInt32LE(0xffffffff, p);
    p += 4; // marker
    lfh.writeUInt16LE(filename.length, p);
    p += 2;
    lfh.writeUInt16LE(extra.length, p);
    p += 2;
    filename.copy(lfh, p);
    p += filename.length;
    extra.copy(lfh, p);

    // ZIP64 DD (24 bytes)
    const dd = Buffer.alloc(24);
    dd.writeUInt32LE(0x08074b50, 0);
    dd.writeUInt32LE(crc, 4);
    dd.writeBigUInt64LE(BigInt(compressed.length), 8);
    dd.writeBigUInt64LE(BigInt(data.length), 16);

    // EOCD (just to terminate scanning)
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);

    const zip = Buffer.concat([lfh, compressed, dd, eocd]);

    const results = extractZip(zip);

    expect(results).toHaveLength(1);
    expect(results[0]?.filename).toBe('z64.txt');
    expect(Buffer.compare(results[0]?.data ?? Buffer.alloc(0), data)).toBe(0);
  });

  it('should throw BfsError when ZIP64 extra field missing but marker present', () => {
    const filename = Buffer.from('bad.txt', 'utf8');
    const data = Buffer.from('test');
    const compressed = zlib.deflateRawSync(data);
    const crc = zlib.crc32(data);

    // LFH with 0xFFFFFFFF markers but NO extra field
    const lfh = Buffer.alloc(30 + filename.length);
    let p = 0;
    lfh.writeUInt32LE(0x04034b50, p);
    p += 4;
    lfh.writeUInt16LE(0x002d, p);
    p += 2;
    lfh.writeUInt16LE(0x0808, p);
    p += 2;
    lfh.writeUInt16LE(0x0008, p);
    p += 2;
    lfh.writeUInt16LE(0, p);
    p += 2;
    lfh.writeUInt16LE(0, p);
    p += 2;
    lfh.writeUInt32LE(crc, p);
    p += 4;
    lfh.writeUInt32LE(0xffffffff, p);
    p += 4;
    lfh.writeUInt32LE(0xffffffff, p);
    p += 4;
    lfh.writeUInt16LE(filename.length, p);
    p += 2;
    lfh.writeUInt16LE(0, p);
    p += 2; // extra len = 0
    filename.copy(lfh, p);

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    const zip = Buffer.concat([lfh, compressed, eocd]);

    expect(() => extractZip(zip)).toThrow(BfsError);
  });
});

// ─── isZipBuffer ─────────────────────────────────────────────────────────────

describe('isZipBuffer', () => {
  it('should return true for valid ZIP magic', () => {
    const packer = createZipPacker();
    packer.addFile('f.txt', Buffer.from('x'));
    const zip = packer.finalize();

    expect(isZipBuffer(zip)).toBe(true);
  });

  it('should return false for non-ZIP data', () => {
    expect(isZipBuffer(Buffer.from('BFS\0'))).toBe(false);
    expect(isZipBuffer(Buffer.from([0x00, 0x00, 0x00, 0x00]))).toBe(false);
  });

  it('should return false for buffer shorter than 4 bytes', () => {
    expect(isZipBuffer(Buffer.from([0x50, 0x4b]))).toBe(false);
    expect(isZipBuffer(Buffer.alloc(0))).toBe(false);
  });
});

// ─── estimateCompressibility ──────────────────────────────────────────────────

describe('estimateCompressibility', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-compress-est-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function writeFile(rel: string, size: number): Promise<void> {
    const full = path.join(tmpDir, rel);
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, Buffer.alloc(size, 0x41));
  }

  it('should return ratio=0 for a compressible-only directory', async () => {
    await writeFile('main.ts', 1000);
    await writeFile('config.json', 500);

    const result = await estimateCompressibility(tmpDir);

    expect(result.incompressibleBytes).toBe(0);
    expect(result.compressibleBytes).toBe(1500);
    expect(result.ratio).toBe(0);
    expect(result.topIncompressible).toHaveLength(0);
  });

  it('should return ratio=1 for an incompressible-only directory', async () => {
    await writeFile('photo.jpg', 2000);
    await writeFile('video.mp4', 3000);

    const result = await estimateCompressibility(tmpDir);

    expect(result.incompressibleBytes).toBe(5000);
    expect(result.compressibleBytes).toBe(0);
    expect(result.ratio).toBe(1);
  });

  it('should compute correct ratio for mixed directory', async () => {
    await writeFile('doc.txt', 1000); // compressible
    await writeFile('photo.jpg', 1000); // incompressible

    const result = await estimateCompressibility(tmpDir);

    expect(result.totalBytes).toBe(2000);
    expect(result.ratio).toBeCloseTo(0.5, 5);
  });

  it('should skip .bfs/ directory entirely', async () => {
    await writeFile('code.ts', 1000);
    await writeFile('.bfs/config.json', 500);
    await writeFile('.bfs/cache/blob.bin', 9999);

    const result = await estimateCompressibility(tmpDir);

    expect(result.totalBytes).toBe(1000); // only code.ts counts
    expect(result.compressibleBytes).toBe(1000);
  });

  it('should count .git/ files as incompressible regardless of extension', async () => {
    await writeFile('readme.md', 1000); // compressible
    await writeFile('.git/config', 200); // incompressible (in .git)
    await writeFile('.git/objects/abc.ts', 300); // incompressible (in .git, despite .ts ext)

    const result = await estimateCompressibility(tmpDir);

    expect(result.compressibleBytes).toBe(1000);
    expect(result.incompressibleBytes).toBe(500);
    expect(result.ratio).toBeCloseTo(500 / 1500, 5);
  });

  it('should return ratio=0 for empty directory', async () => {
    const result = await estimateCompressibility(tmpDir);

    expect(result.totalBytes).toBe(0);
    expect(result.ratio).toBe(0);
    expect(result.topIncompressible).toHaveLength(0);
  });

  it('should return top 3 incompressible extensions sorted by byte count', async () => {
    await writeFile('a.jpg', 5000);
    await writeFile('b.mp4', 3000);
    await writeFile('c.zip', 1000);
    await writeFile('d.txt', 2000); // compressible, should not appear

    const result = await estimateCompressibility(tmpDir);

    expect(result.topIncompressible).toHaveLength(3);
    expect(result.topIncompressible[0]).toBe('.jpg');
    expect(result.topIncompressible[1]).toBe('.mp4');
    expect(result.topIncompressible[2]).toBe('.zip');
  });

  it('should treat unknown extensions as compressible', async () => {
    await writeFile('data.xyz', 1000);
    await writeFile('noext', 500);

    const result = await estimateCompressibility(tmpDir);

    expect(result.compressibleBytes).toBe(1500);
    expect(result.incompressibleBytes).toBe(0);
    expect(result.ratio).toBe(0);
  });

  it('should treat .ts files as compressible (not MPEG-TS)', async () => {
    await writeFile('app.ts', 2000);
    await writeFile('utils.ts', 1000);

    const result = await estimateCompressibility(tmpDir);

    expect(result.compressibleBytes).toBe(3000);
    expect(result.incompressibleBytes).toBe(0);
    expect(result.ratio).toBe(0);
  });
});
