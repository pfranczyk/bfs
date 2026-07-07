import { existsSync, readFileSync } from 'node:fs';
import { cp, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/providers/local-fs.js';
import '../../src/providers/ftp.js';
import { BfsError, DecryptionError, TamperDetectedError } from '../../src/core/errors.js';
import { buildShard, extractSidecarHeaderBytes } from '../../src/core/shard-io.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderIO, RepairPair, ShardHeader, VaultConfig } from '../../src/types/index.js';
import { PushMode } from '../../src/types/index.js';
import { redactPairParams, repairVault } from '../../src/vault/repair.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';

const CONFIG = {
  vault_id: 'vault-x',
  vault_name: 'v',
  version: 1,
  scheme: { data_shards: 2, parity_shards: 1 },
  encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
  compression: { enabled: false, algorithm: 'deflate' },
  push_mode: 'new',
  providers: [{ id: 'p0', type: 'local', adapterPackage: null, config: { path: '/x' } }],
};

function editPair(): RepairPair {
  return { oldName: 'p0', params: '--path /y', rawParams: ['--path', '/y'], isMigration: false, newConfig: null };
}

describe('repairVault guards', () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'bfs-repair-'));
    await mkdir(join(rootDir, '.bfs', 'manifests'), { recursive: true });
    await writeFile(join(rootDir, '.bfs', 'config.json'), JSON.stringify(CONFIG));
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('should reject when the version range matches no versions', async () => {
    const { io } = createMockProviderIO();

    await expect(repairVault(rootDir, { pairs: [editPair()], versions: [], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false })).rejects.toThrow(BfsError);
  });

  it('should reject when the vault config is missing', async () => {
    await rm(join(rootDir, '.bfs', 'config.json'));
    const { io } = createMockProviderIO();

    await expect(repairVault(rootDir, { pairs: [editPair()], versions: [1], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false })).rejects.toThrow(BfsError);
  });
});

describe('repairVault integrity pre-check', () => {
  it('should abort with TamperDetectedError when a shard belongs to a different backup', async () => {
    const rootDir = await mkdtemp(join(tmpdir(), 'bfs-repair-fs-'));
    const storageDir = join(rootDir, 'storage');
    try {
      const config = { ...CONFIG, vault_id: 'expected-vault', providers: [{ id: 'p0', type: 'local', adapterPackage: null, config: { path: storageDir } }] };
      await mkdir(join(rootDir, '.bfs', 'manifests'), { recursive: true });
      await writeFile(join(rootDir, '.bfs', 'config.json'), JSON.stringify(config));

      const manifest = {
        version: 1,
        pushed_at: null,
        file_count: null,
        total_size: null,
        blob_hash: 'a'.repeat(64),
        scheme: { data_shards: 2, parity_shards: 1 },
        encrypted: false,
        shards: [{ shard_index: 0, provider_id: 'p0', provider_type: 'local', remote_path: `${storageDir}/v/shard_0.bfs.1`, shard_hash: 'b'.repeat(64) }],
        health: 'healthy',
      };
      await writeFile(join(rootDir, '.bfs', 'manifests', 'v001.json'), JSON.stringify(manifest));

      // A real, parseable shard whose header advertises a foreign vault_id.
      await mkdir(join(storageDir, 'v'), { recursive: true });
      const header: ShardHeader = {
        magic: 'BFSS',
        format_version: 1,
        vault_id: 'foreign-vault',
        vault_name: 'v',
        blob_size: 100n,
        blob_hash: 'a'.repeat(64),
        data_shards: 2,
        parity_shards: 1,
        shard_index: 0,
        version: 1,
        encrypted: false,
        kdf_salt: null,
        rs_stripe_size: 64 * 1024 * 1024,
        map_length: 0,
        location_map: [],
      };
      await writeFile(join(storageDir, 'v', 'shard_0.bfs.1'), buildShard(header, Buffer.from('payload')));

      const { io } = createMockProviderIO();
      await expect(repairVault(rootDir, { pairs: [editPair()], versions: [1], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false })).rejects.toThrow(TamperDetectedError);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });
});

describe('redactPairParams (repair.lock secret masking)', () => {
  it('should mask the migration target type secret even when the source type has none', () => {
    // Regression: local (no secrets) → ftp migration must mask the ftp --password
    // value in the forensic lock. Prior bug used only the source type's fields.
    const { io } = createMockProviderIO();
    const migration: RepairPair = {
      oldName: 'p0',
      params: 'ftp:p9 --host h --user u --password SECRET --path /b',
      rawParams: ['ftp:p9', '--host', 'h', '--user', 'u', '--password', 'SECRET', '--path', '/b'],
      isMigration: true,
      newConfig: { id: 'p9', type: 'ftp', adapterPackage: null, config: {} },
    };

    const redacted = redactPairParams(migration, CONFIG as unknown as VaultConfig, io);

    expect(redacted).not.toContain('SECRET');
    expect(redacted).toContain('***');
  });
});

/** Builds a real 2+1 local vault (init + push) so repairVault runs against genuine shards. */
async function pushLocalVault(opts: { encrypted: boolean; password?: string }): Promise<{ root: string; dirs: string[]; io: ProviderIO }> {
  const root = await mkdtemp(join(tmpdir(), 'bfs-repair-vault-'));
  const dirs = [await mkdtemp(join(tmpdir(), 'bfs-p-')), await mkdtemp(join(tmpdir(), 'bfs-p-')), await mkdtemp(join(tmpdir(), 'bfs-p-'))];
  const { io } = createMockProviderIO();

  await init(root, {
    vault_name: 'repair-test',
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: opts.encrypted, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: dirs.map((d, i) => ({ id: `p${i}`, type: 'local', adapterPackage: null, config: { path: d } })),
    push_mode: PushMode.NewVersion,
    io,
  });
  await writeFile(join(root, 'a.txt'), 'aaa', 'utf-8');
  await push(root, { io, ...(opts.password !== undefined ? { password: opts.password } : {}) });
  return { root, dirs, io };
}

const lockExists = (root: string): Promise<boolean> =>
  stat(join(root, '.bfs', 'repair.lock'))
    .then(() => true)
    .catch(() => false);

describe('repairVault — precheck + lock lifecycle', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs) await rm(d, { recursive: true, force: true });
    cleanupDirs.length = 0;
  });

  it('should fail fast with DecryptionError when an encrypted vault has no password in --ci', async () => {
    const { root, dirs, io } = await pushLocalVault({ encrypted: true, password: 'pw-ci-test' });
    cleanupDirs.push(root, ...dirs);

    await expect(repairVault(root, { pairs: [editPair()], versions: [1], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false })).rejects.toThrow(DecryptionError);
  });

  it('should retain repair.lock and record a failed pair when the new path has no shards', async () => {
    const { root, dirs, io } = await pushLocalVault({ encrypted: false });
    const emptyDir = await mkdtemp(join(tmpdir(), 'bfs-empty-'));
    cleanupDirs.push(root, ...dirs, emptyDir);

    const pair: RepairPair = { oldName: 'p0', params: `--path ${emptyDir}`, rawParams: ['--path', emptyDir], isMigration: false, newConfig: null };
    const result = await repairVault(root, { pairs: [pair], versions: [1], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false });

    expect(result.failed_pairs.length).toBe(1);
    expect(await lockExists(root)).toBe(true);
  });

  it('should remove repair.lock after a successful path repair', async () => {
    const { root, dirs, io } = await pushLocalVault({ encrypted: false });
    const movedDir = await mkdtemp(join(tmpdir(), 'bfs-moved-'));
    cleanupDirs.push(root, ...dirs, movedDir);
    await cp(join(dirs[0], 'repair-test'), join(movedDir, 'repair-test'), { recursive: true });

    const pair: RepairPair = { oldName: 'p0', params: `--path ${movedDir}`, rawParams: ['--path', movedDir], isMigration: false, newConfig: null };
    const result = await repairVault(root, { pairs: [pair], versions: [1], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false });

    expect(result.failed_pairs.length).toBe(0);
    expect(await lockExists(root)).toBe(false);
  });
});

const VAULT_NAME = 'repair-test';

/** Path to a provider dir's location-header sidecar for shard `index`, version `version`. */
function sidecarPath(providerDir: string, index: number, version = 1): string {
  return join(providerDir, VAULT_NAME, `hdr_${index}.bfs.${version}`);
}

/**
 * Relocates provider p0 to a fresh copy of its storage via a normal repair edit
 * — the machinery that writes an hdr_ sidecar next to EVERY shard. Returns the
 * new provider directory so the caller can register it for cleanup.
 */
async function relocateP0(root: string, dirs: string[], io: ProviderIO, password?: string): Promise<string> {
  const movedDir = await mkdtemp(join(tmpdir(), 'bfs-moved-'));
  await cp(join(dirs[0], VAULT_NAME), join(movedDir, VAULT_NAME), { recursive: true });
  const pair: RepairPair = { oldName: 'p0', params: `--path ${movedDir}`, rawParams: ['--path', movedDir], isMigration: false, newConfig: null };
  await repairVault(root, { pairs: [pair], versions: [1], io, passwords: password !== undefined ? [password] : [], isCi: true, rebuild: false, forceUnverified: false });
  return movedDir;
}

describe('repairVault --restore-headers (sidecar reconstruction)', () => {
  const cleanupDirs: string[] = [];

  afterEach(async () => {
    for (const d of cleanupDirs) await rm(d, { recursive: true, force: true });
    cleanupDirs.length = 0;
  });

  it('should rebuild a missing sidecar and clear the header advisory (plain)', async () => {
    const { root, dirs, io } = await pushLocalVault({ encrypted: false });
    const movedDir = await relocateP0(root, dirs, io);
    cleanupDirs.push(root, ...dirs, movedDir);

    // Delete a non-relocated sibling's sidecar; verify sees the asymmetry.
    const hdr = sidecarPath(dirs[1], 1);
    await rm(hdr);
    expect(existsSync(hdr)).toBe(false);
    expect((await verifyVersion(root, 1, io)).header_advisory).toEqual({ missing: 1, broken: 0 });

    await repairVault(root, { pairs: [], versions: [1], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false, restoreHeaders: true });

    expect(existsSync(hdr)).toBe(true);
    expect((await verifyVersion(root, 1, io)).header_advisory).toBeNull();
  });

  it('should overwrite a broken sidecar with a valid BFSH envelope (plain)', async () => {
    const { root, dirs, io } = await pushLocalVault({ encrypted: false });
    const movedDir = await relocateP0(root, dirs, io);
    cleanupDirs.push(root, ...dirs, movedDir);

    // Corrupt a non-relocated sibling's sidecar with non-BFSH bytes.
    const hdr = sidecarPath(dirs[1], 1);
    await writeFile(hdr, Buffer.from('GARBAGE-NOT-BFSH'));
    expect(() => extractSidecarHeaderBytes(readFileSync(hdr))).toThrow();

    await repairVault(root, { pairs: [], versions: [1], io, passwords: [], isCi: true, rebuild: false, forceUnverified: false, restoreHeaders: true });

    expect(() => extractSidecarHeaderBytes(readFileSync(hdr))).not.toThrow();
    expect((await verifyVersion(root, 1, io)).header_advisory).toBeNull();
  });

  it('should rebuild a missing sidecar for an encrypted vault with the password', async () => {
    const password = 'restore-headers-unit-pw';
    const { root, dirs, io } = await pushLocalVault({ encrypted: true, password });
    const movedDir = await relocateP0(root, dirs, io, password);
    cleanupDirs.push(root, ...dirs, movedDir);

    const hdr = sidecarPath(dirs[1], 1);
    await rm(hdr);
    expect(existsSync(hdr)).toBe(false);

    await repairVault(root, { pairs: [], versions: [1], io, passwords: [password], isCi: true, rebuild: false, forceUnverified: false, restoreHeaders: true });

    expect(existsSync(hdr)).toBe(true);
    expect(() => extractSidecarHeaderBytes(readFileSync(hdr))).not.toThrow();
    expect((await verifyVersion(root, 1, io)).header_advisory).toBeNull();
  });
});
