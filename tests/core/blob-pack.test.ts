import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { packBlob } from '../../src/core/blob-pack.js';
import { parseBlobFileTable, unpackBlob } from '../../src/core/blob-unpack.js';
import { createIgnoreFilter } from '../../src/core/ignore.js';

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-test-'));
}

async function writeFile(
  dir: string,
  relPath: string,
  content: string | Buffer,
): Promise<void> {
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
    const blob = await packBlob(srcDir, filter);
    await unpackBlob(blob, outDir);
    const out = await fs.readFile(path.join(outDir, 'hello.txt'));
    expect(out.toString()).toBe('Hello, BFS!');
  });

  it('should roundtrip multiple files with identical content', async () => {
    await writeFile(srcDir, 'a.txt', 'file A');
    await writeFile(srcDir, 'b.txt', 'file B');
    await writeFile(srcDir, 'c.bin', Buffer.from([0x00, 0x01, 0x02, 0xff]));

    const filter = await createIgnoreFilter(srcDir);
    const blob = await packBlob(srcDir, filter);
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
    const blob = await packBlob(srcDir, filter);
    const entries = await unpackBlob(blob, outDir);
    expect(entries).toHaveLength(0);
  });

  it('should handle nested directories', async () => {
    await writeFile(srcDir, 'dir1/sub/deep.txt', 'deep content');
    await writeFile(srcDir, 'dir1/file.txt', 'shallow');
    await writeFile(srcDir, 'top.txt', 'top');

    const filter = await createIgnoreFilter(srcDir);
    const blob = await packBlob(srcDir, filter);
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
    const blob = await packBlob(srcDir, filter);
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
    const blob = await packBlob(srcDir, filter);
    await unpackBlob(blob, outDir);

    const out = await fs.readFile(path.join(outDir, 'large.bin'));
    expect(out.equals(large)).toBe(true);
  });

  it('should produce deterministic output for the same input', async () => {
    await writeFile(srcDir, 'b.txt', 'B');
    await writeFile(srcDir, 'a.txt', 'A');

    const filter = await createIgnoreFilter(srcDir);

    // Pack twice; timestamps differ, so we compare file table entries
    const blob1 = await packBlob(srcDir, filter);
    const blob2 = await packBlob(srcDir, filter);

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
    const blob = await packBlob(srcDir, filter);
    const entries = parseBlobFileTable(blob);

    expect(entries.map((e) => e.path)).toContain('keep.txt');
    expect(entries.map((e) => e.path)).not.toContain('Thumbs.db');
  });

  it('should throw on corrupted blob checksum', async () => {
    await writeFile(srcDir, 'file.txt', 'data');
    const filter = await createIgnoreFilter(srcDir);
    const blob = await packBlob(srcDir, filter);

    // Corrupt a byte in the middle
    blob[100] ^= 0xff;

    await expect(unpackBlob(blob, outDir)).rejects.toThrow('checksum');
  });

  it('should respect filter parameter in unpackBlob', async () => {
    await writeFile(srcDir, 'include.txt', 'yes');
    await writeFile(srcDir, 'exclude.txt', 'no');

    const filter = await createIgnoreFilter(srcDir);
    const blob = await packBlob(srcDir, filter);

    const extracted = await unpackBlob(
      blob,
      outDir,
      (e) => e.path === 'include.txt',
    );
    expect(extracted).toHaveLength(1);
    expect(extracted[0].path).toBe('include.txt');

    const outFiles = await readAllFiles(outDir);
    expect(outFiles.has('include.txt')).toBe(true);
    expect(outFiles.has('exclude.txt')).toBe(false);
  });
});
