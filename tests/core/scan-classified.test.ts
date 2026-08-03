import type { Dirent } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanDirClassified } from '../../src/core/blob-pack.js';

// Deterministic, OS-independent scan test: symlinks and special files behave
// differently across Windows/POSIX and need admin rights to create on Windows,
// so we mock fs.readdir to return controlled Dirent objects instead. This makes
// the classification assertion identical on Win11/Win2025/Ubuntu.
type EntryKind = 'file' | 'dir' | 'symlink' | 'socket' | 'fifo' | 'device';
const scanState = vi.hoisted(() => ({ tree: new Map<string, Array<{ name: string; kind: EntryKind }>>() }));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const makeDirent = (name: string, kind: EntryKind): Dirent =>
    ({
      name,
      isFile: () => kind === 'file',
      isDirectory: () => kind === 'dir',
      isSymbolicLink: () => kind === 'symlink',
      isSocket: () => kind === 'socket',
      isFIFO: () => kind === 'fifo',
      isBlockDevice: () => kind === 'device',
      isCharacterDevice: () => false,
    }) as unknown as Dirent;
  const readdir = (async (dir: unknown, opts?: unknown) => {
    const key = String(dir);
    const withTypes = typeof opts === 'object' && opts !== null && (opts as { withFileTypes?: boolean }).withFileTypes === true;
    if (withTypes && scanState.tree.has(key)) {
      return scanState.tree.get(key)?.map((e) => makeDirent(e.name, e.kind)) ?? [];
    }
    return (actual.readdir as (d: unknown, o?: unknown) => Promise<unknown>)(dir, opts);
  }) as typeof actual.readdir;
  return { ...actual, readdir };
});

describe('scanDirClassified', () => {
  const root = join('bfs-scan-root');

  afterEach(() => {
    scanState.tree.clear();
    vi.restoreAllMocks();
  });

  it('should classify symlinks and special files into excluded, keeping regular files', async () => {
    scanState.tree.set(root, [
      { name: 'sub', kind: 'dir' },
      { name: 'toplink', kind: 'symlink' },
      { name: 'top.txt', kind: 'file' },
    ]);
    scanState.tree.set(join(root, 'sub'), [
      { name: 'a.txt', kind: 'file' },
      { name: 'sock0', kind: 'socket' },
    ]);

    const { files, excluded } = await scanDirClassified(root, () => false);

    expect(files.map((f) => f.relativePath).sort()).toEqual(['sub/a.txt', 'top.txt']);
    expect(excluded).toContainEqual({ path: 'toplink', reason: 'symlink' });
    expect(excluded).toContainEqual({ path: 'sub/sock0', reason: 'special' });
    expect(excluded).toHaveLength(2);
  });

  it('should classify FIFO and block-device entries as special (not just sockets)', async () => {
    scanState.tree.set(root, [
      { name: 'pipe', kind: 'fifo' },
      { name: 'disk0', kind: 'device' },
      { name: 'ok.txt', kind: 'file' },
    ]);

    const { files, excluded } = await scanDirClassified(root, () => false);

    expect(files.map((f) => f.relativePath)).toEqual(['ok.txt']);
    expect(excluded).toContainEqual({ path: 'pipe', reason: 'special' });
    expect(excluded).toContainEqual({ path: 'disk0', reason: 'special' });
    expect(excluded).toHaveLength(2);
  });

  it('should respect the ignore filter for excluded entries too', async () => {
    scanState.tree.set(root, [
      { name: 'keep.txt', kind: 'file' },
      { name: 'ignored-link', kind: 'symlink' },
    ]);

    const { files, excluded } = await scanDirClassified(root, (rel) => rel === 'ignored-link');

    expect(files.map((f) => f.relativePath)).toEqual(['keep.txt']);
    expect(excluded).toHaveLength(0);
  });
});
