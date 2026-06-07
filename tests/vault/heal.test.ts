import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Importing LocalFsProvider registers its factory in the global ProviderRegistry,
// which init/push/heal resolve by string "local".
import '../../src/providers/local-fs.js';
import { parseShardHeaderFromStream } from '../../src/core/shard-io.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { rebuildVersion, relocateProvider } from '../../src/vault/heal.js';
import { readManifest } from '../../src/vault/manifest.js';
import { init, push } from '../../src/vault/vault-manager.js';
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
