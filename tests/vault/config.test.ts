import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import type { ProviderConfig, VaultConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { assertSchemeValid, readConfig, writeConfig } from '../../src/vault/config.js';
import { fileIdentity, interruptWritesHalfway, SIMULATED_CRASH, strayTempFiles } from '../helpers/interrupted-write.js';

function makeProvider(id: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: `/mnt/${id}` } };
}

function makeConfig(overrides: Partial<VaultConfig> & { scheme?: unknown } = {}): VaultConfig {
  const base: VaultConfig = {
    vault_id: 'v1',
    vault_name: 'test',
    version: 1,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: true, algorithm: 'deflate' },
    push_mode: PushMode.NewVersion,
    providers: [makeProvider('p1'), makeProvider('p2'), makeProvider('p3')],
  };
  return { ...base, ...(overrides as VaultConfig) };
}

describe('assertSchemeValid', () => {
  it('should accept a valid config (N=2, K=1, 3 providers)', () => {
    expect(() => assertSchemeValid(makeConfig())).not.toThrow();
  });

  it('should accept a valid config (N=4, K=2, 6 providers)', () => {
    const providers = ['a', 'b', 'c', 'd', 'e', 'f'].map(makeProvider);
    const cfg = makeConfig({ scheme: { data_shards: 4, parity_shards: 2 }, providers });
    expect(() => assertSchemeValid(cfg)).not.toThrow();
  });

  it('should throw BfsError when scheme is missing', () => {
    const cfg = makeConfig({ scheme: null as unknown as VaultConfig['scheme'] });
    expect(() => assertSchemeValid(cfg)).toThrow(BfsError);
    expect(() => assertSchemeValid(cfg)).toThrow(/missing or corrupted/);
  });

  it('should throw BfsError when data_shards is null', () => {
    const cfg = makeConfig({ scheme: { data_shards: null as unknown as number, parity_shards: 1 } });
    expect(() => assertSchemeValid(cfg)).toThrow(BfsError);
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });

  it('should throw BfsError when data_shards is < 2', () => {
    const cfg = makeConfig({ scheme: { data_shards: 1, parity_shards: 1 } });
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });

  it('should throw BfsError when data_shards is not integer', () => {
    const cfg = makeConfig({ scheme: { data_shards: 2.5, parity_shards: 1 } });
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });

  it('should throw BfsError when parity_shards is null', () => {
    const cfg = makeConfig({ scheme: { data_shards: 2, parity_shards: null as unknown as number } });
    expect(() => assertSchemeValid(cfg)).toThrow(/parity_shards must be/);
  });

  it('should throw BfsError when parity_shards is < 1', () => {
    const cfg = makeConfig({ scheme: { data_shards: 2, parity_shards: 0 } });
    expect(() => assertSchemeValid(cfg)).toThrow(/parity_shards must be/);
  });

  it('should throw BfsError when providers.length != N+K', () => {
    const cfg = makeConfig({ scheme: { data_shards: 2, parity_shards: 1 }, providers: [makeProvider('p1'), makeProvider('p2')] });
    expect(() => assertSchemeValid(cfg)).toThrow(/requires 3 providers/);
  });

  it('should mention required provider count and current count', () => {
    const cfg = makeConfig({ scheme: { data_shards: 3, parity_shards: 2 }, providers: [makeProvider('p1')] });
    expect(() => assertSchemeValid(cfg)).toThrow(/5 providers.*configured: 1/);
  });

  // Below three storages no scheme is valid (N >= 2, K >= 1), so `bfs scheme set`
  // cannot close the gap - the command would refuse every pair it is given. A new
  // storage takes a missing place without touching the scheme, so that is the
  // one command the refusal names.
  it('should advise bfs provider add and not bfs scheme set when fewer than three storages are configured', () => {
    const cfg = makeConfig({ scheme: { data_shards: 2, parity_shards: 1 }, providers: [makeProvider('p1'), makeProvider('p2')] });

    expect(() => assertSchemeValid(cfg)).toThrow(BfsError);
    expect(() => assertSchemeValid(cfg)).toThrow(/at least 3 storage providers/);
    expect(() => assertSchemeValid(cfg)).toThrow(/bfs provider add/);
    expect(() => assertSchemeValid(cfg)).not.toThrow(/bfs scheme set/);
  });

  // A pool short of the scheme has two ways out: a new storage fills the missing
  // place and keeps the scheme, a scheme matched to the storages lowers it.
  it('should advise both bfs provider add and bfs scheme set when the pool is short of the scheme', () => {
    const cfg = makeConfig({ scheme: { data_shards: 3, parity_shards: 1 }, providers: [makeProvider('p1'), makeProvider('p2'), makeProvider('p3')] });

    expect(() => assertSchemeValid(cfg)).toThrow(/bfs scheme set/);
    expect(() => assertSchemeValid(cfg)).toThrow(/bfs provider add/);
  });

  // A pool LARGER than the scheme is what a rebuild onto a new storage leaves
  // when it stops halfway: the new entry is written first and the old one goes
  // last. Adding a storage does not close that, and `bfs scheme set` with the
  // larger sum is accepted - it would count the free entry as a place holding a
  // part. So the refusal names the state and the rebuild that finishes it.
  it('should name an unfinished rebuild and no scheme or add command when the pool is larger than the scheme', () => {
    const cfg = makeConfig({ scheme: { data_shards: 2, parity_shards: 1 }, providers: [makeProvider('p1'), makeProvider('p2'), makeProvider('p3'), makeProvider('p4')] });

    expect(() => assertSchemeValid(cfg)).toThrow(/requires 3 providers, configured: 4/);
    expect(() => assertSchemeValid(cfg)).toThrow(/more storages than the scheme uses/);
    expect(() => assertSchemeValid(cfg)).toThrow(/did not finish/);
    expect(() => assertSchemeValid(cfg)).not.toThrow(/bfs scheme set/);
    expect(() => assertSchemeValid(cfg)).not.toThrow(/bfs provider add/);
  });

  it('should check scheme first (before providers count)', () => {
    // A config that fails BOTH scheme and providers count - should report
    // scheme error first (more specific root cause).
    const cfg = makeConfig({ scheme: { data_shards: null as unknown as number, parity_shards: null as unknown as number }, providers: [] });
    expect(() => assertSchemeValid(cfg)).toThrow(/data_shards must be/);
  });
});

describe('writeConfig', () => {
  const tmpDirs: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const dir of tmpDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  async function makeVaultDir(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-config-'));
    tmpDirs.push(dir);
    await fs.mkdir(path.join(dir, '.bfs'), { recursive: true });
    return dir;
  }

  // POSIX-only: config.json holds provider connection secrets and must be
  // owner-only. Windows NTFS ignores POSIX mode bits, so the bits are
  // meaningless there and the assertion would be a false signal.
  it.skipIf(process.platform === 'win32')('should write config.json with 0600 permissions', async () => {
    const dir = await makeVaultDir();

    await writeConfig(dir, makeConfig());

    const stat = await fs.stat(path.join(dir, '.bfs', 'config.json'));
    expect(stat.mode & 0o777).toBe(0o600);
  });

  // A mode passed to writeFile applies only when the file is created, so an
  // existing world-readable config.json must not keep its old permissions after
  // being overwritten. Pre-create it 0644 to prove the overwrite narrows them.
  it.skipIf(process.platform === 'win32')('should restrict an existing config.json to 0600 on overwrite', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'config.json');
    await fs.writeFile(filePath, '{}', { mode: 0o644 });

    await writeConfig(dir, makeConfig());

    const stat = await fs.stat(filePath);
    expect(stat.mode & 0o777).toBe(0o600);
  });

  it('should round-trip config through writeConfig/readConfig', async () => {
    const dir = await makeVaultDir();
    const cfg = makeConfig();

    await writeConfig(dir, cfg);

    expect(await readConfig(dir)).toEqual(cfg);
  });

  // A process that dies while config.json is being written must leave either the
  // old or the new content behind - a torn file loses the backup's settings and
  // provider list, leaving only disaster recovery from the media. The death is
  // modelled as a write that lands half of its bytes and then fails.
  it('should keep the previous config.json intact when the write is interrupted', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'config.json');
    await writeConfig(dir, makeConfig());
    const before = await fs.readFile(filePath, 'utf-8');
    interruptWritesHalfway();

    await expect(writeConfig(dir, makeConfig({ vault_name: 'renamed' }))).rejects.toThrow(SIMULATED_CRASH);

    vi.restoreAllMocks();
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('should leave no config.json at all when the first write is interrupted', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'config.json');
    interruptWritesHalfway();

    await expect(writeConfig(dir, makeConfig())).rejects.toThrow(SIMULATED_CRASH);

    vi.restoreAllMocks();
    await expect(fs.access(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // The guarantee above holds only if the new content reaches the final name in
  // one step. Rewriting the file in place - or copying a finished temporary over
  // it - keeps the file's identity and can still be cut short; a rename swaps in
  // a different file.
  it('should replace config.json with a new file rather than rewrite it in place', async () => {
    const dir = await makeVaultDir();
    const filePath = path.join(dir, '.bfs', 'config.json');
    await writeConfig(dir, makeConfig());
    const before = await fileIdentity(filePath);

    await writeConfig(dir, makeConfig({ vault_name: 'renamed' }));

    expect(await fileIdentity(filePath)).not.toBe(before);
    expect((await readConfig(dir))?.vault_name).toBe('renamed');
    expect(await strayTempFiles(filePath)).toEqual([]);
  });
});
