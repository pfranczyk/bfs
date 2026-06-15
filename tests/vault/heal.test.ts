import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Importing LocalFsProvider registers its factory in the global ProviderRegistry,
// which init/push/heal resolve by string "local".
import '../../src/providers/local-fs.js';
import { packBlob } from '../../src/core/blob-pack.js';
import { hashBuffer, SHA256_BYTES } from '../../src/core/hash.js';
import { createIgnoreFilter } from '../../src/core/ignore.js';
import { rsEncode } from '../../src/core/reed-solomon.js';
import { buildShard, parseShardHeaderFromStream, uuidToBuffer } from '../../src/core/shard-io.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, ShardHeader, ShardLocation, VaultConfig, VersionManifest } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { rebuildVersion, relocateProvider } from '../../src/vault/heal.js';
import { readManifest, writeManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';
import { writeState } from '../../src/vault/state.js';
import { init, pull, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';
import { registerSecretProvider, secretProviderConfig, unregisterSecretProvider } from '../helpers/secret-local-provider.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-heal-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

/**
 * Builds a 2+1 vault on three local providers, pushes two files, then registers
 * a fourth (unused) provider in config as a heal target. The fourth provider is
 * absent from the v1 manifest, satisfying rebuildVersion's "target must not yet
 * hold a shard for this version" invariant.
 */
async function setupVault(opts: { encrypted: boolean; password?: string }): Promise<{ root: string; providerDirs: string[]; io: ProviderIO }> {
  const root = await tmp();
  const providerDirs = [await tmp(), await tmp(), await tmp(), await tmp()];
  const { io } = createMockProviderIO();

  await init(root, {
    vault_name: 'heal-test',
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: opts.encrypted, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: providerDirs.slice(0, 3).map((d, i) => localProvider(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io,
  });

  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io, ...(opts.password !== undefined ? { password: opts.password } : {}) });

  const config = await readConfig(root);
  if (!config) throw new Error('config missing after init');
  await writeConfig(root, { ...config, providers: [...config.providers, localProvider('p3', providerDirs[3])] });

  return { root, providerDirs, io };
}

async function cleanup(dirs: string[]): Promise<void> {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
}

/**
 * Builds a genuine FORMAT_VERSION 1 vault by hand: unencrypted, flat (non-striped)
 * Reed-Solomon, V1 shard headers. Current `push` only emits V2, so a legacy V1
 * backup can only be produced synthetically. Creates `providerDirs.length` =
 * N+K+1 directories (the last one a spare for a rebuild target) but registers
 * only N+K providers in config — the spare is absent from the manifest.
 */
async function synthesizeV1Vault(opts: { N: number; K: number; vaultName: string }): Promise<{ root: string; providerDirs: string[] }> {
  const { N, K, vaultName } = opts;
  const total = N + K;
  const root = await tmp();
  const providerDirs: string[] = [];
  for (let i = 0; i < total + 1; i++) providerDirs.push(await tmp());

  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');

  const vaultId = randomUUID();
  const { blob } = await packBlob(root, createIgnoreFilter(root), uuidToBuffer(vaultId));
  const blobHash = hashBuffer(blob.subarray(0, blob.length - SHA256_BYTES));
  const payloads = rsEncode(blob, N, K);

  const providers: ProviderConfig[] = [];
  for (let i = 0; i < total; i++) providers.push(localProvider(`p${i}`, providerDirs[i] ?? ''));

  const remotePath = (j: number): string => [providerDirs[j] ?? '', vaultName, `shard_${j}.bfs.1`].join('/').replace(/\\/g, '/');
  const locationMap: ShardLocation[] = providers.map((pc, j) => ({
    shard_index: j,
    provider_id: pc.id,
    provider_type: 'local',
    adapterPackage: null,
    connection_config: { path: providerDirs[j] ?? '' },
    required_inputs: null,
    remote_path: remotePath(j),
    shard_hash: hashBuffer(payloads[j] ?? Buffer.alloc(0)),
  }));

  for (let i = 0; i < total; i++) {
    const header: ShardHeader = {
      magic: 'BFSS',
      format_version: 1,
      vault_id: vaultId,
      vault_name: vaultName,
      blob_size: BigInt(blob.length),
      blob_hash: blobHash,
      data_shards: N,
      parity_shards: K,
      shard_index: i,
      version: 1,
      encrypted: false,
      kdf_salt: null,
      rs_stripe_size: null,
      map_length: 0,
      location_map: locationMap,
    };
    const shard = buildShard(header, payloads[i] ?? Buffer.alloc(0));
    const dir = path.join(providerDirs[i] ?? '', vaultName);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `shard_${i}.bfs.1`), shard);
  }

  const config: VaultConfig = {
    vault_id: vaultId,
    vault_name: vaultName,
    version: 1,
    scheme: { data_shards: N, parity_shards: K },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: false, algorithm: 'deflate' },
    push_mode: PushMode.NewVersion,
    providers,
    max_ram_mb: null,
  };
  await fs.mkdir(path.join(root, '.bfs', 'manifests'), { recursive: true });
  await writeConfig(root, config);
  await writeState(root, { latest_version: 1, working_version: 1 });

  const manifest: VersionManifest = {
    version: 1,
    pushed_at: new Date().toISOString(),
    file_count: 2,
    total_size: 6,
    blob_hash: blobHash,
    scheme: { data_shards: N, parity_shards: K },
    encrypted: false,
    shards: providers.map((pc, j) => ({ shard_index: j, provider_id: pc.id, provider_type: 'local', remote_path: remotePath(j), shard_hash: hashBuffer(payloads[j] ?? Buffer.alloc(0)) })),
    health: VersionHealth.Healthy,
  };
  await writeManifest(root, manifest);

  return { root, providerDirs };
}

// A legacy FORMAT_VERSION 1 backup must survive heal and disaster recovery on a
// modern BFS that itself only writes V2. The heal/recovery code dispatches on the
// format read from existing shards, so these guard that a V1 version stays V1 and
// still decodes — neither silently upgraded to V2 nor mis-read as the wrong format.
describe('legacy V1 vault heal + recovery', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await cleanup(dirs);
  });

  it('should restore a synthesized V1 vault unchanged (sanity)', async () => {
    const { root, providerDirs } = await synthesizeV1Vault({ N: 2, K: 1, vaultName: 'legacy-v1' });
    dirs = [root, ...providerDirs];
    const { io } = createMockProviderIO();

    await pull(root, { io, force: true });
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('bbb');
  });

  it('should keep format V1 and still decode when rebuilding a V1 shard (load-bearing)', async () => {
    const { root, providerDirs } = await synthesizeV1Vault({ N: 2, K: 1, vaultName: 'legacy-v1' });
    dirs = [root, ...providerDirs];
    const { io } = createMockProviderIO();

    // Add the spare dir as a heal target, then rebuild shard_2 (p2) onto it.
    const cfg = await readConfig(root);
    if (!cfg) throw new Error('config missing');
    await writeConfig(root, { ...cfg, providers: [...cfg.providers, localProvider('p3', providerDirs[3] ?? '')] });
    await rebuildVersion(root, 1, { removedProviderId: 'p2', targetProviderId: 'p3', io });

    // The rebuilt shard must stay FORMAT_VERSION 1 — matching its siblings.
    const rebuilt = await fs.readFile(path.join(providerDirs[3] ?? '', 'legacy-v1', 'shard_2.bfs.1'));
    const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(rebuilt));
    payloadStream.on('error', () => {}).destroy();
    expect(header.format_version).toBe(1);

    // Drop removed p2 from config (count must match scheme) and make the rebuilt
    // shard load-bearing by deleting a healthy original (shard_0 on p0).
    const cfg2 = await readConfig(root);
    if (!cfg2) throw new Error('config missing');
    await writeConfig(root, { ...cfg2, providers: cfg2.providers.filter((p) => p.id !== 'p2') });
    await fs.rm(path.join(providerDirs[0] ?? '', 'legacy-v1', 'shard_0.bfs.1'));

    await pull(root, { io, force: true });
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('bbb');
  });

  it('should recover a V1 vault after relocate and still decode', async () => {
    const { root, providerDirs } = await synthesizeV1Vault({ N: 2, K: 1, vaultName: 'legacy-v1' });
    const relocatedDir = await tmp();
    dirs = [root, ...providerDirs, relocatedDir];
    const { io } = createMockProviderIO();

    await fs.cp(path.join(providerDirs[1] ?? '', 'legacy-v1'), path.join(relocatedDir, 'legacy-v1'), { recursive: true });
    await relocateProvider(root, 'p1', { newConnectionConfig: { path: relocatedDir }, io });

    await fs.rm(path.join(root, '.bfs'), { recursive: true, force: true });
    const bootstrap = providerRegistry.create(localProvider('p0', providerDirs[0] ?? ''), io);
    await bootstrap.authenticate();
    await recover(root, { vaultName: 'legacy-v1', provider: bootstrap, io });

    await pull(root, { io, force: true });
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(await fs.readFile(path.join(root, 'b.txt'), 'utf-8')).toBe('bbb');
  });
});

// These tests exercise heal.ts's header read path (extractShardMeta +
// updateLocationMaps). That path reads each shard header from an in-memory
// Buffer; a streaming parser left here would either leak (drain never resolves
// without a consumer) or crash on a corrupt shard (destroyed stream with no
// 'error' listener). Healing a real vault end-to-end and asserting the result
// is Healthy guards that the synchronous Buffer parser stays correct.
describe('rebuildVersion (RS heal)', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await cleanup(dirs);
  });

  it('should rebuild a missing shard onto a new provider for an unencrypted vault', async () => {
    const setup = await setupVault({ encrypted: false });
    dirs = [setup.root, ...setup.providerDirs];

    await rebuildVersion(setup.root, 1, { removedProviderId: 'p2', targetProviderId: 'p3', io: setup.io });

    const healed = path.join(setup.providerDirs[3], 'heal-test', 'shard_2.bfs.1');
    await expect(fs.access(healed)).resolves.toBeUndefined();

    const manifest = await readManifest(setup.root, 1);
    expect(manifest?.shards.find((s) => s.shard_index === 2)?.provider_id).toBe('p3');

    const status = await verifyVersion(setup.root, 1, setup.io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should rebuild a missing shard for an encrypted vault using the password', async () => {
    const password = 'correct horse battery staple';
    const setup = await setupVault({ encrypted: true, password });
    dirs = [setup.root, ...setup.providerDirs];

    await rebuildVersion(setup.root, 1, { removedProviderId: 'p2', targetProviderId: 'p3', io: setup.io, password });

    const healed = path.join(setup.providerDirs[3], 'heal-test', 'shard_2.bfs.1');
    await expect(fs.access(healed)).resolves.toBeUndefined();

    const status = await verifyVersion(setup.root, 1, setup.io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  // A rebuilt shard must be byte-compatible with the V2 striped + per-shard-GCM
  // format the rest of the version uses, so a later pull can reconstruct from it.
  // verifyVersion only inspects the header window, so it cannot catch a broken
  // payload — this drives the rebuilt shard to be load-bearing and decodes it.
  it('should rebuild an encrypted shard that still decodes when it is load-bearing', async () => {
    const password = 'correct horse battery staple';
    const setup = await setupVault({ encrypted: true, password });
    dirs = [setup.root, ...setup.providerDirs];

    await rebuildVersion(setup.root, 1, { removedProviderId: 'p2', targetProviderId: 'p3', io: setup.io, password });

    // Mirror removeProvider's config surgery: drop the removed provider so the
    // provider count matches the scheme (pull asserts providers.length === N+K).
    const config = await readConfig(setup.root);
    if (!config) throw new Error('config missing after rebuild');
    await writeConfig(setup.root, { ...config, providers: config.providers.filter((p) => p.id !== 'p2') });

    // Make the rebuilt shard_2 load-bearing: drop one healthy original (shard_0
    // on p0). Reaching N=2 now requires the rebuilt shard — a correct heal still
    // restores byte-for-byte; the buggy heal produces an undecryptable shard.
    await fs.rm(path.join(setup.providerDirs[0], 'heal-test', 'shard_0.bfs.1'));

    await pull(setup.root, { io: setup.io, password, force: true });

    expect(await fs.readFile(path.join(setup.root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(await fs.readFile(path.join(setup.root, 'b.txt'), 'utf-8')).toBe('bbb');
  });

  // Companion to the test above: rebuilding a DATA shard (index 0) exercises the
  // striped reconstruct branch, where the parity-shard case above only re-encodes.
  it('should rebuild an encrypted DATA shard that still decodes when it is load-bearing', async () => {
    const password = 'correct horse battery staple';
    const setup = await setupVault({ encrypted: true, password });
    dirs = [setup.root, ...setup.providerDirs];

    await rebuildVersion(setup.root, 1, { removedProviderId: 'p0', targetProviderId: 'p3', io: setup.io, password });

    const config = await readConfig(setup.root);
    if (!config) throw new Error('config missing after rebuild');
    await writeConfig(setup.root, { ...config, providers: config.providers.filter((p) => p.id !== 'p0') });

    // Drop a healthy original (shard_1 on p1) so reaching N=2 needs the rebuilt
    // data shard_0 (now on p3).
    await fs.rm(path.join(setup.providerDirs[1], 'heal-test', 'shard_1.bfs.1'));

    await pull(setup.root, { io: setup.io, password, force: true });

    expect(await fs.readFile(path.join(setup.root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(await fs.readFile(path.join(setup.root, 'b.txt'), 'utf-8')).toBe('bbb');
  });
});

describe('rebuildVersion secret stripping', () => {
  let allDirs: string[];

  beforeEach(() => {
    registerSecretProvider();
    allDirs = [];
  });

  afterEach(async () => {
    unregisterSecretProvider();
    await cleanup(allDirs);
  });

  it('should rebuild a shard without leaking provider secrets into any location map', async () => {
    const root = await tmp();
    const providerDirs = [await tmp(), await tmp(), await tmp(), await tmp()];
    allDirs = [root, ...providerDirs];
    const { io } = createMockProviderIO();

    await init(root, {
      vault_name: 'heal-test',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: providerDirs.slice(0, 3).map((d, i) => secretProviderConfig(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
    await push(root, { io });

    const config = await readConfig(root);
    if (!config) throw new Error('config missing after init');
    await writeConfig(root, { ...config, providers: [...config.providers, secretProviderConfig('p3', providerDirs[3] ?? '')] });

    await rebuildVersion(root, 1, { removedProviderId: 'p2', targetProviderId: 'p3', io });

    // Inspect both the rebuilt shard (target p3, index 2) and a refreshed
    // existing shard (p0, index 0) whose map was rewritten by updateLocationMaps.
    for (const [shardIndex, dirIndex] of [
      [2, 3],
      [0, 0],
    ] as const) {
      const shardBytes = await fs.readFile(path.join(providerDirs[dirIndex] ?? '', 'heal-test', `shard_${shardIndex}.bfs.1`));
      const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(shardBytes));
      payloadStream.on('error', () => {}).destroy();
      for (const loc of header.location_map) {
        expect(loc.connection_config.password).toBeUndefined();
        expect(loc.connection_config.path).toBeDefined();
        expect(loc.required_inputs).toEqual(['password']);
      }
    }
  });
});

// Recovery rebuilds .bfs/ from shard headers alone. relocate (and rebuild)
// rewrite those headers via updateLocationMaps, so recovery's view of the format
// depends on what that rewrite preserves. This guards that a recovered encrypted
// V2 vault still decodes byte-for-byte after a relocate.
describe('recovery after relocate', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await cleanup(dirs);
  });

  it('should recover an encrypted vault after relocate and still decode at pull', async () => {
    const password = 'correct horse battery staple';
    const setup = await setupVault({ encrypted: true, password });
    const relocatedDir = await tmp();
    dirs = [setup.root, ...setup.providerDirs, relocatedDir];

    // Drop the unused spare provider so the count matches the 2+1 scheme (pull
    // asserts providers.length === N+K); relocate reuses p1's id at a new path.
    const cfg0 = await readConfig(setup.root);
    if (!cfg0) throw new Error('config missing after setup');
    await writeConfig(setup.root, { ...cfg0, providers: cfg0.providers.filter((p) => p.id !== 'p3') });

    // Move p1's storage to a new path, then relocate (rewrites every shard header).
    await fs.cp(path.join(setup.providerDirs[1], 'heal-test'), path.join(relocatedDir, 'heal-test'), { recursive: true });
    await relocateProvider(setup.root, 'p1', { newConnectionConfig: { path: relocatedDir }, io: setup.io, password });

    // Sanity: manifest-driven pull still works — not the failure under test.
    await pull(setup.root, { io: setup.io, password, force: true });
    expect(await fs.readFile(path.join(setup.root, 'a.txt'), 'utf-8')).toBe('aaa');

    // Disaster: lose .bfs/, then rebuild it from a shard header relocate rewrote.
    await fs.rm(path.join(setup.root, '.bfs'), { recursive: true, force: true });
    const bootstrap = providerRegistry.create(localProvider('p0', setup.providerDirs[0]), setup.io);
    await bootstrap.authenticate();
    await recover(setup.root, { vaultName: 'heal-test', provider: bootstrap, io: setup.io, passwords: [password] });

    await pull(setup.root, { io: setup.io, password, force: true });
    expect(await fs.readFile(path.join(setup.root, 'a.txt'), 'utf-8')).toBe('aaa');
    expect(await fs.readFile(path.join(setup.root, 'b.txt'), 'utf-8')).toBe('bbb');
  });
});

describe('relocateProvider secret stripping', () => {
  let allDirs: string[];

  beforeEach(() => {
    registerSecretProvider();
    allDirs = [];
  });

  afterEach(async () => {
    unregisterSecretProvider();
    await cleanup(allDirs);
  });

  it('should rewrite location maps after relocation without leaking the new provider secret', async () => {
    const root = await tmp();
    const providerDirs = [await tmp(), await tmp(), await tmp()];
    const newDir = await tmp();
    allDirs = [root, ...providerDirs, newDir];
    const { io } = createMockProviderIO();

    await init(root, {
      vault_name: 'heal-test',
      scheme: { data_shards: 2, parity_shards: 1 },
      encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
      providers: providerDirs.map((d, i) => secretProviderConfig(`p${i}`, d)),
      push_mode: PushMode.NewVersion,
      io,
    });
    await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
    await push(root, { io });

    // The shard physically moved to a new address; relocate verifies it exists
    // there before rewriting the location maps.
    await fs.cp(providerDirs[1] ?? '', newDir, { recursive: true });

    await relocateProvider(root, 'p1', { newConnectionConfig: { path: newDir, password: 'pw-p1' }, io });

    // The relocated shard (p1, index 1, now under newDir) and an untouched
    // shard (p0, index 0) must both carry a stripped map — including the
    // relocated provider's freshly supplied secret.
    for (const [shardIndex, dir] of [
      [1, newDir],
      [0, providerDirs[0] ?? ''],
    ] as const) {
      const shardBytes = await fs.readFile(path.join(dir, 'heal-test', `shard_${shardIndex}.bfs.1`));
      const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(shardBytes));
      payloadStream.on('error', () => {}).destroy();
      for (const loc of header.location_map) {
        expect(loc.connection_config.password).toBeUndefined();
        expect(loc.connection_config.path).toBeDefined();
        expect(loc.required_inputs).toEqual(['password']);
      }
    }
  });
});
