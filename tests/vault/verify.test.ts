import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// Importing LocalFsProvider registers its factory in the global ProviderRegistry,
// which init/push/verify resolve by string "local".
import '../../src/providers/local-fs.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO } from '../../src/types/index.js';
import { PushMode, VersionHealth } from '../../src/types/index.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-verify-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function mockIO(): {
  io: ProviderIO;
  warnings: string[];
} {
  const warnings: string[] = [];
  const { io } = createMockProviderIO();
  // Wrap warn to capture verify warnings without losing the underlying mock
  // (createMockProviderIO records logs internally too).
  const original = io.warn.bind(io);
  io.warn = (msg: string) => {
    warnings.push(msg);
    original(msg);
  };
  return { io, warnings };
}

async function setupVault(): Promise<{
  root: string;
  providerDirs: string[];
  io: ProviderIO;
  warnings: string[];
}> {
  const root = await tmp();
  const providerDirs = [await tmp(), await tmp(), await tmp()];
  const m = mockIO();
  await init(root, {
    vault_name: 'verify-test',
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: providerDirs.map((d, i) => localProvider(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io: m.io,
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io: m.io });
  return { root, providerDirs, io: m.io, warnings: m.warnings };
}

async function cleanup(dirs: string[]): Promise<void> {
  for (const d of dirs) await fs.rm(d, { recursive: true, force: true });
}

describe('verifyVersion (integrity check)', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await cleanup(dirs);
  });

  it('should report Healthy when every shard is intact', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.health).toBe(VersionHealth.Healthy);
    expect(status.available_shards).toBe(3);
  });

  it('should mark a shard unavailable when its file is empty (size 0)', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Truncate shard_0 on provider p0 to 0 bytes — getSize returns 0.
    const truncated = path.join(
      setup.providerDirs[0],
      'verify-test',
      'shard_0.bfs.1',
    );
    await fs.writeFile(truncated, Buffer.alloc(0));

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    expect(setup.warnings.some((w) => w.includes('size=0'))).toBe(true);
  });

  it('should mark a shard unavailable when its header has been tampered', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Corrupt shard_1 by flipping a byte inside the version field. The
    // header reports a different version than the manifest, so verify must
    // refuse it.
    const tampered = path.join(
      setup.providerDirs[1],
      'verify-test',
      'shard_1.bfs.1',
    );
    const buf = await fs.readFile(tampered);
    // Find the version field — magic(4) + format_version(1) + uuid(16) +
    // vault_name_len(2) + vault_name(N) + blob_size(8) + blob_hash(32) +
    // N(1) + K(1) + shard_index(1) = byte offset of version. Easier: just
    // flip the magic byte so parseShardHeaderFromStream rejects the stream
    // outright — covers the same failure path.
    buf[0] ^= 0xff;
    await fs.writeFile(tampered, buf);

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    expect(setup.warnings.some((w) => w.includes('shard_1.bfs.1'))).toBe(true);
  });
});
