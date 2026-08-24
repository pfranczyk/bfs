import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildShardHeaderFromBytes, buildSidecarBytes, computeShardHeaderSize } from '../../src/core/shard-io.js';
import { setLang } from '../../src/i18n/index.js';
// Importing LocalFsProvider registers its factory in the global ProviderRegistry,
// which init/push/verify resolve by string "local".
import { LocalFsProvider } from '../../src/providers/local-fs.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderIO, RemoteRef } from '../../src/types/index.js';
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

const ENCRYPTED_VAULT = 'verify-enc-test';
const ENCRYPTED_PASSWORD = 'verify-deep-pass-123';

/**
 * Builds a real 2/1 local vault with encryption enabled and pushes version 1,
 * supplying the password through the push options. Mirrors setupVault for the
 * encrypted path - used to prove deep verify is password-free.
 */
async function setupEncryptedVault(): Promise<{ root: string; providerDirs: string[]; io: ProviderIO; warnings: string[] }> {
  const root = await tmp();
  const providerDirs = [await tmp(), await tmp(), await tmp()];
  const m = mockIO();
  await init(root, {
    vault_name: ENCRYPTED_VAULT,
    scheme: { data_shards: 2, parity_shards: 1 },
    encryption: { enabled: true, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    providers: providerDirs.map((d, i) => localProvider(`p${i}`, d)),
    push_mode: PushMode.NewVersion,
    io: m.io,
  });
  await fs.writeFile(path.join(root, 'a.txt'), 'aaa', 'utf-8');
  await fs.writeFile(path.join(root, 'b.txt'), 'bbb', 'utf-8');
  await push(root, { io: m.io, password: ENCRYPTED_PASSWORD });
  return { root, providerDirs, io: m.io, warnings: m.warnings };
}

/**
 * Flips a single byte in the middle of a shard's RS payload - the region
 * between the in-shard header and the trailing 32-byte SHA-256 checksum -
 * leaving the header untouched and NOT recomputing the checksum. This
 * simulates bit-rot: the trailing SHA-256 no longer matches, yet a
 * header-only (shallow) verify stays blind to it because the header window
 * still parses and matches the manifest.
 */
async function flipPayloadByte(shardPath: string): Promise<void> {
  const buf = await fs.readFile(shardPath);
  const headerSize = computeShardHeaderSize(buf);
  const payloadEnd = buf.length - 32; // exclude the trailing SHA-256 checksum
  const flipAt = headerSize + Math.floor((payloadEnd - headerSize) / 2);
  buf[flipAt] ^= 0xff;
  await fs.writeFile(shardPath, buf);
}

describe('verifyVersion (integrity check)', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
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
    // Truncate shard_0 on provider p0 to 0 bytes - getSize returns 0.
    const truncated = path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1');
    await fs.writeFile(truncated, Buffer.alloc(0));

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    expect(setup.warnings.some((w) => w.includes('size=0'))).toBe(true);
  });

  // The three checks below pin WHY a part is missing, not just that it is. A
  // bare count reads identically for a switched-off medium, a stale address and
  // a deleted file, yet those call for opposite moves (bring the medium back vs
  // rebuild the part), so verify has to name the cause it observed.
  it('should name the file and the provider when the part is gone from a reachable medium', async () => {
    setLang('en');
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    await fs.rm(path.join(setup.providerDirs[2], 'verify-test', 'shard_2.bfs.1'));

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    const warning = setup.warnings.find((w) => w.includes('shard_2.bfs.1'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"p2"');
    expect(warning).toContain('missing or unreadable');
    // A medium that answered is not accused of failing an integrity check -
    // nothing was read, so nothing about the bytes was learned.
    expect(warning).not.toContain('failed integrity check');
  });

  it('should name the unreachable medium instead of silently dropping the part', async () => {
    setLang('en');
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // The whole medium goes away (drive unplugged, share unmounted), not just
    // the file: healthCheck fails before anything is read.
    await fs.rm(setup.providerDirs[2], { recursive: true, force: true });

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    const warning = setup.warnings.find((w) => w.includes('shard_2.bfs.1'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"p2"');
    expect(warning).toContain('unreachable');
    // An unread part is not reported as a missing file: the operator must be
    // able to tell "plug the medium back in" from "rebuild the part".
    expect(warning).not.toContain('missing or unreadable');
  });

  it('should name a medium whose adapter is not installed as such, not as unreachable', async () => {
    setLang('en');
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // The version records a medium whose adapter this installation does not
    // carry. Nothing is contacted, so blaming the connection would send the
    // operator after a cable instead of the missing adapter.
    const configPath = path.join(setup.root, '.bfs', 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    for (const p of config.providers) {
      if (p.id === 'p2') p.type = 'no-such-type';
    }
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    const warning = setup.warnings.find((w) => w.includes('shard_2.bfs.1'));
    expect(warning).toBeDefined();
    expect(warning).toContain('needs an adapter that is not installed');
    expect(warning).not.toContain('is unreachable');
  });

  it('should name the provider a version still uses but the configuration no longer knows', async () => {
    setLang('en');
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    const configPath = path.join(setup.root, '.bfs', 'config.json');
    const config = JSON.parse(await fs.readFile(configPath, 'utf-8'));
    config.providers = config.providers.filter((p: { id: string }) => p.id !== 'p2');
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    const warning = setup.warnings.find((w) => w.includes('shard_2.bfs.1'));
    expect(warning).toBeDefined();
    expect(warning).toContain('"p2"');
    expect(warning).toContain('no longer in the configuration');
  });

  it('should mark a shard unavailable when its header has been tampered', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Corrupt shard_1 by flipping a byte inside the version field. The
    // header reports a different version than the manifest, so verify must
    // refuse it.
    const tampered = path.join(setup.providerDirs[1], 'verify-test', 'shard_1.bfs.1');
    const buf = await fs.readFile(tampered);
    // Find the version field - magic(4) + format_version(1) + uuid(16) +
    // vault_name_len(2) + vault_name(N) + blob_size(8) + blob_hash(32) +
    // N(1) + K(1) + shard_index(1) = byte offset of version. Easier: just
    // flip the magic byte so parseShardHeaderFromStream rejects the stream
    // outright - covers the same failure path.
    buf[0] ^= 0xff;
    await fs.writeFile(tampered, buf);

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    expect(setup.warnings.some((w) => w.includes('shard_1.bfs.1'))).toBe(true);
  });

  it('should mark a shard unavailable in deep mode when a payload byte is corrupted', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Bit-rot inside shard_0's payload: the trailing SHA-256 no longer matches,
    // but the in-shard header stays intact so a shallow verify cannot see it.
    const shardPath = path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1');
    await flipPayloadByte(shardPath);

    const status = await verifyVersion(setup.root, 1, setup.io, { deep: true });

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
    expect(setup.warnings.some((w) => w.includes('shard_0.bfs.1'))).toBe(true);
  });

  it('should stay Healthy in shallow mode under the same payload corruption (blind spot)', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Same payload bit-rot as the deep test - proves the header-only check is
    // blind to payload corruption. Stays green after the deep implementation
    // because shallow mode never streams the payload.
    const shardPath = path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1');
    await flipPayloadByte(shardPath);

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.available_shards).toBe(3);
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should detect payload corruption in deep mode for an encrypted vault without a password', async () => {
    const setup = await setupEncryptedVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Deep verify checks the trailing SHA-256 over the raw shard bytes, so it
    // catches ciphertext bit-rot without ever needing the password.
    const shardPath = path.join(setup.providerDirs[0], ENCRYPTED_VAULT, 'shard_0.bfs.1');
    await flipPayloadByte(shardPath);

    const status = await verifyVersion(setup.root, 1, setup.io, { deep: true });

    expect(status.available_shards).toBe(2);
    expect(status.health).toBe(VersionHealth.Degraded);
  });

  it('should stream each shard payload in deep mode (calls download, not just the header window)', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Deep mode streams the whole shard via provider.download() to verify the
    // payload's trailing SHA-256; the shallow path only pulls the header window
    // (downloadHeader). Spying on download proves the payload is actually read,
    // not just the header.
    const downloadSpy = vi.spyOn(LocalFsProvider.prototype, 'download');

    await verifyVersion(setup.root, 1, setup.io, { deep: true });

    expect(downloadSpy).toHaveBeenCalled();
  });

  it('should keep an intact encrypted vault Healthy in deep mode without a password', async () => {
    const setup = await setupEncryptedVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Deep verify streams ciphertext and checks the trailing SHA-256 over the raw
    // bytes - an intact encrypted vault must verify Healthy without any password.
    const status = await verifyVersion(setup.root, 1, setup.io, { deep: true });

    expect(status.health).toBe(VersionHealth.Healthy);
    expect(status.available_shards).toBe(3);
  });

  it('should destroy every source download stream in deep mode (no leaked connection)', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Corrupt shard_0 so deep verify aborts mid-stream on it; the source stream
    // must still be destroyed (finally), or an FTP/SSH data connection would leak.
    await flipPayloadByte(path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1'));

    const streams: Readable[] = [];
    const realDownload = LocalFsProvider.prototype.download;
    vi.spyOn(LocalFsProvider.prototype, 'download').mockImplementation(async function (this: LocalFsProvider, ref: RemoteRef) {
      const stream = await realDownload.call(this, ref);
      streams.push(stream);
      return stream;
    });

    await verifyVersion(setup.root, 1, setup.io, { deep: true });

    expect(streams.length).toBeGreaterThan(0);
    for (const stream of streams) expect(stream.destroyed).toBe(true);
  });
});

// --- Header-sidecar advisory detection ----------------------------------------
//
// verify exposes a per-version `header_advisory: Nullable<{ missing; broken }>`,
// computed over reachable providers only. Rule (asymmetry): report counts only
// when at least one shard has a VALID sidecar AND >=1 shard has a MISSING or
// BROKEN one; all-valid, all-missing, and non-sidecar providers -> null.
//
// Sidecar state per shard: VALID = downloadHeaderSidecar returns bytes that
// extractSidecarHeaderBytes parses; MISSING = returns null; BROKEN = returns
// bytes that extractSidecarHeaderBytes rejects (ShardCorruptedError).
//
// Data health is read from the IN-SHARD header, so it is immune to sidecar
// state: a BROKEN sidecar keeps the version Healthy with full availability -
// only header_advisory reflects it.

const SIDECAR_VAULT = 'verify-test';

/**
 * Writes a VALID hdr_ sidecar next to shard_i by re-serializing the shard's own
 * (unencrypted) in-shard header into BFSH form - so it parses cleanly and its
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
    // A fresh push writes no sidecars - every shard is MISSING, none VALID.

    const status = await verifyVersion(setup.root, 1, setup.io);

    expect(status.header_advisory).toBeNull();
    expect(status.health).toBe(VersionHealth.Healthy);
  });

  it('should report {missing:1,broken:0} when one sidecar is missing beside valid siblings', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    await writeValidSidecar(setup.providerDirs[0], 0);
    await writeValidSidecar(setup.providerDirs[1], 1);
    // shard_2: no sidecar -> MISSING.

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
  // availability - the version stays Healthy and full. Kept separate from the
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
    throw new Error('usesSidecar() is false - sidecar methods must not be called');
  }

  async downloadHeaderSidecar(): Promise<Nullable<Buffer>> {
    throw new Error('usesSidecar() is false - sidecar methods must not be called');
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

describe('verifyVersion header_advisory - non-sidecar providers', () => {
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

// A verdict recorded on disk must carry how it was reached. A shallow run reads
// ~1 KB of header per shard and cannot observe payload rot at all, so letting it
// overwrite a deep `damaged` erases the only evidence the backup is
// unrecoverable. Today `manifest.health` feeds display paths (`bfs versions`, the
// recovery table); it becomes load-bearing the moment prune consults it to decide
// what may be deleted, which is why provenance is a precondition for that guard.
//
// The stickiness is deliberately narrow: only *detected payload rot* survives a
// shallow pass. A part that was merely unreachable during the deep run must stay
// clearable, or an outage would force a full re-download to retire a verdict that
// no longer describes reality.
describe('verifyVersion health verdict provenance', () => {
  let dirs: string[];

  beforeEach(() => {
    dirs = [];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup(dirs);
  });

  /** Reads the health recorded in the version-1 manifest on disk. */
  async function storedHealth(root: string): Promise<string> {
    const raw = await fs.readFile(path.join(root, '.bfs', 'manifests', 'v001.json'), 'utf-8');
    return (JSON.parse(raw) as { health: string }).health;
  }

  it('should keep a deep damaged verdict when a shallow verify runs afterwards', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // Rot two of three shards: with N=2 only one remains readable, so the
    // version can no longer be reconstructed.
    await flipPayloadByte(path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1'));
    await flipPayloadByte(path.join(setup.providerDirs[1], 'verify-test', 'shard_1.bfs.1'));

    const deep = await verifyVersion(setup.root, 1, setup.io, { deep: true });
    expect(deep.health).toBe(VersionHealth.Damaged);
    expect(await storedHealth(setup.root)).toBe('damaged');

    const shallow = await verifyVersion(setup.root, 1, setup.io);

    expect(shallow.health).toBe(VersionHealth.Damaged);
    expect(shallow.retained_from_deep).toBe(true);
    expect(await storedHealth(setup.root)).toBe('damaged');
    // The stamp must name the pass that read the data, not the blind one that
    // merely repeated its verdict.
    const stamped = JSON.parse(await fs.readFile(path.join(setup.root, '.bfs', 'manifests', 'v001.json'), 'utf-8')) as { health_deep_rot?: boolean; health_checked_at?: string };
    expect(stamped.health_deep_rot).toBe(true);
    expect(stamped.health_checked_at).toEqual(expect.any(String));
  });

  it('should keep the rot on record when a shallow pass reaches the same verdict for another reason', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    await flipPayloadByte(path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1'));
    expect((await verifyVersion(setup.root, 1, setup.io, { deep: true })).health).toBe(VersionHealth.Degraded);

    // A shallow pass while a *different* part happens to be unreachable lands on
    // the same verdict for an unrelated reason. Nothing about the rot was
    // re-checked, so the record of it must survive - otherwise the rot silently
    // stops counting once that part comes back.
    const away = path.join(setup.providerDirs[1], 'verify-test', 'shard_1.bfs.1');
    const parked = await fs.readFile(away);
    await fs.rm(away);
    await verifyVersion(setup.root, 1, setup.io);
    await fs.writeFile(away, parked);

    const shallow = await verifyVersion(setup.root, 1, setup.io);

    expect(shallow.health).toBe(VersionHealth.Degraded);
    expect(await storedHealth(setup.root)).toBe('degraded');
  });

  it('should not freeze a verdict caused by an unreachable part', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    // The part is gone rather than rotted - the medium was offline, its bytes
    // were never read. Nothing about the payload was established, so the verdict
    // must retire as soon as the part is back.
    const away = path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1');
    const parked = await fs.readFile(away);
    await fs.rm(away);

    expect((await verifyVersion(setup.root, 1, setup.io, { deep: true })).health).toBe(VersionHealth.Degraded);
    await fs.writeFile(away, parked);

    const shallow = await verifyVersion(setup.root, 1, setup.io);

    expect(shallow.health).toBe(VersionHealth.Healthy);
    expect(await storedHealth(setup.root)).toBe('healthy');
  });

  it('should treat a manifest without recorded provenance as shallow', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    await flipPayloadByte(path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1'));
    await verifyVersion(setup.root, 1, setup.io, { deep: true });

    // A backup written by an earlier BFS carries health but no provenance. Such a
    // verdict must not become permanent, or a legacy manifest could never be
    // brought back to healthy.
    const manifestPath = path.join(setup.root, '.bfs', 'manifests', 'v001.json');
    const legacy = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<string, unknown>;
    for (const key of Object.keys(legacy)) {
      if (key.startsWith('health_')) delete legacy[key];
    }
    await fs.writeFile(manifestPath, JSON.stringify(legacy, null, 2), 'utf-8');

    const shallow = await verifyVersion(setup.root, 1, setup.io);

    expect(shallow.health).toBe(VersionHealth.Healthy);
    expect(await storedHealth(setup.root)).toBe('healthy');
  });

  it('should let a later deep verify clear the verdict once the data is sound again', async () => {
    const setup = await setupVault();
    dirs = [setup.root, ...setup.providerDirs];
    const rotted = path.join(setup.providerDirs[0], 'verify-test', 'shard_0.bfs.1');
    const sound = await fs.readFile(rotted);
    await flipPayloadByte(rotted);

    expect((await verifyVersion(setup.root, 1, setup.io, { deep: true })).health).toBe(VersionHealth.Degraded);

    await fs.writeFile(rotted, sound);
    const repaired = await verifyVersion(setup.root, 1, setup.io, { deep: true });

    expect(repaired.health).toBe(VersionHealth.Healthy);
    expect(await storedHealth(setup.root)).toBe('healthy');
  });
});
