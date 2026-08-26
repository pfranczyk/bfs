/**
 * Default `temp_dir` = os.tmpdir(), not the backup's cache directory.
 *
 * `bfs config` prints "(default: system temp)" and the JSDoc of
 * `VaultConfig.temp_dir` promises os.tmpdir(); push and pull must honour that:
 * scratch data (parity parts, downloaded parts) lives in a `bfs-push-*` /
 * `bfs-pull-*` directory created with fs.mkdtemp under os.tmpdir(), is removed
 * when the operation ends (success or failure), and never lands in `.bfs/cache`.
 * An explicit `temp_dir` in config still wins.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-tempdir-test-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function mockIO(): ProviderIO {
  return createMockProviderIO().io;
}

async function exists(p: string): Promise<boolean> {
  return fs
    .stat(p)
    .then(() => true)
    .catch(() => false);
}

/** Names under `.bfs/cache` that look like scratch data of push or pull. */
async function scratchInCache(root: string): Promise<string[]> {
  const cache = path.join(root, '.bfs', 'cache');
  const names = await fs.readdir(cache).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith('bfs-parity-') || n.startsWith('pull-v2-') || n.startsWith('bfs-push-') || n.startsWith('bfs-pull-'));
}

/**
 * Records every directory `fs.mkdtemp` hands out during the test, so the test
 * can assert where BFS put its scratch space and that it cleaned it up.
 */
function trackMkdtemp(): string[] {
  const created: string[] = [];
  const original = fs.mkdtemp;
  vi.spyOn(fs, 'mkdtemp').mockImplementation(async (prefix, options) => {
    const dir = await original(prefix as string, options as never);
    created.push(String(dir));
    return dir as never;
  });
  return created;
}

describe('temp_dir default - push and pull scratch under os.tmpdir()', () => {
  let root: string;
  let pdirs: string[];
  const tmpRoot = path.resolve(os.tmpdir());

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'tempdir-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'hello temp dir '.repeat(200));
    await fs.writeFile(path.join(root, 'b.bin'), Buffer.alloc(4096, 7));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should write push parity parts to a bfs-push-* directory under os.tmpdir() and remove it afterwards', async () => {
    const created = trackMkdtemp();
    const seenDuringUpload: boolean[] = [];
    const cacheDuringUpload: string[][] = [];
    const origUpload = LocalFsProvider.prototype.upload;
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args) {
      cacheDuringUpload.push(await scratchInCache(root));
      const dir = created.find((d) => path.basename(d).startsWith('bfs-push-'));
      seenDuringUpload.push(dir !== undefined && (await exists(dir)));
      return origUpload.apply(this, args);
    });

    await push(root, { io: mockIO() });

    expect(cacheDuringUpload.flat(), 'parity parts must not be written to .bfs/cache').toEqual([]);

    const pushDirs = created.filter((d) => path.basename(d).startsWith('bfs-push-'));
    expect(pushDirs, 'push must create exactly one bfs-push-* scratch directory').toHaveLength(1);
    const pushDir = pushDirs[0];
    assert(pushDir !== undefined);
    expect(path.resolve(path.dirname(pushDir))).toBe(tmpRoot);
    expect(seenDuringUpload.length).toBeGreaterThan(0);
    expect(seenDuringUpload.every(Boolean), 'scratch dir must exist while parts are uploaded').toBe(true);
    expect(await exists(pushDir), 'scratch dir must be removed after push').toBe(false);
    expect(await scratchInCache(root)).toEqual([]);
  });

  it('should remove the bfs-push-* directory when the upload fails', async () => {
    const created = trackMkdtemp();
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockRejectedValue(new Error('disk on fire'));

    await push(root, { io: mockIO() }).catch(() => undefined);

    const pushDirs = created.filter((d) => path.basename(d).startsWith('bfs-push-'));
    expect(pushDirs).toHaveLength(1);
    const pushDir = pushDirs[0];
    assert(pushDir !== undefined);
    expect(await exists(pushDir), 'scratch dir must be removed even when push fails').toBe(false);
    expect(await scratchInCache(root)).toEqual([]);
  });

  it('should download pull parts into a bfs-pull-* directory under os.tmpdir() and remove it afterwards', async () => {
    await push(root, { io: mockIO() });
    const created = trackMkdtemp();
    const seenDuringDownload: boolean[] = [];
    const cacheDuringDownload: string[][] = [];
    const origDownload = LocalFsProvider.prototype.download;
    vi.spyOn(LocalFsProvider.prototype, 'download').mockImplementation(async function (this: LocalFsProvider, ...args) {
      cacheDuringDownload.push(await scratchInCache(root));
      const dir = created.find((d) => path.basename(d).startsWith('bfs-pull-'));
      seenDuringDownload.push(dir !== undefined && (await exists(dir)));
      return origDownload.apply(this, args);
    });

    await pull(root, { io: mockIO(), force: true });

    expect(cacheDuringDownload.flat(), 'downloaded parts must not be written to .bfs/cache').toEqual([]);

    const pullDirs = created.filter((d) => path.basename(d).startsWith('bfs-pull-'));
    expect(pullDirs, 'pull must create exactly one bfs-pull-* scratch directory').toHaveLength(1);
    const pullDir = pullDirs[0];
    assert(pullDir !== undefined);
    expect(path.resolve(path.dirname(pullDir))).toBe(tmpRoot);
    expect(seenDuringDownload.length).toBeGreaterThan(0);
    expect(seenDuringDownload.every(Boolean), 'scratch dir must exist while parts are downloaded').toBe(true);
    expect(await exists(pullDir), 'scratch dir must be removed after pull').toBe(false);
    expect(await scratchInCache(root)).toEqual([]);
  });

  it('should honour config.temp_dir for push and pull', async () => {
    const custom = await tmp();
    try {
      const config = await readConfig(root);
      assert(config !== null, 'fixture vault must have a config');
      await writeConfig(root, { ...config, temp_dir: custom });
      const created = trackMkdtemp();

      await push(root, { io: mockIO() });
      await pull(root, { io: mockIO(), force: true });

      const scratch = created.filter((d) => /^bfs-(push|pull)-/.test(path.basename(d)));
      expect(scratch.map((d) => path.basename(d).slice(0, 9))).toEqual(['bfs-push-', 'bfs-pull-']);
      for (const d of scratch) expect(path.resolve(path.dirname(d))).toBe(path.resolve(custom));
      expect(await fs.readdir(custom), 'explicit temp_dir must be left empty afterwards').toEqual([]);
    } finally {
      await fs.rm(custom, { recursive: true, force: true });
    }
  });

  it('should create a configured temp_dir whose parent exists but the leaf does not yet', async () => {
    // `bfs config --temp-dir` accepts a not-yet-existing leaf (only the parent
    // is validated), so push and pull must create it rather than fail on it.
    const parent = await tmp();
    const custom = path.join(parent, 'scratch');
    try {
      const config = await readConfig(root);
      assert(config !== null, 'fixture vault must have a config');
      await writeConfig(root, { ...config, temp_dir: custom });
      const created = trackMkdtemp();

      await push(root, { io: mockIO() });
      await pull(root, { io: mockIO(), force: true });

      const scratch = created.filter((d) => /^bfs-(push|pull)-/.test(path.basename(d)));
      expect(scratch.map((d) => path.basename(d).slice(0, 9))).toEqual(['bfs-push-', 'bfs-pull-']);
      for (const d of scratch) expect(path.resolve(path.dirname(d))).toBe(path.resolve(custom));
    } finally {
      await fs.rm(parent, { recursive: true, force: true });
    }
  });

  it('should honour the --temp-dir option over config and the default', async () => {
    const custom = await tmp();
    try {
      const created = trackMkdtemp();

      await push(root, { io: mockIO(), tempDir: custom });
      await pull(root, { io: mockIO(), force: true, tempDir: custom });

      const scratch = created.filter((d) => /^bfs-(push|pull)-/.test(path.basename(d)));
      expect(scratch.map((d) => path.basename(d).slice(0, 9))).toEqual(['bfs-push-', 'bfs-pull-']);
      for (const d of scratch) expect(path.resolve(path.dirname(d))).toBe(path.resolve(custom));
      expect(await fs.readdir(custom), '--temp-dir directory must be left empty afterwards').toEqual([]);
    } finally {
      await fs.rm(custom, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('should create the scratch directory with mode 0700', async () => {
    const created = trackMkdtemp();
    const modes: number[] = [];
    const origUpload = LocalFsProvider.prototype.upload;
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args) {
      const dir = created.find((d) => path.basename(d).startsWith('bfs-push-'));
      if (dir) modes.push((await fs.stat(dir)).mode & 0o777);
      return origUpload.apply(this, args);
    });

    await push(root, { io: mockIO() });

    expect(modes.length).toBeGreaterThan(0);
    expect(
      modes.every((m) => m === 0o700),
      'scratch dir under a shared /tmp must be private',
    ).toBe(true);
  });
});
