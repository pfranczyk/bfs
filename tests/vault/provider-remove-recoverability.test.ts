import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, assert, describe, expect, it, vi } from 'vitest';
import { ProviderError, ProviderRemoveRefusedError } from '../../src/core/errors.js';
// Registers the `local` provider type the vaults below are built on.
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { applyHealthChange, readManifest, writeManifest } from '../../src/vault/manifest.js';
import { init, push, removeProvider } from '../../src/vault/vault-manager.js';

// `--strategy remove` drops a storage from the configuration without touching
// its bytes. Two things it can take away with it are guarded here: a version's
// last N reachable parts - after which that version cannot be restored from
// this configuration - and the third storage, below which no scheme is valid
// and no backup can be made at all. Both need an explicit `force`; a removal
// that takes neither stays as easy as it was.

type Scheme = { data_shards: number; parity_shards: number };

const dirs: string[] = [];

async function tmp(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-remove-recov-'));
  dirs.push(dir);
  return dir;
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/** A vault over `count` storages with one version pushed under `scheme`. */
async function vaultWithOneVersion(count: number, scheme: Scheme): Promise<{ root: string; pdirs: string[] }> {
  const root = await tmp();
  const pdirs: string[] = [];
  for (let i = 0; i < count; i++) pdirs.push(await tmp());
  await init(root, {
    vault_name: 'vault',
    scheme,
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: pdirs.map((d, i) => localProvider(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io: createMockProviderIO().io,
  });
  await fs.writeFile(path.join(root, 'hello.txt'), 'Hello, World!', 'utf-8');
  await push(root, { io: createMockProviderIO().io });
  return { root, pdirs };
}

/** Replaces the stored scheme, the way `bfs scheme set` does. */
async function setScheme(root: string, scheme: Scheme): Promise<void> {
  const config = await readConfig(root);
  assert(config !== null, 'vault config must exist');
  await writeConfig(root, { ...config, scheme });
}

/** Drops `id` the way `--strategy remove` does, then matches the scheme to the pool left. */
async function removeAndRescale(root: string, id: string, scheme: Scheme): Promise<void> {
  await removeProvider(root, id, { strategy: 'remove', io: createMockProviderIO().io });
  await setScheme(root, scheme);
}

function shardOnMedium(pdir: string | undefined, index: number, version: number): string {
  assert(pdir !== undefined, 'storage directory must exist');
  return path.join(pdir, 'vault', `shard_${index}.bfs.${version}`);
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
  dirs.length = 0;
});

describe('removeProvider - strategy: remove - a version below its N', () => {
  // Control: a 4/1 version on five storages keeps exactly its N=4 parts after one
  // removal, so it is still restorable and the removal needs no force.
  it('should remove a storage when every version keeps its N parts', async () => {
    const { root } = await vaultWithOneVersion(5, { data_shards: 4, parity_shards: 1 });

    await removeProvider(root, 'p0', { strategy: 'remove', io: createMockProviderIO().io });

    expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p1', 'p2', 'p3', 'p4']);
    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Degraded);
  });

  // The second removal leaves three storages - enough for a 2/1 backup - but the
  // 4/1 version written before then has only three parts left of the four it
  // needs. Nothing in the pool count shows that, so the version is what refuses.
  it('should refuse a removal that leaves a version with fewer parts than its N', async () => {
    const { root, pdirs } = await vaultWithOneVersion(5, { data_shards: 4, parity_shards: 1 });
    await removeAndRescale(root, 'p0', { data_shards: 3, parity_shards: 1 });
    const configBefore = await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8');

    const removal = removeProvider(root, 'p1', { strategy: 'remove', io: createMockProviderIO().io });

    await expect(removal).rejects.toBeInstanceOf(ProviderRemoveRefusedError);
    await expect(removal).rejects.toMatchObject({ versionsBelowRecovery: [1], poolBelowMinimum: false });
    expect(await fs.readFile(path.join(root, '.bfs', 'config.json'), 'utf-8')).toBe(configBefore);
    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Degraded);
    // `remove` never touches the medium, refused or not.
    await expect(fs.access(shardOnMedium(pdirs[1], 1, 1))).resolves.toBeUndefined();
  });

  // A version written after the first removal lives on the four storages left
  // and keeps its N=3 parts; only the older 4/1 version may be named.
  it('should name only the versions the removal takes below their N', async () => {
    const { root } = await vaultWithOneVersion(5, { data_shards: 4, parity_shards: 1 });
    await removeAndRescale(root, 'p0', { data_shards: 3, parity_shards: 1 });
    await fs.writeFile(path.join(root, 'second.txt'), 'second version', 'utf-8');
    await push(root, { io: createMockProviderIO().io });

    const removal = removeProvider(root, 'p1', { strategy: 'remove', io: createMockProviderIO().io });

    await expect(removal).rejects.toMatchObject({ versionsBelowRecovery: [1] });
  });

  // A partial push records only the parts that were uploaded, so a 3/1 version
  // with one failed upload has three parts, not four. Removing one of them takes
  // it to two - below its N - even though N + K minus one would still be three.
  it('should count the parts a partial push actually recorded', async () => {
    const root = await tmp();
    const pdirs = [await tmp(), await tmp(), await tmp(), await tmp(), await tmp()];
    await init(root, {
      vault_name: 'vault',
      scheme: { data_shards: 3, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: pdirs.slice(0, 4).map((d, i) => localProvider(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io: createMockProviderIO().io,
    });
    await fs.writeFile(path.join(root, 'hello.txt'), 'Hello, World!', 'utf-8');
    const original = LocalFsProvider.prototype.upload;
    let uploads = 0;
    vi.spyOn(LocalFsProvider.prototype, 'upload').mockImplementation(async function (this: LocalFsProvider, ...args: Parameters<typeof original>) {
      uploads++;
      if (uploads === 4) throw new ProviderError('simulated upload failure');
      return original.apply(this, args);
    });
    await push(root, { io: createMockProviderIO().io });
    vi.restoreAllMocks();
    expect((await readManifest(root, 1))?.shards.map((s) => s.provider_id)).toEqual(['p0', 'p1', 'p2']);
    // A fifth storage keeps the pool at four after the removal, so only the
    // version can be what refuses.
    const config = await readConfig(root);
    const fifth = pdirs[4];
    assert(config !== null && fifth !== undefined, 'vault config and the fifth storage must exist');
    await writeConfig(root, { ...config, providers: [...config.providers, localProvider('p4', fifth)], scheme: { data_shards: 3, parity_shards: 2 } });

    const removal = removeProvider(root, 'p0', { strategy: 'remove', io: createMockProviderIO().io });

    await expect(removal).rejects.toMatchObject({ versionsBelowRecovery: [1], poolBelowMinimum: false });
  });

  it('should remove the storage with force and mark the version damaged', async () => {
    const { root, pdirs } = await vaultWithOneVersion(5, { data_shards: 4, parity_shards: 1 });
    await removeAndRescale(root, 'p0', { data_shards: 3, parity_shards: 1 });

    await removeProvider(root, 'p1', { strategy: 'remove', force: true, io: createMockProviderIO().io });

    expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p2', 'p3', 'p4']);
    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Damaged);
    await expect(fs.access(shardOnMedium(pdirs[1], 1, 1))).resolves.toBeUndefined();
  });

  // A manifest can still read healthy while one of its storages has already left
  // the configuration (an interrupted repair leaves that shape). The removal that
  // takes it below N goes straight to damaged.
  it('should mark a healthy version damaged when the forced removal takes it below N', async () => {
    const { root } = await vaultWithOneVersion(5, { data_shards: 4, parity_shards: 1 });
    const config = await readConfig(root);
    assert(config !== null, 'vault config must exist');
    await writeConfig(root, { ...config, providers: config.providers.filter((p) => p.id !== 'p0'), scheme: { data_shards: 3, parity_shards: 1 } });
    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Healthy);

    await removeProvider(root, 'p1', { strategy: 'remove', force: true, io: createMockProviderIO().io });

    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Damaged);
  });

  // Rot a deep verify read off another storage is still there after this storage
  // leaves the configuration. Dropping that record would let a later shallow
  // verify - blind to payload rot - report the version healthy again once the
  // storage is added back.
  it('should keep a recorded deep-verify rot when the removal marks the version damaged', async () => {
    const { root } = await vaultWithOneVersion(5, { data_shards: 4, parity_shards: 1 });
    await removeAndRescale(root, 'p0', { data_shards: 3, parity_shards: 1 });
    const manifest = await readManifest(root, 1);
    assert(manifest !== null, 'manifest of v1 must exist');
    await writeManifest(root, applyHealthChange(manifest, VersionHealth.Degraded, true));
    const checkedAt = (await readManifest(root, 1))?.health_checked_at;
    assert(checkedAt !== undefined, 'the deep verdict must carry its timestamp');

    await removeProvider(root, 'p1', { strategy: 'remove', force: true, io: createMockProviderIO().io });

    const after = await readManifest(root, 1);
    expect(after?.health).toBe(VersionHealth.Damaged);
    expect(after?.health_deep_rot).toBe(true);
    // The deep pass that read the rot is still the last one; no new check happened.
    expect(after?.health_checked_at).toBe(checkedAt);
  });

  // A shallow verify records `damaged` while a storage is merely unreachable, and
  // that verdict retires once the storage is back. The gate counts the parts the
  // configuration still reaches, so such a version - four parts configured, N=4 -
  // is still taken below its N by this removal and must be named.
  it('should name a version recorded damaged that still has its N parts configured', async () => {
    const { root } = await vaultWithOneVersion(5, { data_shards: 4, parity_shards: 1 });
    await removeAndRescale(root, 'p0', { data_shards: 3, parity_shards: 1 });
    const manifest = await readManifest(root, 1);
    assert(manifest !== null, 'manifest of v1 must exist');
    await writeManifest(root, applyHealthChange(manifest, VersionHealth.Damaged));

    const removal = removeProvider(root, 'p1', { strategy: 'remove', io: createMockProviderIO().io });

    await expect(removal).rejects.toMatchObject({ versionsBelowRecovery: [1] });
  });

  // The gate is about what this removal takes away. A version already below its
  // N - damaged by an earlier forced removal - loses nothing it still had, so it
  // must not make every later removal demand force, whether or not it used the
  // storage being removed.
  it('should not demand force for a version that is already below its N', async () => {
    const { root } = await vaultWithOneVersion(7, { data_shards: 5, parity_shards: 2 });
    await removeProvider(root, 'p0', { strategy: 'remove', io: createMockProviderIO().io });
    await removeAndRescale(root, 'p1', { data_shards: 4, parity_shards: 1 });
    await removeProvider(root, 'p2', { strategy: 'remove', force: true, io: createMockProviderIO().io });
    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Damaged);
    await setScheme(root, { data_shards: 3, parity_shards: 1 });

    await removeProvider(root, 'p3', { strategy: 'remove', io: createMockProviderIO().io });

    expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p4', 'p5', 'p6']);
    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Damaged);
  });
});

describe('removeProvider - strategy: remove - a pool below three storages', () => {
  // No valid scheme fits two storages (N >= 2 and K >= 1), so after this removal
  // no backup can be made from this configuration.
  it('should refuse a removal that leaves fewer than three storages', async () => {
    const { root } = await vaultWithOneVersion(3, { data_shards: 2, parity_shards: 1 });

    const removal = removeProvider(root, 'p0', { strategy: 'remove', io: createMockProviderIO().io });

    await expect(removal).rejects.toBeInstanceOf(ProviderRemoveRefusedError);
    await expect(removal).rejects.toMatchObject({ poolBelowMinimum: true, versionsBelowRecovery: [] });
    expect((await readConfig(root))?.providers).toHaveLength(3);
  });

  // The floor is a state, not a crossing: a pool already below three still has
  // no valid scheme, so every further removal needs force again.
  it('should refuse a removal from a pool already below three storages', async () => {
    const { root } = await vaultWithOneVersion(3, { data_shards: 2, parity_shards: 1 });
    await removeProvider(root, 'p0', { strategy: 'remove', force: true, io: createMockProviderIO().io });

    const removal = removeProvider(root, 'p1', { strategy: 'remove', io: createMockProviderIO().io });

    await expect(removal).rejects.toMatchObject({ poolBelowMinimum: true });
    expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p1', 'p2']);
  });

  // One removal can trip both gates; the refusal carries both, so the operator
  // sees everything `--force` would be consenting to.
  it('should report both the pool floor and the versions below N in one refusal', async () => {
    const { root } = await vaultWithOneVersion(4, { data_shards: 3, parity_shards: 1 });
    await removeAndRescale(root, 'p0', { data_shards: 2, parity_shards: 1 });

    const removal = removeProvider(root, 'p1', { strategy: 'remove', io: createMockProviderIO().io });

    await expect(removal).rejects.toMatchObject({ poolBelowMinimum: true, versionsBelowRecovery: [1] });
  });

  // The 2/1 version keeps its N=2 parts on the two storages left, so it is
  // degraded, not damaged: the data is still there, only this configuration can
  // no longer push or restore until the pool grows again.
  it('should remove the storage with force and keep a still-restorable version degraded', async () => {
    const { root } = await vaultWithOneVersion(3, { data_shards: 2, parity_shards: 1 });

    await removeProvider(root, 'p0', { strategy: 'remove', force: true, io: createMockProviderIO().io });

    expect((await readConfig(root))?.providers.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect((await readManifest(root, 1))?.health).toBe(VersionHealth.Degraded);
  });
});
