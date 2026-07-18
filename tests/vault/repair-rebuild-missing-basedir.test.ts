import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { readConfig, writeConfig } from '../../src/vault/config.js';
import { rebuildShardInPlace, rebuildVersion } from '../../src/vault/heal.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';

// Regression for the repair-rebuild-onto-missing-base-dir bug (cli-e2e
// 86-repair-disk-failure-ssh + 87-repair-server-replaced-ssh RED,
// 89-repair-disk-failure-ftp control green). `uploadRepairedShard` in
// src/vault/heal.ts calls the target provider's authenticate() BEFORE upload.
// SSH's authenticate() (src/providers/ssh.ts) lists the base path and hard-fails
// when it is absent — the exact state of a rebuild target after a disk wipe / on
// a fresh server. upload() would create the directory itself (ensureDir), so the
// pre-upload authenticate() is what breaks rebuild. Local and FTP are immune
// because their authenticate() provisions (local) or lists leniently (FTP), so
// this must be proven at the heal level, not in a provider unit — the defect is
// in how the rebuild path drives the provider, not in any provider.

const STRICT_TYPE = 'strict-readdir-ssh-test';

/**
 * Local-disk provider that models SSH's authenticate() (src/providers/ssh.ts):
 * it lists the base path and hard-fails (ENOENT) when the base directory is
 * absent, WITHOUT provisioning it. The inherited upload() still creates the
 * directory tree (mkdir), mirroring SSH's ensureDir — so the medium is
 * provisionable by the upload itself, and the only thing standing in the way is
 * the strict pre-upload authenticate(). Contrast LocalFsProvider.authenticate,
 * which creates the missing directory (the built-in A/B control below).
 */
class StrictReaddirProvider extends LocalFsProvider {
  private readonly baseForTest: string;

  constructor(config: ProviderConfig, io: ProviderIO) {
    super(config, io);
    this.baseForTest = typeof config.config.path === 'string' ? config.config.path : '';
  }

  async authenticate(): Promise<void> {
    await fs.readdir(this.baseForTest); // rejects with ENOENT when the base dir is gone
  }
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-rebuild-basedir-'));
}

function provider(id: string, type: string, dir: string): ProviderConfig {
  return { id, type, adapterPackage: null, config: { path: dir } };
}

/**
 * Builds a 2+1 vault on p0/p1 (local) + p2 (of the given type), pushes two files,
 * then registers a spare p3 (STRICT_TYPE) as a rebuild target absent from the v1
 * manifest. Non-interactive IO throughout, mirroring repair --ci.
 */
async function setupVault(p2Type: string): Promise<{ root: string; providerDirs: string[]; io: ProviderIO }> {
  const root = await tmp();
  const providerDirs = [await tmp(), await tmp(), await tmp(), await tmp()];
  const io = createMockProviderIO({}, root, false).io;

  await init(root, {
    vault_name: 'vault',
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: [provider('p0', 'local', providerDirs[0] ?? ''), provider('p1', 'local', providerDirs[1] ?? ''), provider('p2', p2Type, providerDirs[2] ?? '')],
    push_mode: PushMode.NewVersion,
    io,
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io });

  const cfg = await readConfig(root);
  if (!cfg) throw new Error('config missing after setup');
  await writeConfig(root, { ...cfg, providers: [...cfg.providers, provider('p3', STRICT_TYPE, providerDirs[3] ?? '')] });

  return { root, providerDirs, io };
}

describe('repair --rebuild onto a medium whose base dir is absent', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
    providerRegistry.register(STRICT_TYPE, {
      lang: 'en',
      displayName: 'Strict-readdir SSH stand-in (tests)',
      create: (config: ProviderConfig, io: ProviderIO) => new StrictReaddirProvider(config, io),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
  });

  afterEach(async () => {
    (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(STRICT_TYPE);
    for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
  });

  it('should rebuild a lost shard in place when the SSH base dir was wiped (disk failure)', async () => {
    const { root, providerDirs, io } = await setupVault(STRICT_TYPE);
    dirs = [root, ...providerDirs];

    const base = providerDirs[2] ?? '';
    const shard = path.join(base, 'vault', 'shard_2.bfs.1');
    expect(existsSync(shard)).toBe(true);

    // Disk failure at the same location: the whole medium (base dir + shard) is gone.
    await fs.rm(base, { recursive: true, force: true });
    expect(existsSync(base)).toBe(false);

    await rebuildShardInPlace(root, 1, { providerId: 'p2', io });

    // The reconstructed shard is back at the original location.
    expect(existsSync(shard)).toBe(true);
    const status = await verifyVersion(root, 1, io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should rebuild-migrate a shard onto a fresh SSH server whose base dir does not exist yet', async () => {
    const { root, providerDirs, io } = await setupVault(STRICT_TYPE);
    dirs = [root, ...providerDirs];

    // Fresh replacement server: the target base dir does not exist yet.
    const p3base = providerDirs[3] ?? '';
    await fs.rm(p3base, { recursive: true, force: true });
    expect(existsSync(p3base)).toBe(false);

    await rebuildVersion(root, 1, { removedProviderId: 'p2', targetProviderId: 'p3', io });

    const migrated = path.join(p3base, 'vault', 'shard_2.bfs.1');
    expect(existsSync(migrated)).toBe(true);
    const status = await verifyVersion(root, 1, io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  // A/B control: an identical rebuild onto a provisioning medium (built-in local,
  // whose authenticate() creates the missing base dir) succeeds on the same code
  // path — proving the strict pre-upload authenticate() is the discriminator, not
  // "rebuild to a missing dir" in general. Mirrors 89-repair-disk-failure-ftp
  // (green) beside 86 (red).
  it('should rebuild in place onto a provisioning medium (local) with a wiped base dir — control', async () => {
    const { root, providerDirs, io } = await setupVault('local');
    dirs = [root, ...providerDirs];

    const base = providerDirs[2] ?? '';
    await fs.rm(base, { recursive: true, force: true });

    await rebuildShardInPlace(root, 1, { providerId: 'p2', io });

    expect(existsSync(path.join(base, 'vault', 'shard_2.bfs.1'))).toBe(true);
    const status = await verifyVersion(root, 1, io);
    expect(status.health).toBe(VersionHealth.Healthy);
  });
});
