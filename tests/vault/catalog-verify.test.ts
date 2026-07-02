import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it } from 'vitest';
import { createIgnoreFilter } from '../../src/core/ignore.js';
import type { CatalogSnapshot } from '../../src/types/index.js';
import { catalogHasDrift, diffCatalog, snapshotCatalog } from '../../src/vault/catalog-verify.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-catalog-'));
}

describe('snapshotCatalog', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await tmp();
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('should record the byte size of each file', async () => {
    await fs.writeFile(path.join(dir, 'a.txt'), 'hello'); // 5 bytes
    const filter = createIgnoreFilter(dir);

    const snap = await snapshotCatalog(dir, filter);

    const entry = snap.get('a.txt');
    assert(entry !== undefined, 'a.txt missing from snapshot');
    expect(entry.size).toBe(5);
  });

  it('should record the rounded mtimeMs of each file', async () => {
    const abs = path.join(dir, 'a.txt');
    await fs.writeFile(abs, 'hello');
    const filter = createIgnoreFilter(dir);

    const snap = await snapshotCatalog(dir, filter);

    const entry = snap.get('a.txt');
    assert(entry !== undefined, 'a.txt missing from snapshot');
    const stat = await fs.stat(abs);
    expect(entry.mtimeMs).toBe(Math.round(stat.mtimeMs));
  });

  it('should exclude files matched by .bfsignore', async () => {
    await fs.writeFile(path.join(dir, 'keep.txt'), 'keep');
    await fs.writeFile(path.join(dir, 'skip.log'), 'skip');
    await fs.writeFile(path.join(dir, '.bfsignore'), '*.log\n');
    const filter = createIgnoreFilter(dir);

    const snap = await snapshotCatalog(dir, filter);

    expect(snap.has('keep.txt')).toBe(true);
    expect(snap.has('skip.log')).toBe(false);
  });

  it('should use forward-slash keys for files in subdirectories', async () => {
    await fs.mkdir(path.join(dir, 'sub', 'deep'), { recursive: true });
    await fs.writeFile(path.join(dir, 'sub', 'deep', 'nested.txt'), 'x');
    const filter = createIgnoreFilter(dir);

    const snap = await snapshotCatalog(dir, filter);

    expect(snap.has('sub/deep/nested.txt')).toBe(true);
  });
});

describe('diffCatalog', () => {
  it('should report a file with a changed size as changed', () => {
    const before: CatalogSnapshot = new Map([['a.txt', { size: 10, mtimeMs: 100 }]]);
    const after: CatalogSnapshot = new Map([['a.txt', { size: 20, mtimeMs: 100 }]]);

    const drift = diffCatalog(before, after);

    expect(drift.changed).toEqual(['a.txt']);
    expect(drift.vanished).toEqual([]);
    expect(drift.appeared).toEqual([]);
  });

  it('should report a file with a changed mtimeMs as changed', () => {
    const before: CatalogSnapshot = new Map([['a.txt', { size: 10, mtimeMs: 100 }]]);
    const after: CatalogSnapshot = new Map([['a.txt', { size: 10, mtimeMs: 200 }]]);

    const drift = diffCatalog(before, after);

    expect(drift.changed).toEqual(['a.txt']);
    expect(drift.vanished).toEqual([]);
    expect(drift.appeared).toEqual([]);
  });

  it('should report a removed file as vanished', () => {
    const before: CatalogSnapshot = new Map([['a.txt', { size: 10, mtimeMs: 100 }]]);
    const after: CatalogSnapshot = new Map();

    const drift = diffCatalog(before, after);

    expect(drift.vanished).toEqual(['a.txt']);
    expect(drift.changed).toEqual([]);
    expect(drift.appeared).toEqual([]);
  });

  it('should report a new file as appeared', () => {
    const before: CatalogSnapshot = new Map();
    const after: CatalogSnapshot = new Map([['a.txt', { size: 10, mtimeMs: 100 }]]);

    const drift = diffCatalog(before, after);

    expect(drift.appeared).toEqual(['a.txt']);
    expect(drift.changed).toEqual([]);
    expect(drift.vanished).toEqual([]);
  });

  it('should omit excluded paths from every bucket', () => {
    const before: CatalogSnapshot = new Map([
      ['changed.txt', { size: 10, mtimeMs: 100 }],
      ['gone.txt', { size: 5, mtimeMs: 50 }],
    ]);
    const after: CatalogSnapshot = new Map([
      ['changed.txt', { size: 20, mtimeMs: 100 }],
      ['new.txt', { size: 7, mtimeMs: 70 }],
    ]);
    const exclude = new Set(['changed.txt', 'gone.txt', 'new.txt']);

    const drift = diffCatalog(before, after, exclude);

    expect(drift.changed).toEqual([]);
    expect(drift.vanished).toEqual([]);
    expect(drift.appeared).toEqual([]);
  });

  it('should report no drift for identical snapshots', () => {
    const before: CatalogSnapshot = new Map([['a.txt', { size: 10, mtimeMs: 100 }]]);
    const after: CatalogSnapshot = new Map([['a.txt', { size: 10, mtimeMs: 100 }]]);

    const drift = diffCatalog(before, after);

    expect(drift.changed).toEqual([]);
    expect(drift.vanished).toEqual([]);
    expect(drift.appeared).toEqual([]);
  });
});

describe('catalogHasDrift', () => {
  it('should return true when a file changed', () => {
    expect(catalogHasDrift({ changed: ['a.txt'], vanished: [], appeared: [] })).toBe(true);
  });

  it('should return true when a file vanished', () => {
    expect(catalogHasDrift({ changed: [], vanished: ['a.txt'], appeared: [] })).toBe(true);
  });

  it('should return true when a file appeared', () => {
    expect(catalogHasDrift({ changed: [], vanished: [], appeared: ['a.txt'] })).toBe(true);
  });

  it('should return false when every bucket is empty', () => {
    expect(catalogHasDrift({ changed: [], vanished: [], appeared: [] })).toBe(false);
  });
});
