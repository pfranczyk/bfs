import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderError, PullSkippedError, PushCacheNoLockError, PushCacheUnavailableError } from '../../src/core/errors.js';
import { DEFAULT_BFSIGNORE_CONTENT } from '../../src/core/ignore-defaults.js';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { type PushLock, pushLockPath, readLock } from '../../src/vault/lockfile.js';
import { listManifests, readManifest, writeManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';
import { readState } from '../../src/vault/state.js';
import { _classifyUploadError, init, listVersions, prune, pull, push, removeProvider } from '../../src/vault/vault-manager.js';
import { verifyAll } from '../../src/vault/verify.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-vault-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function mockIO(answers: Record<string, string> = {}): ProviderIO {
  return createMockProviderIO(answers).io;
}

async function createTestFiles(dir: string): Promise<void> {
  await fs.writeFile(path.join(dir, 'hello.txt'), 'Hello, World!', 'utf-8');
  await fs.mkdir(path.join(dir, 'subdir'), { recursive: true });
  await fs.writeFile(path.join(dir, 'subdir', 'nested.txt'), 'Nested content', 'utf-8');
}

async function listUserFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function scan(d: string, prefix: string): Promise<void> {
    const entries = await fs.readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === '.bfs' || e.name === '.bfsignore') continue;
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) await scan(path.join(d, e.name), rel);
      else results.push(rel);
    }
  }
  await scan(dir, '');
  return results.sort();
}

// ─── init ─────────────────────────────────────────────────────────────────────

describe('init', () => {
  let root: string;
  let dirs: string[];

  beforeEach(async () => {
    root = await tmp();
    dirs = [await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...dirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should create .bfs/ and .bfs/manifests/', async () => {
    await init(root, {
      vault_name: 'v',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await expect(fs.access(path.join(root, '.bfs'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(root, '.bfs', 'manifests'))).resolves.toBeUndefined();
  });

  // POSIX-only: .bfs/ holds config.json (provider secrets) and cached plaintext
  // blobs, so the directory must be owner-only. Windows NTFS ignores POSIX mode
  // bits, so the assertion would be a false signal there.
  it.skipIf(process.platform === 'win32')('should create .bfs/ with 0700 permissions', async () => {
    await init(root, {
      vault_name: 'v',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });

    const stat = await fs.stat(path.join(root, '.bfs'));
    expect(stat.mode & 0o777).toBe(0o700);
  });

  it('should write config.json with correct vault_name and scheme', async () => {
    await init(root, {
      vault_name: 'my-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    const config = await readConfig(root);
    expect(config?.vault_name).toBe('my-vault');
    expect(config?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
    expect(config?.vault_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('should throw when providers.length !== N+K', async () => {
    await expect(
      init(root, {
        vault_name: 'v',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
        providers: [localProvider('p0', dirs[0] ?? ''), localProvider('p1', dirs[1] ?? '')], // 2, needs 3
        push_mode: PushMode.NewVersion,
        io: mockIO(),
      }),
    ).rejects.toThrow();
  });

  it('should NOT write config.json when provider type is unknown', async () => {
    const badProvider: ProviderConfig = { id: 'bad', type: 'unknown-type', adapterPackage: null, config: {} };
    await expect(
      init(root, {
        vault_name: 'v',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
        providers: [badProvider, badProvider, badProvider],
        push_mode: PushMode.NewVersion,
        io: mockIO(),
      }),
    ).rejects.toThrow(/Unknown provider type/);

    // Config must NOT have been written — the fix ensures validation precedes writeConfig
    const config = await readConfig(root);
    expect(config).toBeNull();
  });

  it('should create .bfsignore with default content when file does not exist', async () => {
    await init(root, {
      vault_name: 'v',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    const content = await fs.readFile(path.join(root, '.bfsignore'), 'utf-8');
    expect(content).toBe(DEFAULT_BFSIGNORE_CONTENT);
  });

  it('should NOT overwrite .bfsignore if it already exists', async () => {
    const bfsignorePath = path.join(root, '.bfsignore');
    await fs.writeFile(bfsignorePath, 'custom content', 'utf-8');
    await init(root, {
      vault_name: 'v',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: dirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    const content = await fs.readFile(bfsignorePath, 'utf-8');
    expect(content).toBe('custom content');
  });
});

// ─── push ─────────────────────────────────────────────────────────────────────

describe('push', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should create manifest v001.json after first push', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    const m = await readManifest(root, 1);
    expect(m).not.toBeNull();
    expect(m?.version).toBe(1);
    expect(m?.health).toBe('healthy');
    expect(m?.file_count).toBeGreaterThanOrEqual(2); // hello.txt + subdir/nested.txt (+ .bfsignore if default was copied)
  });

  it('push × 2 → listVersions returns 2 manifests', async () => {
    await createTestFiles(root);
    const io = mockIO();
    await push(root, { io });
    await push(root, { io });
    const versions = await listVersions(root);
    expect(versions).toHaveLength(2);
    expect(versions[0]?.version).toBe(1);
    expect(versions[1]?.version).toBe(2);
  });

  it('should update state.json after push', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    const state = await readState(root);
    expect(state.latest_version).toBe(1);
    expect(state.working_version).toBe(1);
  });

  // POSIX-only: state.json and manifests carry backup metadata (incl. the
  // provider coordinates in each manifest), and .bfs/cache/ holds transient
  // plaintext during a push — all owner-only. Windows NTFS ignores POSIX mode
  // bits, so the assertion would be a false signal there.
  it.skipIf(process.platform === 'win32')('should write state.json + manifest 0600 and cache dir 0700 after push', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    const stateStat = await fs.stat(path.join(root, '.bfs', 'state.json'));
    expect(stateStat.mode & 0o777).toBe(0o600);
    const manifestStat = await fs.stat(path.join(root, '.bfs', 'manifests', 'v001.json'));
    expect(manifestStat.mode & 0o777).toBe(0o600);
    const cacheStat = await fs.stat(path.join(root, '.bfs', 'cache'));
    expect(cacheStat.mode & 0o777).toBe(0o700);
  });

  it('should upload shard files to each provider', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    for (let i = 0; i < pdirs.length; i++) {
      const pdir = pdirs[i] ?? '';
      const files = await fs.readdir(path.join(pdir, 'vault'));
      expect(files).toContain(`shard_${i}.bfs.1`);
    }
  });

  it('push → prune → manifest deleted from disk', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });
    await prune(root, { versions: [1] });
    expect(await readManifest(root, 1)).toBeNull();
  });

  it('should throw human-readable error when scheme.data_shards is null', async () => {
    // Simulate a corrupted .bfs/config.json produced by a buggy init.
    const cfg = await readConfig(root);
    if (!cfg) throw new Error('test setup: config missing');
    await writeConfig(root, { ...cfg, scheme: { data_shards: null as unknown as number, parity_shards: null as unknown as number } });
    await createTestFiles(root);

    await expect(push(root, { io: mockIO() })).rejects.toThrow(/data_shards must be/);
  });

  it('should reject corrupted scheme BEFORE reaching Reed-Solomon encoder', async () => {
    // The technical RS message ("dataShards must be >= 2, got null") must NOT
    // surface — the user gets a scheme-level message with remediation hint.
    const cfg = await readConfig(root);
    if (!cfg) throw new Error('test setup: config missing');
    await writeConfig(root, { ...cfg, scheme: { data_shards: null as unknown as number, parity_shards: 1 } });
    await createTestFiles(root);

    await expect(push(root, { io: mockIO() })).rejects.toThrow(/bfs scheme set/);
  });
});

// ─── push — partial commit ───────────────────────────────────────────────────
// Verifies that shard upload failures are captured per-shard in .bfs/push.lock
// and the manifest is written with whichever shards succeeded (health derived
// from uploaded count vs N+K). Pre-existing happy-path tests above stay green.

describe('push — partial commit', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should remove push.lock and cached blob on full success', async () => {
    const result = await push(root, { io: mockIO() });

    expect(result.health).toBe(VersionHealth.Healthy);
    expect(result.uploaded_count).toBe(3);
    expect(result.failed).toEqual([]);
    expect(existsSync(pushLockPath(root))).toBe(false);
    expect(existsSync(path.join(root, '.bfs', 'cache', 'push.blob.pending'))).toBe(false);

    const manifest = await readManifest(root, 1);
    expect(manifest?.shards).toHaveLength(3);
    expect(manifest?.health).toBe(VersionHealth.Healthy);
  });

  it('should commit partial manifest when one provider fails (degraded)', async () => {
    const original = LocalFsProvider.prototype.upload;
    let n = 0;
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args: Parameters<typeof original>) {
      n++;
      if (n === 3) throw new ProviderError('Simulated 530 Login incorrect');
      return original.apply(this, args);
    });

    const result = await push(root, { io: mockIO() });

    expect(result.health).toBe(VersionHealth.Degraded);
    expect(result.uploaded_count).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.reason).toBe('auth_failed');

    const manifest = await readManifest(root, 1);
    expect(manifest?.shards).toHaveLength(2);
    expect(manifest?.health).toBe(VersionHealth.Degraded);

    const state = await readState(root);
    expect(state.latest_version).toBe(1);

    const lock = await readLock<PushLock>(pushLockPath(root));
    expect(lock?.failed).toHaveLength(1);
    expect(lock?.uploaded).toHaveLength(2);
  });

  it('should mark version damaged when uploaded count is below data_shards', async () => {
    // Switch vault to scheme 3/2 (5 providers) so we can fail 3 and uploaded < N.
    const extraDirs = [await tmp(), await tmp()];
    pdirs.push(...extraDirs);
    const cfg = await readConfig(root);
    if (!cfg) throw new Error('test setup: config missing');
    await writeConfig(root, { ...cfg, scheme: { data_shards: 3, parity_shards: 2 }, providers: pdirs.map((d, i) => localProvider(`p${i}`, d)) });

    const original = LocalFsProvider.prototype.upload;
    let n = 0;
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args: Parameters<typeof original>) {
      n++;
      if (n >= 3) throw new ProviderError('Simulated network failure');
      return original.apply(this, args);
    });

    const result = await push(root, { io: mockIO() });

    expect(result.health).toBe(VersionHealth.Damaged);
    expect(result.uploaded_count).toBe(2);
    expect(result.failed).toHaveLength(3);

    const manifest = await readManifest(root, 1);
    expect(manifest?.shards).toHaveLength(2);
    expect(manifest?.health).toBe(VersionHealth.Damaged);

    const state = await readState(root);
    expect(state.latest_version).toBe(1);

    expect(existsSync(pushLockPath(root))).toBe(true);
  });

  it('should throw BfsError and keep state unchanged when zero shards uploaded', async () => {
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async () => {
      throw new ProviderError('Simulated total outage');
    });

    await expect(push(root, { io: mockIO() })).rejects.toThrow(/no storage pieces uploaded/);

    const state = await readState(root);
    expect(state.latest_version).toBe(0);

    // Manifest must NOT be written for zero-upload runs.
    expect(await readManifest(root, 1)).toBeNull();
    // Lock retained for forensic analysis.
    expect(existsSync(pushLockPath(root))).toBe(true);
  });

  it('should throw PushCacheNoLockError when --cache used without push.lock', async () => {
    await expect(push(root, { io: mockIO(), fromCache: true })).rejects.toThrow(PushCacheNoLockError);
  });

  it('should throw PushCacheNoLockError when lock points at a missing cache blob', async () => {
    // Arrange: lock present, blob_pending_path set to a path that does NOT
    // exist on disk (e.g. user wiped .bfs/cache between attempts).
    const cacheDir = path.join(root, '.bfs', 'cache');
    const cachePath = path.join(cacheDir, 'push.blob.pending');
    const lockDir = path.join(root, '.bfs');
    await fs.mkdir(lockDir, { recursive: true });
    const lock: PushLock = {
      format_version: 1,
      operation: 'push',
      version: 1,
      pid: process.pid,
      command: 'bfs push',
      started_at: new Date().toISOString(),
      scheme: { data_shards: 2, parity_shards: 1 },
      uploaded: [],
      failed: [],
      blob_pending_path: cachePath,
    };
    await fs.writeFile(pushLockPath(root), JSON.stringify(lock));

    await expect(push(root, { io: mockIO(), fromCache: true })).rejects.toThrow(PushCacheNoLockError);
  });

  it('should persist RAM-path blob to cache on first upload failure', async () => {
    // Force RAM pack path (small fixture + no compression). Then make one
    // upload fail so the emergency dump kicks in. After push, cache must be
    // on disk and the lock must point at it — exactly the state that makes
    // `bfs push --cache --overwrite` resume cleanly.
    const cfg = await readConfig(root);
    if (!cfg) throw new Error('test setup: config missing');
    await writeConfig(root, { ...cfg, compression: { enabled: false, algorithm: 'deflate' } });

    const original = LocalFsProvider.prototype.upload;
    let n = 0;
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args: Parameters<typeof original>) {
      n++;
      if (n === 3) throw new ProviderError('Simulated outage on last shard');
      return original.apply(this, args);
    });

    const result = await push(root, { io: mockIO() });

    expect(result.health).toBe(VersionHealth.Degraded);

    const cachePath = path.join(root, '.bfs', 'cache', 'push.blob.pending');
    expect(existsSync(cachePath)).toBe(true);

    const lock = await readLock<PushLock>(pushLockPath(root));
    expect(lock?.blob_pending_path).toBe(cachePath);
  });

  it('should set blob_pending_path=null when emergency cache write fails', async () => {
    // RAM pack path again, plus fs.writeFile mocked to reject for cachePath.
    // This exercises the "even the safety net is gone" branch — lock must
    // explicitly record that resume is impossible (null) instead of leaving
    // a dangling string that misleads `bfs push --cache`.
    const cfg = await readConfig(root);
    if (!cfg) throw new Error('test setup: config missing');
    await writeConfig(root, { ...cfg, compression: { enabled: false, algorithm: 'deflate' } });

    const cachePath = path.join(root, '.bfs', 'cache', 'push.blob.pending');
    const originalWriteFile = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (file: Parameters<typeof fs.writeFile>[0], data: Parameters<typeof fs.writeFile>[1], options?: Parameters<typeof fs.writeFile>[2]) => {
      if (file === cachePath) {
        const err = Object.assign(new Error('no space left'), { code: 'ENOSPC' });
        throw err;
      }
      return originalWriteFile(file, data, options);
    });

    const originalUpload = LocalFsProvider.prototype.upload;
    let n = 0;
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args: Parameters<typeof originalUpload>) {
      n++;
      if (n === 3) throw new ProviderError('Simulated outage on last shard');
      return originalUpload.apply(this, args);
    });

    const { io, logs } = createMockProviderIO();
    const result = await push(root, { io });

    expect(result.health).toBe(VersionHealth.Degraded);
    expect(existsSync(cachePath)).toBe(false);

    const lock = await readLock<PushLock>(pushLockPath(root));
    expect(lock?.blob_pending_path).toBeNull();

    const warnedAboutCache = logs.some((e) => e.level === 'warn' && /cache write failed/i.test(e.message));
    expect(warnedAboutCache).toBe(true);
  });

  it('should throw PushCacheUnavailableError when --cache used and lock has blob_pending_path=null', async () => {
    const lockDir = path.join(root, '.bfs');
    await fs.mkdir(lockDir, { recursive: true });
    const lock: PushLock = {
      format_version: 1,
      operation: 'push',
      version: 1,
      pid: process.pid,
      command: 'bfs push',
      started_at: new Date().toISOString(),
      scheme: { data_shards: 2, parity_shards: 1 },
      uploaded: [],
      failed: [],
      blob_pending_path: null,
    };
    await fs.writeFile(pushLockPath(root), JSON.stringify(lock));

    await expect(push(root, { io: mockIO(), fromCache: true })).rejects.toThrow(PushCacheUnavailableError);
  });

  it('should reset uploaded/failed arrays on --cache retry', async () => {
    // Arrange: simulate a previous partial-state push by manually creating
    // both lock (with stale uploaded entries) and a cached blob.
    const cacheDir = path.join(root, '.bfs', 'cache');
    await fs.mkdir(cacheDir, { recursive: true });
    const cachePath = path.join(cacheDir, 'push.blob.pending');

    // Real cached blob: run a normal push first, then move the result back
    // into the cache (we just need any valid blob so packing is skipped).
    await push(root, { io: mockIO() });
    // After the first push, blob was cleaned up. Re-pack a tiny blob via push
    // by failing partway, which leaves the blob in cache.
    const original = LocalFsProvider.prototype.upload;
    let n = 0;
    const spy = vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args: Parameters<typeof original>) {
      n++;
      if (n >= 2) throw new ProviderError('Simulated outage');
      return original.apply(this, args);
    });
    // Trigger a partial push to leave lock + cached blob behind.
    await push(root, { io: mockIO() }).catch(() => {});
    spy.mockRestore();

    expect(existsSync(pushLockPath(root))).toBe(true);
    expect(existsSync(cachePath)).toBe(true);

    const lockBefore = await readLock<PushLock>(pushLockPath(root));
    expect((lockBefore?.uploaded.length ?? 0) + (lockBefore?.failed.length ?? 0)).toBeGreaterThan(0);

    // Act: retry with --cache. All providers OK this time.
    const result = await push(root, { io: mockIO(), fromCache: true });

    // Assert: full success → lock removed, blob removed, healthy.
    expect(result.health).toBe(VersionHealth.Healthy);
    expect(existsSync(pushLockPath(root))).toBe(false);
    expect(existsSync(cachePath)).toBe(false);
  });
});

// ─── _classifyUploadError unit tests ─────────────────────────────────────────

describe('_classifyUploadError', () => {
  it('should classify ProviderError with auth keywords as auth_failed', () => {
    const result = _classifyUploadError(new ProviderError('530 Login incorrect — bad password'));

    expect(result.reason).toBe('auth_failed');
    expect(result.detail).toContain('530');
  });

  it('should classify ENOENT as not_found', () => {
    const err = Object.assign(new Error('file missing'), { code: 'ENOENT' });
    const result = _classifyUploadError(err);

    expect(result.reason).toBe('not_found');
  });

  it('should classify ECONNREFUSED as network_error', () => {
    const err = Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const result = _classifyUploadError(err);

    expect(result.reason).toBe('network_error');
  });

  it('should classify ETIMEDOUT as network_error', () => {
    const err = Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' });
    const result = _classifyUploadError(err);

    expect(result.reason).toBe('network_error');
  });

  it('should classify EDQUOT as quota_exceeded', () => {
    const err = Object.assign(new Error('quota'), { code: 'EDQUOT' });
    const result = _classifyUploadError(err);

    expect(result.reason).toBe('quota_exceeded');
  });

  it('should classify ENOSPC as quota_exceeded', () => {
    const err = Object.assign(new Error('disk full'), { code: 'ENOSPC' });
    const result = _classifyUploadError(err);

    expect(result.reason).toBe('quota_exceeded');
  });

  it('should default to unknown for unrecognized errors', () => {
    const result = _classifyUploadError(new Error('something weird'));

    expect(result.reason).toBe('unknown');
    expect(result.detail).toBe('something weird');
  });

  it('should default to unknown for non-Error throw values', () => {
    const result = _classifyUploadError('bare string thrown');

    expect(result.reason).toBe('unknown');
    expect(result.detail).toBe('bare string thrown');
  });
});

// ─── pull (roundtrip) ─────────────────────────────────────────────────────────

describe('pull (roundtrip)', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should restore identical files after push → delete → pull', async () => {
    await createTestFiles(root);
    const before = await listUserFiles(root);
    await push(root, { io: mockIO() });

    // Simulate data loss
    await fs.rm(path.join(root, 'hello.txt'));
    await fs.rm(path.join(root, 'subdir'), { recursive: true });

    await pull(root, { io: mockIO(), force: true });

    const after = await listUserFiles(root);
    expect(after).toEqual(before);
    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe('Hello, World!');
    expect(await fs.readFile(path.join(root, 'subdir', 'nested.txt'), 'utf-8')).toBe('Nested content');
  });

  it('should pull specific version (--version)', async () => {
    await createTestFiles(root);
    const io = mockIO();
    await push(root, { io }); // v1: hello.txt = "Hello, World!"
    await fs.writeFile(path.join(root, 'hello.txt'), 'Modified v2', 'utf-8');
    await push(root, { io }); // v2

    await pull(root, { version: 1, io, force: true });
    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe('Hello, World!');
    const state = await readState(root);
    expect(state.working_version).toBe(1);
    expect(state.latest_version).toBe(2);
  });

  it('should pull into a new directory (copied .bfs/)', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    const root2 = await tmp();
    try {
      await fs.cp(path.join(root, '.bfs'), path.join(root2, '.bfs'), { recursive: true });
      await pull(root2, { io: mockIO(), force: true });
      expect(await fs.readFile(path.join(root2, 'hello.txt'), 'utf-8')).toBe('Hello, World!');
    } finally {
      await fs.rm(root2, { recursive: true, force: true });
    }
  });

  it('should tolerate 1 missing shard (K=1 RS repair)', async () => {
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Delete one shard to simulate provider failure (shard_0)
    await fs.rm(path.join(pdirs[0] ?? '', 'vault', 'shard_0.bfs.1'));

    // Pull should succeed via RS repair
    await pull(root, { io: mockIO(), force: true });
    expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe('Hello, World!');
  });

  describe('interactive retry when manifest.file_count is null (recovery case)', () => {
    // Guards against: V2 vault + interactive=true + skipped + manifest.file_count=null.
    // _interactiveUnpackRetry deletes blobCachePath after successful retry;
    // _finalizePullState must update file_count BEFORE blobCachePath is gone.

    async function setupBlocker(dir: string, filename: string): Promise<void> {
      await fs.rm(path.join(dir, filename), { force: true });
      await fs.mkdir(path.join(dir, filename));
    }

    function interactiveIO(onConfirm: () => Promise<void>): ProviderIO {
      let confirmed = false;
      return {
        ...mockIO(),
        confirm: vi.fn().mockImplementation(async () => {
          if (!confirmed) {
            confirmed = true;
            await onConfirm();
          }
          return true;
        }),
      };
    }

    // it.fails: TDD red phase — remove .fails when the bug is fixed
    it('should restore files and update manifest.file_count when interactive retry succeeds and manifest.file_count is null (recovery case)', async () => {
      // Arrange
      await fs.writeFile(path.join(root, 'hello.txt'), 'Hello, World!');
      await push(root, { io: mockIO() });

      const manifest = await readManifest(root, 1);
      assert(manifest !== null, 'manifest should exist after push');
      await writeManifest(root, { ...manifest, file_count: null, total_size: null });

      await setupBlocker(root, 'hello.txt');
      const io = interactiveIO(async () => fs.rmdir(path.join(root, 'hello.txt')));

      // Act
      const result = await pull(root, { yes: true, interactive: true, io });

      // Assert
      expect(result.version).toBe(1);
      expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe('Hello, World!');
      const updated = await readManifest(root, 1);
      expect(updated?.file_count).toBe(1);
    });

    it('should restore files and return version when interactive retry succeeds and file_count is already set', async () => {
      // Arrange — same as above but file_count stays set (no patch)
      await fs.writeFile(path.join(root, 'hello.txt'), 'Hello, World!');
      await push(root, { io: mockIO() });

      await setupBlocker(root, 'hello.txt');
      const io = interactiveIO(async () => fs.rmdir(path.join(root, 'hello.txt')));

      // Act
      const result = await pull(root, { yes: true, interactive: true, io });

      // Assert
      expect(result.version).toBe(1);
      expect(await fs.readFile(path.join(root, 'hello.txt'), 'utf-8')).toBe('Hello, World!');
    });

    it('should throw PullSkippedError (not ENOENT) in non-interactive mode when file_count is null', async () => {
      // Arrange
      await fs.writeFile(path.join(root, 'hello.txt'), 'Hello, World!');
      await push(root, { io: mockIO() });

      const manifest = await readManifest(root, 1);
      assert(manifest !== null, 'manifest should exist after push');
      await writeManifest(root, { ...manifest, file_count: null, total_size: null });

      await setupBlocker(root, 'hello.txt');

      // Act + Assert — non-interactive: PullSkippedError thrown before _interactiveUnpackRetry
      await expect(pull(root, { yes: true, io: mockIO() })).rejects.toBeInstanceOf(PullSkippedError);
    });
  });
});

// ─── removeProvider — strategy: remove ────────────────────────────────────────

describe('removeProvider — strategy: remove', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // 4 providers, scheme 3/1
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should mark version as degraded and remove provider from config', async () => {
    await removeProvider(root, 'p0', { strategy: 'remove', io: mockIO() });
    const config = await readConfig(root);
    expect(config?.providers.map((p) => p.id)).not.toContain('p0');
    expect(config?.providers).toHaveLength(3);
    const m = await readManifest(root, 1);
    expect(m?.health).toBe('degraded');
  });

  it('should throw validation error when removing from 3-provider vault (minimum 3)', async () => {
    // Set up a 3-provider vault
    const root3 = await tmp();
    const p3dirs = [await tmp(), await tmp(), await tmp()];
    try {
      await init(root3, {
        vault_name: 'vault',
        scheme: { data_shards: 2, parity_shards: 1 },
        encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
        providers: p3dirs.map((d, i) => localProvider(`pp${i}`, d)),
        push_mode: PushMode.NewVersion,
        io: mockIO(),
      });
      await createTestFiles(root3);
      await push(root3, { io: mockIO() });
      await expect(removeProvider(root3, 'pp0', { strategy: 'remove', io: mockIO() })).rejects.toThrow();
    } finally {
      for (const d of [root3, ...p3dirs]) await fs.rm(d, { recursive: true, force: true });
    }
  });
});

// ─── removeProvider — strategy: rebuild ───────────────────────────────────────

describe('removeProvider — strategy: rebuild', () => {
  let root: string;
  let pdirs: string[];
  let p4dir: string;

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // p0..p3, scheme 3/1
    p4dir = await tmp(); // spare provider for rebuild target
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs, p4dir]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should rebuild shard to new provider and verify healthy', async () => {
    // Add p4 as a spare target provider (simulating CLI "add new provider" step)
    const config = await readConfig(root);
    if (!config) throw new Error('Expected config to exist');
    config.providers.push(localProvider('p4', p4dir));
    await writeConfig(root, config);

    await removeProvider(root, 'p0', { strategy: 'rebuild', targetProviderId: 'p4', io: mockIO() });

    // Config should have [p1, p2, p3, p4] (4 providers)
    const updatedConfig = await readConfig(root);
    const ids = updatedConfig?.providers.map((p) => p.id);
    expect(ids).not.toContain('p0');
    expect(ids).toContain('p4');
    expect(updatedConfig?.providers).toHaveLength(4);

    // Verify health
    const report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('healthy');
  });
});

// ─── removeProvider — strategy: relocate ─────────────────────────────────────

describe('removeProvider — strategy: relocate', () => {
  let root: string;
  let pdirs: string[];
  let p0newDir: string;

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()]; // scheme 3/1
    p0newDir = await tmp();
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Copy p0's vault files to the new location
    await fs.cp(pdirs[0] ?? '', p0newDir, { recursive: true });
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs, p0newDir]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should update provider address and remain healthy', async () => {
    await removeProvider(root, 'p0', { strategy: 'relocate', newConnectionConfig: { path: p0newDir }, io: mockIO() });

    // Config should reflect new path
    const config = await readConfig(root);
    const p0 = config?.providers.find((p) => p.id === 'p0');
    expect(p0?.config.path).toBe(p0newDir);

    // Health should be preserved
    const report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('healthy');
  });

  it('should throw when shards do not exist at the new provider address', async () => {
    // p0newDir is empty — no shard files were copied there
    // Spec: "Sprawdź czy shardy istnieją (list). Jeśli nie istnieją → błąd"
    const emptyDir = await tmp();
    try {
      await expect(removeProvider(root, 'p0', { strategy: 'relocate', newConnectionConfig: { path: emptyDir }, io: mockIO() })).rejects.toThrow();
    } finally {
      await fs.rm(emptyDir, { recursive: true, force: true });
    }
  });

  it('should fix invalid provider type via newType and remain healthy', async () => {
    // Corrupt p0 type in config to simulate a provider with unknown type
    const config = await readConfig(root);
    if (!config) throw new Error('no config');
    const corruptedProviders = config.providers.map((p) => (p.id === 'p0' ? { ...p, type: '?' } : p));
    await writeConfig(root, { ...config, providers: corruptedProviders });

    // relocate with newType repairs both the path and the type
    await removeProvider(root, 'p0', { strategy: 'relocate', newConnectionConfig: { path: p0newDir }, newType: 'local', io: mockIO() });

    const updated = await readConfig(root);
    const p0 = updated?.providers.find((p) => p.id === 'p0');
    expect(p0?.type).toBe('local');
    expect(p0?.config.path).toBe(p0newDir);

    const report = await verifyAll(root, mockIO());
    expect(report.versions[0]?.health).toBe('healthy');
  });
});

// ─── scheme (per-version preservation) ───────────────────────────────────────

describe('scheme — manifests preserve original per-version scheme', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    // 4 providers → scheme 2/2 (N+K = 4) or 3/1
    pdirs = [await tmp(), await tmp(), await tmp(), await tmp()];
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('old manifest keeps its scheme after config scheme change and new push', async () => {
    // Push v1 with scheme 3/1 (4 providers: 3 data + 1 parity)
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() });

    // Change scheme to 2/2 directly in config (same 4 providers, N+K unchanged)
    // Spec: "bfs scheme set zmienia jedynie config.json —
    //        istniejące wersje zachowują swój oryginalny schemat"
    const config = await readConfig(root);
    if (!config) throw new Error('no config');
    await writeConfig(root, { ...config, scheme: { data_shards: 2, parity_shards: 2 } });

    // Push v2 — new manifest uses new scheme
    await push(root, { io: mockIO() });

    const manifests = await listManifests(root);
    const v1 = manifests.find((m) => m.version === 1);
    const v2 = manifests.find((m) => m.version === 2);

    expect(v1?.scheme).toEqual({ data_shards: 3, parity_shards: 1 });
    expect(v2?.scheme).toEqual({ data_shards: 2, parity_shards: 2 });
  });
});

// ─── recovery ─────────────────────────────────────────────────────────────────

describe('recovery', () => {
  let root: string;
  let pdirs: string[];

  beforeEach(async () => {
    root = await tmp();
    pdirs = [await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'test-vault',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: mockIO(),
    });
    await createTestFiles(root);
    await push(root, { io: mockIO() }); // v1
    await push(root, { io: mockIO() }); // v2
    await push(root, { io: mockIO() }); // v3
  });

  afterEach(async () => {
    for (const d of [root, ...pdirs]) await fs.rm(d, { recursive: true, force: true });
  });

  it('should rebuild 3 manifests after .bfs/ is deleted', async () => {
    // Simulate disaster: delete .bfs/
    await fs.rm(path.join(root, '.bfs'), { recursive: true });

    // Bootstrap from p0
    const { io: bsIO } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(localProvider('p0', pdirs[0] ?? ''), bsIO);
    await bootstrapProvider.authenticate();

    const report = await recover(root, { vaultName: 'test-vault', provider: bootstrapProvider, io: bsIO });

    expect(report.manifests_rebuilt).toBe(3);
    const manifests = await listManifests(root);
    expect(manifests).toHaveLength(3);
    expect(manifests.map((m) => m.version)).toEqual([1, 2, 3]);
  });

  it('should rebuild config.json with correct vault_name', async () => {
    await fs.rm(path.join(root, '.bfs'), { recursive: true });

    const { io: bsIO } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(localProvider('p0', pdirs[0] ?? ''), bsIO);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'test-vault', provider: bootstrapProvider, io: bsIO });

    const config = await readConfig(root);
    expect(config?.vault_name).toBe('test-vault');
    expect(config?.scheme).toEqual({ data_shards: 2, parity_shards: 1 });
  });

  it('should rebuild manifests with rs_striped=true for v2 shards', async () => {
    await fs.rm(path.join(root, '.bfs'), { recursive: true });

    const { io: bsIO } = createMockProviderIO();
    const bootstrapProvider = new LocalFsProvider(localProvider('p0', pdirs[0] ?? ''), bsIO);
    await bootstrapProvider.authenticate();

    await recover(root, { vaultName: 'test-vault', provider: bootstrapProvider, io: bsIO });

    const manifest = await readManifest(root, 1);
    expect(manifest?.rs_striped).toBe(true);
    expect(typeof manifest?.rs_stripe_size).toBe('number');
    expect(manifest?.rs_stripe_size).toBeGreaterThan(0);
    expect(manifest?.encrypted_per_shard).toBeUndefined();
  });
});
