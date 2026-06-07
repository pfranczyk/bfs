import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { estimateBlobSize, packBlob, packBlobToFile, packBlobToFileZipped } from '../../src/core/blob-pack.js';
import { parseBlobFileTable, parseBlobFileTableFromFile, unpackBlob, unpackBlobFromFile } from '../../src/core/blob-unpack.js';
import { BfsError, UnsafePathError } from '../../src/core/errors.js';
import { createIgnoreFilter } from '../../src/core/ignore.js';
import { BLOB_FLAGS } from '../../src/types/index.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-test-'));
}

async function writeFile(dir: string, relPath: string, content: string | Buffer): Promise<void> {
  const full = path.join(dir, relPath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content);
}

async function readAllFiles(dir: string): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>();
  async function recurse(current: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await recurse(path.join(current, e.name), rel);
      } else if (e.isFile()) {
        result.set(rel, await fs.readFile(path.join(current, e.name)));
      }
    }
  }
  await recurse(dir, '');
  return result;
}

describe('blob-pack / blob-unpack', () => {
  let srcDir: string;
  let outDir: string;

  beforeEach(async () => {
    srcDir = await makeTempDir();
    outDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  it('should pack and unpack a single file byte-for-byte', async () => {
    await writeFile(srcDir, 'hello.txt', 'Hello, BFS!');
    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);
    await unpackBlob(blob, outDir);
    const out = await fs.readFile(path.join(outDir, 'hello.txt'));
    expect(out.toString()).toBe('Hello, BFS!');
  });

  it('should roundtrip multiple files with identical content', async () => {
    await writeFile(srcDir, 'a.txt', 'file A');
    await writeFile(srcDir, 'b.txt', 'file B');
    await writeFile(srcDir, 'c.bin', Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);
    await unpackBlob(blob, outDir);

    const srcFiles = await readAllFiles(srcDir);
    const outFiles = await readAllFiles(outDir);

    expect(outFiles.size).toBe(srcFiles.size);
    for (const [rel, srcData] of srcFiles) {
      const outData = outFiles.get(rel);
      expect(outData).toBeDefined();
      expect(outData?.equals(srcData)).toBe(true);
    }
  });

  it('should handle an empty directory', async () => {
    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);
    const { extracted } = await unpackBlob(blob, outDir);
    expect(extracted).toHaveLength(0);
  });

  it('should handle nested directories', async () => {
    await writeFile(srcDir, 'dir1/sub/deep.txt', 'deep content');
    await writeFile(srcDir, 'dir1/file.txt', 'shallow');
    await writeFile(srcDir, 'top.txt', 'top');

    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);
    await unpackBlob(blob, outDir);

    const srcFiles = await readAllFiles(srcDir);
    const outFiles = await readAllFiles(outDir);

    expect(outFiles.size).toBe(srcFiles.size);
    for (const [rel, srcData] of srcFiles) {
      expect(outFiles.get(rel)?.equals(srcData)).toBe(true);
    }
  });

  it('should handle filenames with Polish characters (UTF-8)', async () => {
    await writeFile(srcDir, 'zażółć_gęślą_jaźń.txt', 'polskie znaki');
    await writeFile(srcDir, 'katalog_ąćęłńóśźż/plik.txt', 'nested Polish');

    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);
    await unpackBlob(blob, outDir);

    const srcFiles = await readAllFiles(srcDir);
    const outFiles = await readAllFiles(outDir);

    expect(outFiles.size).toBe(srcFiles.size);
    for (const [rel, srcData] of srcFiles) {
      expect(outFiles.get(rel)?.equals(srcData)).toBe(true);
    }
  });

  it('should handle a large file (>4MB)', async () => {
    const large = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < large.length; i++) {
      large[i] = i % 256;
    }
    await writeFile(srcDir, 'large.bin', large);

    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);
    await unpackBlob(blob, outDir);

    const out = await fs.readFile(path.join(outDir, 'large.bin'));
    expect(out.equals(large)).toBe(true);
  });

  it('should produce deterministic output for the same input', async () => {
    await writeFile(srcDir, 'b.txt', 'B');
    await writeFile(srcDir, 'a.txt', 'A');

    const filter = await createIgnoreFilter(srcDir);

    // Pack twice; timestamps differ, so we compare file table entries
    const { blob: blob1 } = await packBlob(srcDir, filter);
    const { blob: blob2 } = await packBlob(srcDir, filter);

    const table1 = parseBlobFileTable(blob1);
    const table2 = parseBlobFileTable(blob2);

    expect(table1.map((e) => e.path)).toEqual(table2.map((e) => e.path));
    expect(table1.map((e) => e.hash)).toEqual(table2.map((e) => e.hash));
    // Files should be in sorted order
    expect(table1[0].path).toBe('a.txt');
    expect(table1[1].path).toBe('b.txt');
  });

  it('should apply ignore filter and exclude matching files', async () => {
    await writeFile(srcDir, 'keep.txt', 'keep');
    await writeFile(srcDir, 'Thumbs.db', 'ignore me');
    await writeFile(srcDir, '.bfsignore', 'Thumbs.db\n');

    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);
    const entries = parseBlobFileTable(blob);

    expect(entries.map((e) => e.path)).toContain('keep.txt');
    expect(entries.map((e) => e.path)).not.toContain('Thumbs.db');
  });

  it('should throw on corrupted blob checksum', async () => {
    await writeFile(srcDir, 'file.txt', 'data');
    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);

    // Corrupt a byte in the middle
    blob[100] ^= 0xff;

    await expect(unpackBlob(blob, outDir)).rejects.toThrow('checksum');
  });

  it('should respect filter parameter in unpackBlob', async () => {
    await writeFile(srcDir, 'include.txt', 'yes');
    await writeFile(srcDir, 'exclude.txt', 'no');

    const filter = await createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);

    const { extracted } = await unpackBlob(blob, outDir, (e) => e.path === 'include.txt');
    expect(extracted).toHaveLength(1);
    expect(extracted[0].path).toBe('include.txt');

    const outFiles = await readAllFiles(outDir);
    expect(outFiles.has('include.txt')).toBe(true);
    expect(outFiles.has('exclude.txt')).toBe(false);
  });
});

describe('estimateBlobSize', () => {
  let srcDir: string;

  beforeEach(async () => {
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-est-'));
  });

  afterEach(async () => {
    await fs.rm(srcDir, { recursive: true, force: true });
  });

  it('should return a positive size for a non-empty directory', async () => {
    await fs.writeFile(path.join(srcDir, 'a.txt'), Buffer.alloc(100));
    const ignoreFilter = createIgnoreFilter(srcDir);
    const estimate = await estimateBlobSize(srcDir, ignoreFilter);
    expect(estimate).toBeGreaterThan(100);
  });

  it('should match actual blob size within a small tolerance', async () => {
    await fs.writeFile(path.join(srcDir, 'file.bin'), Buffer.alloc(1024, 0xab));
    const ignoreFilter = createIgnoreFilter(srcDir);

    const estimate = await estimateBlobSize(srcDir, ignoreFilter);
    const { blob } = await packBlob(srcDir, ignoreFilter);

    // Estimate should equal actual blob length (exact calculation)
    expect(estimate).toBe(blob.length);
  });

  it('should return header+checksum size for an empty directory', async () => {
    const ignoreFilter = createIgnoreFilter(srcDir);
    const estimate = await estimateBlobSize(srcDir, ignoreFilter);
    // HEADER_SIZE (70) + trailing SHA-256 (32) = 102
    expect(estimate).toBe(102);
  });
});

describe('packBlobToFile', () => {
  let srcDir: string;
  let tmpDir: string;

  beforeEach(async () => {
    srcDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-src-'));
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-out-'));
  });

  afterEach(async () => {
    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should produce an identical blob to packBlob', async () => {
    await fs.writeFile(path.join(srcDir, 'hello.txt'), 'Hello, World!');
    await fs.writeFile(path.join(srcDir, 'data.bin'), Buffer.alloc(256, 0x42));
    const ignoreFilter = createIgnoreFilter(srcDir);

    const outputPath = path.join(tmpDir, 'out.blob');
    const { blobSize, fileCount } = await packBlobToFile(srcDir, outputPath, ignoreFilter);

    const { blob: ramBlob } = await packBlob(srcDir, ignoreFilter);
    const diskBlob = await fs.readFile(outputPath);

    expect(fileCount).toBe(2);
    expect(blobSize).toBe(diskBlob.length);

    // The two blobs differ in timestamp (header offset 0x1A) — compare everything except bytes 26-33
    // Instead, verify both unpack to the same files
    const outDir1 = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-cmp1-'));
    const outDir2 = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-cmp2-'));
    try {
      await unpackBlob(ramBlob, outDir1);
      await unpackBlob(diskBlob, outDir2);
      const files1 = await readAllFiles(outDir1);
      const files2 = await readAllFiles(outDir2);
      expect([...files1.keys()].sort()).toEqual([...files2.keys()].sort());
      for (const [key, buf1] of files1) {
        expect(buf1).toEqual(files2.get(key));
      }
    } finally {
      await fs.rm(outDir1, { recursive: true, force: true });
      await fs.rm(outDir2, { recursive: true, force: true });
    }
  });

  it('should report skipped files for unreadable entries', async () => {
    await fs.writeFile(path.join(srcDir, 'ok.txt'), 'readable');
    const ignoreFilter = createIgnoreFilter(srcDir);
    const outputPath = path.join(tmpDir, 'out2.blob');

    const { fileCount, skipped } = await packBlobToFile(srcDir, outputPath, ignoreFilter);
    // No unreadable files in this test — skipped should be empty
    expect(skipped).toHaveLength(0);
    expect(fileCount).toBe(1);
  });
});

// ─── packBlob (compressed) ────────────────────────────────────────────────────

describe('packBlob (compressed=true)', () => {
  let tmpDir: string;
  let srcDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-test-comp-'));
    srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should set COMPRESSED flag (bit1) in header', async () => {
    await fs.writeFile(path.join(srcDir, 'a.txt'), 'hello');
    const ignoreFilter = createIgnoreFilter(srcDir);

    const { blob } = await packBlob(srcDir, ignoreFilter, undefined, true);

    // Flags field at offset 0x16 = 22
    const flags = blob.readUInt32LE(22);
    expect(flags & BLOB_FLAGS.COMPRESSED).toBe(BLOB_FLAGS.COMPRESSED);
  });

  it('should set file_count=1 with entry name "bfs.pack.zip"', async () => {
    await fs.writeFile(path.join(srcDir, 'a.txt'), 'hello');
    await fs.writeFile(path.join(srcDir, 'b.txt'), 'world');
    const ignoreFilter = createIgnoreFilter(srcDir);

    const { blob } = await packBlob(srcDir, ignoreFilter, undefined, true);

    const entries = parseBlobFileTable(blob);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('bfs.pack.zip');
  });

  it('should roundtrip via unpackBlob (byte-for-byte)', async () => {
    await fs.writeFile(path.join(srcDir, 'hello.txt'), 'content of hello');
    await fs.mkdir(path.join(srcDir, 'sub'), { recursive: true });
    await fs.writeFile(path.join(srcDir, 'sub/nested.txt'), 'nested content');
    const ignoreFilter = createIgnoreFilter(srcDir);

    const { blob } = await packBlob(srcDir, ignoreFilter, undefined, true);
    const destDir = path.join(tmpDir, 'dest');
    await fs.mkdir(destDir);
    await unpackBlob(blob, destDir);

    const original = await readAllFiles(srcDir);
    const restored = await readAllFiles(destDir);
    expect(restored.size).toBe(original.size);
    for (const [relPath, origData] of original) {
      const restoredData = restored.get(relPath);
      expect(restoredData).toBeDefined();
      assert(restoredData !== undefined, `missing restored file: ${relPath}`);
      expect(Buffer.compare(restoredData, origData)).toBe(0);
    }
  });

  it('should handle empty directory', async () => {
    const ignoreFilter = createIgnoreFilter(srcDir);

    const { blob, skipped } = await packBlob(srcDir, ignoreFilter, undefined, true);

    expect(skipped).toHaveLength(0);
    const destDir = path.join(tmpDir, 'dest');
    await fs.mkdir(destDir);
    await unpackBlob(blob, destDir);
    const restored = await readAllFiles(destDir);
    expect(restored.size).toBe(0);
  });
});

// ─── packBlobToFileZipped ─────────────────────────────────────────────────────

describe('packBlobToFileZipped', () => {
  let tmpDir: string;
  let srcDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-test-zipped-'));
    srcDir = path.join(tmpDir, 'src');
    await fs.mkdir(srcDir);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('should produce a valid BFS blob with COMPRESSED flag set', async () => {
    await fs.writeFile(path.join(srcDir, 'a.txt'), 'hello');
    const ignoreFilter = createIgnoreFilter(srcDir);
    const outputPath = path.join(tmpDir, 'out.blob');

    await packBlobToFileZipped(srcDir, outputPath, ignoreFilter);

    const blob = await fs.readFile(outputPath);
    const flags = blob.readUInt32LE(22);
    expect(flags & BLOB_FLAGS.COMPRESSED).toBe(BLOB_FLAGS.COMPRESSED);
    const entries = parseBlobFileTable(blob);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe('bfs.pack.zip');
  });

  it('should roundtrip via unpackBlobFromFile (byte-for-byte)', async () => {
    const files = [
      ['hello.txt', 'content of hello'],
      ['sub/nested.txt', 'nested content'],
      ['data.bin', Buffer.from([0x00, 0x01, 0x02, 0xff])],
    ] as const;
    for (const [name, content] of files) {
      const full = path.join(srcDir, name);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, content);
    }
    const ignoreFilter = createIgnoreFilter(srcDir);
    const outputPath = path.join(tmpDir, 'out.blob');

    await packBlobToFileZipped(srcDir, outputPath, ignoreFilter);

    const destDir = path.join(tmpDir, 'dest');
    await fs.mkdir(destDir);
    await unpackBlobFromFile(outputPath, destDir);

    const original = await readAllFiles(srcDir);
    const restored = await readAllFiles(destDir);
    expect(restored.size).toBe(original.size);
    for (const [relPath, origData] of original) {
      const restoredData = restored.get(relPath);
      expect(restoredData).toBeDefined();
      assert(restoredData !== undefined, `missing restored file: ${relPath}`);
      expect(Buffer.compare(restoredData, origData)).toBe(0);
    }
  });

  it('should return correct fileCount (actual directory files, not ZIP count)', async () => {
    await fs.writeFile(path.join(srcDir, 'a.txt'), 'a');
    await fs.writeFile(path.join(srcDir, 'b.txt'), 'b');
    await fs.writeFile(path.join(srcDir, 'c.txt'), 'c');
    const ignoreFilter = createIgnoreFilter(srcDir);
    const outputPath = path.join(tmpDir, 'out.blob');

    const { fileCount } = await packBlobToFileZipped(srcDir, outputPath, ignoreFilter);

    expect(fileCount).toBe(3); // 3 actual files, not 1 (the ZIP entry)
  });

  it('should return correct totalSize (sum of uncompressed sizes)', async () => {
    const content = 'hello world';
    await fs.writeFile(path.join(srcDir, 'a.txt'), content);
    const ignoreFilter = createIgnoreFilter(srcDir);
    const outputPath = path.join(tmpDir, 'out.blob');

    const { totalSize } = await packBlobToFileZipped(srcDir, outputPath, ignoreFilter);

    expect(totalSize).toBe(Buffer.byteLength(content, 'utf8'));
  });
});

// ─── Security: path-traversal guard + bound allocation ───────────────────────

/** Recomputes the blob's trailing SHA-256 so a tampered body still verifies. */
function recomputeTrailingChecksum(blob: Buffer): void {
  const body = blob.subarray(0, blob.length - 32);
  const digest = createHash('sha256').update(body).digest();
  digest.copy(blob, blob.length - 32);
}

/** Overwrites the first file-table entry's path bytes in place (length must match). */
function patchFirstEntryPath(blob: Buffer, newName: string): void {
  const fileTableOffset = Number(blob.readBigUInt64LE(0x26));
  const pathLen = blob.readUInt16LE(fileTableOffset);
  const nameBuf = Buffer.from(newName, 'utf8');
  if (nameBuf.length !== pathLen) {
    throw new Error(`patch length ${nameBuf.length} !== entry path length ${pathLen}`);
  }
  nameBuf.copy(blob, fileTableOffset + 2);
}

/** Replaces every occurrence of an equal-length needle in the buffer, in place. */
function replaceAllEqualLength(buf: Buffer, search: string, replacement: string): number {
  const needle = Buffer.from(search, 'utf8');
  const repl = Buffer.from(replacement, 'utf8');
  if (needle.length !== repl.length) throw new Error('needle/replacement length mismatch');
  let count = 0;
  let idx = buf.indexOf(needle);
  while (idx !== -1) {
    repl.copy(buf, idx);
    count += 1;
    idx = buf.indexOf(needle, idx + repl.length);
  }
  return count;
}

describe('blob-unpack path-traversal guard', () => {
  let srcDir: string;
  let outDir: string;

  beforeEach(async () => {
    srcDir = await makeTempDir();
    outDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  // A recomputed, internally-consistent trailing checksum must NOT let an
  // escaping path slip through: the guard runs on every entry independently of
  // whether the blob body verifies. This is the "consistent checksum does not
  // bypass the guard" proof the threat model calls for.
  it('should reject an escaping path in a raw blob even with a recomputed checksum (RAM)', async () => {
    await writeFile(srcDir, 'bbbbbbb', 'payload'); // 7-byte name == len('../evil')
    const filter = createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);

    patchFirstEntryPath(blob, '../evil');
    recomputeTrailingChecksum(blob);

    await expect(unpackBlob(blob, outDir)).rejects.toThrow(UnsafePathError);
  });

  it('should reject an escaping path in a raw blob on disk even with a recomputed checksum (streaming)', async () => {
    await writeFile(srcDir, 'bbbbbbb', 'payload');
    const filter = createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter);

    patchFirstEntryPath(blob, '../evil');
    recomputeTrailingChecksum(blob);
    const blobPath = path.join(outDir, 'tampered.blob');
    await fs.writeFile(blobPath, blob);

    await expect(unpackBlobFromFile(blobPath, outDir)).rejects.toThrow(UnsafePathError);
  });

  it('should reject an escaping ZIP entry name even with a recomputed checksum', async () => {
    await writeFile(srcDir, 'bbbbbbb', 'payload');
    const filter = createIgnoreFilter(srcDir);
    const { blob } = await packBlob(srcDir, filter, undefined, true); // compressed

    const replaced = replaceAllEqualLength(blob, 'bbbbbbb', '../evil');
    expect(replaced).toBeGreaterThanOrEqual(2); // local file header + central directory entry
    recomputeTrailingChecksum(blob);

    await expect(unpackBlob(blob, outDir)).rejects.toThrow(UnsafePathError);
  });
});

describe('blob-unpack bound allocation', () => {
  const HUGE = 2 ** 40; // 1 TiB — would OOM / crash if allocated from a tampered header

  let srcDir: string;
  let outDir: string;

  beforeEach(async () => {
    srcDir = await makeTempDir();
    outDir = await makeTempDir();
  });

  afterEach(async () => {
    await fs.rm(srcDir, { recursive: true, force: true });
    await fs.rm(outDir, { recursive: true, force: true });
  });

  async function writeFieldAt(blobPath: string, value: number, offset: number, bytes: 4 | 8): Promise<void> {
    const fh = await fs.open(blobPath, 'r+');
    try {
      const field = Buffer.alloc(bytes);
      if (bytes === 8) field.writeBigUInt64LE(BigInt(value));
      else field.writeUInt32LE(value);
      await fh.write(field, 0, bytes, offset);
    } finally {
      await fh.close();
    }
  }

  it('should reject an out-of-bounds file table length before allocating (streaming unpack)', async () => {
    await writeFile(srcDir, 'a.txt', 'content');
    const blobPath = path.join(outDir, 'huge-ft.blob');
    await packBlobToFile(srcDir, blobPath, createIgnoreFilter(srcDir));

    await writeFieldAt(blobPath, HUGE, 0x2e, 8); // file table length

    await expect(unpackBlobFromFile(blobPath, outDir)).rejects.toThrow(BfsError);
  });

  it('should reject an out-of-bounds file table length in parseBlobFileTableFromFile', async () => {
    await writeFile(srcDir, 'a.txt', 'content');
    const blobPath = path.join(outDir, 'huge-ft2.blob');
    await packBlobToFile(srcDir, blobPath, createIgnoreFilter(srcDir));

    await writeFieldAt(blobPath, HUGE, 0x2e, 8);

    await expect(parseBlobFileTableFromFile(blobPath)).rejects.toThrow(BfsError);
  });

  it('should reject a file count that cannot fit the file table', async () => {
    await writeFile(srcDir, 'a.txt', 'content');
    const blobPath = path.join(outDir, 'huge-count.blob');
    await packBlobToFile(srcDir, blobPath, createIgnoreFilter(srcDir));

    await writeFieldAt(blobPath, 0xffff_ffff, 0x22, 4); // file count

    await expect(parseBlobFileTableFromFile(blobPath)).rejects.toThrow(BfsError);
  });

  it('should reject an out-of-bounds data section length before allocating (compressed)', async () => {
    await writeFile(srcDir, 'a.txt', 'content');
    const blobPath = path.join(outDir, 'huge-data.blob');
    await packBlobToFileZipped(srcDir, blobPath, createIgnoreFilter(srcDir));

    const blob = await fs.readFile(blobPath);
    blob.writeBigUInt64LE(BigInt(HUGE), 0x3e); // data section length
    recomputeTrailingChecksum(blob); // pass the checksum so the alloc guard is what fires
    await fs.writeFile(blobPath, blob);

    await expect(unpackBlobFromFile(blobPath, outDir)).rejects.toThrow(BfsError);
  });
});
