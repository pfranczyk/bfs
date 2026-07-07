import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildShardHeaderFromBytes, buildSidecarBytes, computeShardHeaderSize } from '../../src/core/shard-io.js';
// Importing LocalFsProvider registers its factory in the global ProviderRegistry,
// which init/push/verify resolve by string "local".
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderIO } from '../../src/types/index.js';
import { type ProviderConfig, PushMode, VersionHealth } from '../../src/types/index.js';
import { init, push } from '../../src/vault/vault-manager.js';
import { verifyVersion } from '../../src/vault/verify.js';

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-verify-'));
}

function localProvider(id: string, dir: string): ProviderConfig {
  return { id, type: 'local', adapterPackage: null, config: { path: dir } };
}

function mockIO(): { io: ProviderIO; warnings: string[] } {
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

async function setupVault(): Promise<{ root: string; providerDirs: string[]; io: ProviderIO; warnings: string[] }> {
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
    const truncated = path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1');
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
    const tampered = path.join(setup.providerDirs[1], 'verify-test', 'shard_1.bfs.1');
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

// ─── Header-sidecar advisory detection ────────────────────────────────────────
//
// verify exposes a per-version `header_advisory: { missing; broken } | null`,
// computed over reachable providers only. Rule (asymmetry): report counts only
// when at least one shard has a VALID sidecar AND ≥1 shard has a MISSING or
// BROKEN one; all-valid, all-missing, and non-sidecar providers → null.
//
// Sidecar state per shard: VALID = downloadHeaderSidecar returns bytes that
// extractSidecarHeaderBytes parses; MISSING = returns null; BROKEN = returns
// bytes that extractSidecarHeaderBytes rejects (ShardCorruptedError).
//
// Data health is read from the IN-SHARD header, so it is immune to sidecar
// state: a BROKEN sidecar keeps the version Healthy with full availability —
// only header_advisory reflects it.

const SIDECAR_VAULT = 'verify-test';

/**
 * Writes a VALID hdr_ sidecar next to shard_i by re-serializing the shard's own
 * (unencrypted) in-shard header into BFSH form — so it parses cleanly and its
 * identity matches the manifest.
 */
async function writeValidSidecar(providerDir: string, shardIndex: number, version = 1): Promise<void> {
  const shardPath = path.join(providerDir, SIDECAR_VAULT, `shard_${shardIndex}.bfs.${version}`);
  const shardBytes = await fs.readFile(shardPath);
  const headerSize = computeShardHeaderSize(shardBytes);
  const header = buildShardHeaderFromBytes(shardBytes.subarray(0, headerSize));
  const hdrPath = path.join(providerDir, SIDECAR_VAULT, `hdr_${shardIndex}.bfs.${version}`);
  await fs.writeFile(hdrPath, buildSidecarBytes(header));
}

/** Writes a BROKEN hdr_ sidecar (non-BFSH bytes) that extractSidecarHeaderBytes rejects. */
async function writeBrokenSidecar(providerDir: string, shardIndex: number, version = 1): Promise<void> {
  const hdrPath = path.join(providerDir, SIDECAR_VAULT, `hdr_${shardIndex}.bfs.${version}`);
  await fs.writeFile(hdrPath, Buffer.from('GARBAGE-NOT-BFSH'));
}

describe('verifyVersion header_advisory (sidecar header detection)', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    await cleanup(dirs);
  });

  it('should report header_advisory=null when every shard has a valid sidecar', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    for (let i = 0; i < 3; i++) await writeValidSidecar(setup.providerDirs[i], i);

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.header_advisory).toBeNull();
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should report header_advisory=null when no shard has a sidecar (no valid sibling)', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // A fresh push writes no sidecars — every shard is MISSING, none VALID.

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.header_advisory).toBeNull();
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should report {missing:1,broken:0} when one sidecar is missing beside valid siblings', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    await writeValidSidecar(setup.providerDirs[0], 0);
    await writeValidSidecar(setup.providerDirs[1], 1);
    // shard_2: no sidecar → MISSING.

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.header_advisory).toEqual({ missing: 1, broken: 0 });
  });

  it('should report {missing:0,broken:1} when one sidecar is broken beside valid siblings', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    await writeValidSidecar(setup.providerDirs[0], 0);
    await writeValidSidecar(setup.providerDirs[1], 1);
    await writeBrokenSidecar(setup.providerDirs[2], 2);

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.header_advisory).toEqual({ missing: 0, broken: 1 });
  });

  // The in-shard header is intact, so a broken sidecar must NOT reduce
  // availability — the version stays Healthy and full. Kept separate from the
  // advisory assertion so it stands on its own.
  it('should keep a broken-sidecar version Healthy with full availability', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    await writeValidSidecar(setup.providerDirs[0], 0);
    await writeValidSidecar(setup.providerDirs[1], 1);
    await writeBrokenSidecar(setup.providerDirs[2], 2);

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.health).toBe(VersionHealth.Healthy);
    expect(status.available_shards).toBe(status.total_shards);
  });
});

// A provider whose medium rewrites the header in place (usesSidecar() === false)
// never contributes to the sidecar advisory. Its sidecar methods MUST throw per
// the contract, so a correctly-guarded advisory computation never calls them.
const NOSIDECAR_TYPE = 'local-nosidecar-test';

class NoSidecarLocalProvider extends LocalFsProvider {
  usesSidecar(): boolean {
    return false;
  }

  async uploadHeaderSidecar(): Promise<void> {
    throw new Error('usesSidecar() is false — sidecar methods must not be called');
  }

  async downloadHeaderSidecar(): Promise<Buffer | null> {
    throw new Error('usesSidecar() is false — sidecar methods must not be called');
  }
}

function registerNoSidecarProvider(): void {
  providerRegistry.register(NOSIDECAR_TYPE, {
    lang: 'en',
    displayName: 'Local no-sidecar (tests)',
    create: (config: ProviderConfig, io: ProviderIO) => new NoSidecarLocalProvider(config, io),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

function unregisterNoSidecarProvider(): void {
  (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(NOSIDECAR_TYPE);
}

async function setupNoSidecarVault(): Promise<{ root: string; providerDirs: string[]; io: ProviderIO }> {
  const root = await tmp();
  const providerDirs = [await tmp(), await tmp(), await tmp()];
  const { io } = createMockProviderIO();
  await init(root, {
    vault_name: SIDECAR_VAULT,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: false, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: providerDirs.map((d, i) => ({ id: `p${i}`, type: NOSIDECAR_TYPE, adapterPackage: null, config: { path: d } })),
    push_mode: PushMode.NewVersion,
    io,
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io });
  return { root, providerDirs, io };
}

describe('verifyVersion header_advisory — non-sidecar providers', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
    registerNoSidecarProvider();
  });

  afterEach(async () => {
    unregisterNoSidecarProvider();
    await cleanup(dirs);
  });

  it('should report header_advisory=null when no provider uses sidecars', async () => {
    const setup = await setupNoSidecarVault();
    dirs = [setup.root, ...setup.providerDirs];

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.header_advisory).toBeNull();
    expect(status.health).toBe(VersionHealth.Healthy);
  });
});
