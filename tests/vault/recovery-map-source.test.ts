import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKey } from '../../src/core/crypto.js';
import { buildHeaderBytes } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';
import { readManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';

// ─── Contract under test ─────────────────────────────────────────────────────
//
// Every shard of one version carries the SAME location map sealed under the SAME
// kdf_salt — only the ciphertext differs (a fresh random nonce per seal). WHICH
// shard a version's map is read from is therefore a choice, and that choice
// decides four separate things, one per section below:
//
//   * whose vault_id guards the map that gets accepted,
//   * which shard's header metadata the rebuilt manifest inherits,
//   * which two shards the per-version consensus actually compares,
//   * when the operator is asked for a password at all.
//
// `processVersion` (src/vault/recovery.ts) collects at most two headers and
// resolves the map from the FIRST one, so every one of those answers is decided
// by a single shard today. The CLI (`src/cli/commands/recovery.ts`) hands the
// bootstrap provider an id of its own (`bootstrap-${providerType}`) while it
// points at the SAME medium as one of the map entries, so the two collected
// headers are routinely two reads of one physical file. Both layouts appear
// below: a bootstrap id equal to a map entry, and a bootstrap id of its own.
//
// Divergent metadata between siblings of one version cannot happen in a backup
// that push produced — it is used here purely as a PROBE: it is the only way to
// observe which shard a value in the rebuilt manifest came from.

const VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
/** A second backup of the same owner, sharing the medium and the password. */
const FOREIGN_VAULT_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const VAULT_NAME = 'recovery-map-source';
const FOREIGN_VAULT_NAME = 'other-backup';

/** Provider type registered for this file; each instance serves ONE medium. */
const MEDIUM_TYPE = 'mock-recovery-map-source';

/** The password in the recovery pool; opens every version unless overridden. */
const PASSWORD = 'map-source-secret';
/** A password the pool does NOT know — only the operator can supply it. */
const OTHER_PASSWORD = 'rotated-secret';

/** Media in the pool; slot number doubles as the shard index it stores. */
const SLOTS = [0, 1, 2] as const;

/** v2 = latest (bootstrap target, always intact); v1 = the interesting one. */
const VERSIONS = [1, 2] as const;

/** rs_stripe_size a normal V2 shard of this fixture carries. */
const STRIPE_SIZE = 64 * 1024;

/** slot → version → serialized shard-header bytes that medium serves. */
let media: Map<number, Map<number, Buffer>>;

/** Argon2id is expensive; every (password, salt) pair is derived once per run. */
const keyCache = new Map<string, Buffer>();

/** Per-version KDF salt, shared by every shard of that version (as push writes it). */
function saltFor(version: number): Buffer {
  return Buffer.alloc(16, version);
}

/** A salt that is NOT the one the version's map was sealed under. */
function wrongSalt(): Buffer {
  return Buffer.alloc(16, 0xa7);
}

/** Derives (and memoizes) the vault key for one password/salt pair. */
async function vaultKeyFor(password: string, salt: Buffer): Promise<Buffer> {
  const cacheKey = `${password}::${salt.toString('hex')}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const key = await deriveKey(password, salt);
  keyCache.set(cacheKey, key);
  return key;
}

/** Distinct, valid-hex blob hash per version. */
function blobHashFor(version: number): string {
  return version.toString().padStart(2, '0').repeat(32);
}

/** Remote path a version's map records for one shard. */
function remotePathFor(slot: number, version: number): string {
  return `/${VAULT_NAME}/shard_${slot}.bfs.${version}`;
}

/** The honest location map every shard of `version` carries. */
function locationMapFor(version: number): ShardLocation[] {
  return SLOTS.map((slot) => ({
    shard_index: slot,
    provider_id: `p${slot}`,
    provider_type: MEDIUM_TYPE,
    adapterPackage: null,
    connection_config: { slot },
    required_inputs: [],
    remote_path: remotePathFor(slot, version),
    shard_hash: 'a'.repeat(64),
  }));
}

/** The location map of the OTHER backup — different ids, different addresses. */
function foreignLocationMap(): ShardLocation[] {
  return SLOTS.map((slot) => ({
    shard_index: slot,
    provider_id: `q${slot}`,
    provider_type: MEDIUM_TYPE,
    adapterPackage: null,
    connection_config: { slot },
    required_inputs: [],
    remote_path: `/${FOREIGN_VAULT_NAME}/shard_${slot}.bfs.1`,
    shard_hash: 'f'.repeat(64),
  }));
}

/** Per-(slot, version) deviation from the honest shard the fixture would build. */
interface ShardOverride {
  /** Identity this shard claims — a foreign one marks a different backup. */
  readonly vault_id?: string;
  readonly blob_hash?: string;
  readonly data_shards?: number;
  readonly parity_shards?: number;
  readonly rs_stripe_size?: number;
  /** 1 keeps the legacy layout (no rs_stripe_size field at all). */
  readonly format_version?: number;
  readonly location_map?: ShardLocation[];
  /** Salt written into the header while the map stays sealed under the version's real one. */
  readonly kdf_salt?: Buffer;
  /** Password the map is sealed with (default: the pooled PASSWORD). */
  readonly password?: string;
  /** Flip the last header byte — the tail of the map payload. */
  readonly damaged?: boolean;
}

/**
 * Flips the last byte of a serialized header. Encrypted, that is the tail of the
 * GCM tag sealing the location map: the header still parses (every plaintext
 * field is intact) but no password opens its map. Unencrypted, it is the tail of
 * the raw JSON, which makes the whole header unparseable — the difference
 * between the two modes is exactly what the `--no-enc` case below pins down.
 */
function damageMapTail(headerBytes: Buffer): Buffer {
  const copy = Buffer.from(headerBytes);
  const last = copy.length - 1;
  copy[last] = (copy[last] ?? 0) ^ 0xff;
  return copy;
}

/** Builds the header bytes one medium serves for one version, honoring overrides. */
async function buildServed(slot: number, version: number, ov: ShardOverride, encrypted: boolean): Promise<Buffer> {
  const formatVersion = ov.format_version ?? 2;
  const realSalt = saltFor(version);
  const key = encrypted ? await vaultKeyFor(ov.password ?? PASSWORD, realSalt) : undefined;
  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: formatVersion,
    vault_id: ov.vault_id ?? VAULT_ID,
    vault_name: VAULT_NAME,
    blob_size: BigInt(1024 * version),
    blob_hash: ov.blob_hash ?? blobHashFor(version),
    data_shards: ov.data_shards ?? 2,
    parity_shards: ov.parity_shards ?? 1,
    shard_index: slot,
    version,
    encrypted,
    kdf_salt: encrypted ? (ov.kdf_salt ?? realSalt) : null,
    rs_stripe_size: formatVersion >= 2 ? (ov.rs_stripe_size ?? STRIPE_SIZE) : null,
    map_length: 0,
    location_map: ov.location_map ?? locationMapFor(version),
  };
  // buildHeaderBytes serializes at the header's own format_version, so one call
  // covers both the V2 fixtures and the legacy-layout probe.
  const bytes = buildHeaderBytes(header, key);
  return ov.damaged === true ? damageMapTail(bytes) : bytes;
}

/** Seeds every medium with both versions, applying per-(slot@version) overrides. */
async function seedVault(options: { encrypted?: boolean; overrides?: Record<string, ShardOverride> }): Promise<void> {
  const encrypted = options.encrypted ?? true;
  media = new Map(SLOTS.map((slot) => [slot as number, new Map<number, Buffer>()]));
  for (const version of VERSIONS) {
    for (const slot of SLOTS) {
      const ov = options.overrides?.[`${slot}@${version}`] ?? {};
      media.get(slot)?.set(version, await buildServed(slot, version, ov, encrypted));
    }
  }
}

/** Parses the version number out of a shard filename (shard_N.bfs.V). */
function versionOf(filename: string): number {
  return Number(/\.bfs\.(\d+)$/.exec(filename)?.[1] ?? '0');
}

/** Counts warnings carrying exactly `message`. */
function warnCount(logs: Array<{ level: string; message: string }>, message: string): number {
  return logs.filter((l) => l.level === 'warn' && l.message === message).length;
}

/**
 * Base of a connected StorageProvider — every method a no-op stub except the
 * ones recovery and verify touch (authenticate, setVaultName, list, getSize,
 * downloadHeader). The medium-specific ones are overridden per instance.
 */
function baseProvider(id: string): StorageProvider {
  return {
    id,
    type: MEDIUM_TYPE,
    authenticate: vi.fn().mockResolvedValue(undefined),
    setVaultName: vi.fn(),
    upload: vi.fn(),
    download: vi.fn(),
    delete: vi.fn(),
    rename: vi.fn(),
    updateShardHeader: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    getSize: vi.fn().mockResolvedValue(0),
    downloadHeader: vi.fn().mockResolvedValue(Buffer.alloc(0)),
    listVaults: vi.fn().mockResolvedValue([]),
    healthCheck: vi.fn().mockResolvedValue(true),
    configureInteractive: vi.fn().mockResolvedValue({}),
    configureFromFlags: vi.fn().mockResolvedValue({}),
    validateConfig: vi.fn().mockReturnValue([]),
    describeConfig: vi.fn().mockReturnValue(''),
    getSecretFields: vi.fn().mockReturnValue([]),
    probeConnection: vi.fn(),
    usesSidecar: vi.fn().mockReturnValue(false),
    uploadHeaderSidecar: vi.fn(),
    downloadHeaderSidecar: vi.fn().mockResolvedValue(null),
    verifyShard: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as StorageProvider;
}

/**
 * Builds a provider bound to one medium (`slot`). The id is independent of the
 * slot, so two ids can point at the SAME physical medium — the layout a real
 * `bfs recovery --bootstrap` produces when the bootstrap medium is also one of
 * the configured providers.
 */
function buildMediumProvider(id: string, slot: number): StorageProvider {
  const p = baseProvider(id);
  const served = media.get(slot) ?? new Map<number, Buffer>();
  const refs: RemoteRef[] = [...served.keys()].map((v) => ({ provider_id: id, path: `shard_${slot}.bfs.${v}` }));
  (p.list as ReturnType<typeof vi.fn>).mockResolvedValue(refs);
  (p.downloadHeader as ReturnType<typeof vi.fn>).mockImplementation(async (ref: RemoteRef) => served.get(versionOf(ref.path)) ?? Buffer.alloc(0));
  (p.getSize as ReturnType<typeof vi.fn>).mockImplementation(async (ref: RemoteRef) => (served.get(versionOf(ref.path)) ?? Buffer.alloc(0)).length);
  return p;
}

function registerMediumProvider(): void {
  providerRegistry.register(MEDIUM_TYPE, {
    lang: 'en',
    displayName: 'Mock (recovery map source)',
    create: (config: ProviderConfig): StorageProvider => buildMediumProvider(config.id, Number(config.config.slot)),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

function unregisterMediumProvider(): void {
  (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(MEDIUM_TYPE);
}

describe('recover() choosing which shard supplies a version location map', () => {
  let roots: string[];

  beforeEach(() => {
    roots = [];
    registerMediumProvider();
  });

  afterEach(async () => {
    unregisterMediumProvider();
    vi.restoreAllMocks();
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  });

  async function tmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-map-source-'));
    roots.push(dir);
    return dir;
  }

  describe('identity of the shard the map is taken from', () => {
    it('should refuse a foreign-backup shard as the map source and keep looking', async () => {
      // slot 0 = the version's own shard with an unreadable map; slot 1 = another
      // backup of the same owner, on the same medium, sealed with the same
      // password — its map decrypts and authenticates, so the ONLY thing standing
      // between it and the rebuilt manifest is the vault_id guard.
      await seedVault({ overrides: { '0@1': { damaged: true }, '1@1': { vault_id: FOREIGN_VAULT_ID, location_map: foreignLocationMap() } } });
      const root = await tmp();
      const { io } = createMockProviderIO({});
      const bootstrapProvider = buildMediumProvider('p0', 0);

      await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      const v1 = await readManifest(root, 1);
      expect(
        v1?.shards.map((s) => s.remote_path),
        'v1 must be rebuilt from the honest sibling (slot 2): the foreign-backup shard decrypts with the same password, so accepting its map would point recovery at another backup entirely',
      ).toEqual(SLOTS.map((slot) => remotePathFor(slot, 1)));
    });

    it('should skip a version whose only readable map belongs to a foreign backup', async () => {
      await seedVault({ overrides: { '0@1': { damaged: true }, '1@1': { damaged: true }, '2@1': { vault_id: FOREIGN_VAULT_ID, location_map: foreignLocationMap() } } });
      const root = await tmp();
      const { io } = createMockProviderIO({});
      const bootstrapProvider = buildMediumProvider('p0', 0);

      const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      expect(
        report.versions.map((v) => v.version),
        'no shard of this backup can supply v1, and a foreign one must never stand in for it',
      ).toEqual([2]);
      expect(await readManifest(root, 1), 'a version with no map of its own must stay skipped, not be rebuilt from a foreign map').toBeNull();
    });
  });

  describe('provenance of the rebuilt manifest', () => {
    it('should take manifest metadata from the shard whose map opened', async () => {
      // Metadata is deliberately split between the two shards so the manifest
      // reveals which one it was built from: no push produces such a version.
      await seedVault({ overrides: { '0@1': { damaged: true }, '1@1': { blob_hash: 'b'.repeat(64), parity_shards: 2, rs_stripe_size: 128 * 1024 } } });
      const root = await tmp();
      const { io } = createMockProviderIO({});
      const bootstrapProvider = buildMediumProvider('p0', 0);

      await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      const v1 = await readManifest(root, 1);
      expect(v1?.blob_hash, "blob_hash must describe the shard the map came from — a manifest mixing one shard's map with another shard's metadata describes a version that does not exist").toBe('b'.repeat(64));
      expect(v1?.scheme.parity_shards, 'the scheme must come from the shard the map came from, not from the shard whose map could not be opened').toBe(2);
      expect(v1?.rs_stripe_size, 'rs_stripe_size drives the RS decode allocation on pull — it must come from the shard the map came from').toBe(128 * 1024);
    });

    it('should take the manifest streaming flags from the map source format version', async () => {
      // Same probe as above, applied to format_version: the sibling that supplies
      // the map carries the legacy layout, so the manifest must NOT claim the
      // streaming (V2) pipeline it inherited from the unreadable primary.
      await seedVault({ overrides: { '0@1': { damaged: true }, '1@1': { format_version: 1 } } });
      const root = await tmp();
      const { io } = createMockProviderIO({});
      const bootstrapProvider = buildMediumProvider('p0', 0);

      await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      const v1 = await readManifest(root, 1);
      expect(v1, 'v1 must be rebuilt from the sibling whose map opened').not.toBeNull();
      expect(v1?.rs_striped, 'rs_striped follows the format version of the shard the map came from; inheriting it from the primary would tell pull to decode a legacy shard as striped').toBeUndefined();
      expect(v1?.encrypted_per_shard, 'encrypted_per_shard follows the same format version as rs_striped').toBeUndefined();
    });
  });

  describe('per-version consensus across physical media', () => {
    it('should compare headers from two different media, not two ids for the same one', async () => {
      // The layout `bfs recovery` actually produces: the bootstrap provider has an
      // id of its own while pointing at the medium that map entry p0 also names.
      // Nothing is damaged here — only medium 1 disagrees about v1's blob_hash.
      await seedVault({ overrides: { '1@1': { blob_hash: 'c'.repeat(64) } } });
      const root = await tmp();
      const { io } = createMockProviderIO({});
      const bootstrapProvider = buildMediumProvider('bootstrap', 0);

      const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      expect(
        report.versions.find((v) => v.version === 1)?.consensus,
        'consensus must cross-check two different media: reading the same file twice under two provider ids can never disagree, which leaves the version reported as agreed while a medium is out of step',
      ).toBe(false);
    });

    it('should report consensus for every version when all media agree', async () => {
      await seedVault({});
      const root = await tmp();
      const { io } = createMockProviderIO({});
      const bootstrapProvider = buildMediumProvider('bootstrap', 0);

      const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      expect(
        report.versions.map((v) => v.version).sort((a, b) => a - b),
        'an undamaged backup must recover every version',
      ).toEqual([1, 2]);
      expect(
        report.versions.every((v) => v.consensus),
        'agreeing media must be reported as agreeing — widening the comparison must not make consensus fire on healthy backups',
      ).toBe(true);
    });
  });

  describe('password handling across candidate shards', () => {
    it('should rebuild a version whose primary shard carries a damaged kdf_salt', async () => {
      // The other damage shape the map can suffer: the sealed map is intact but
      // the salt above it is not, so the key derived from the CORRECT password
      // does not open it. A sibling still carries the version's real salt — so a
      // key derived once for the version from the PRIMARY's salt would open
      // nothing anywhere.
      await seedVault({ overrides: { '0@1': { kdf_salt: wrongSalt() } } });
      const root = await tmp();
      const { io } = createMockProviderIO({});
      const bootstrapProvider = buildMediumProvider('p0', 0);

      const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      expect(
        report.versions.map((v) => v.version).sort((a, b) => a - b),
        'a damaged salt on one shard must cost that shard, not the whole version — its siblings carry the version salt',
      ).toEqual([1, 2]);
      expect(
        (await readManifest(root, 1))?.shards.map((s) => s.remote_path),
        'the rebuilt v1 manifest must carry v1 remote paths, proving its map came from a sibling that kept the version salt',
      ).toEqual(SLOTS.map((slot) => remotePathFor(slot, 1)));
    });

    it('should ask the operator exactly once for a version sealed with a password outside the pool', async () => {
      // The one legitimate reason to exhaust the pool: this version predates a
      // password change. Every shard is intact, so no amount of looking at
      // siblings helps — only the operator can supply the password, and they must
      // be asked once for the version, not once per shard inspected.
      await seedVault({ overrides: { '0@1': { password: OTHER_PASSWORD }, '1@1': { password: OTHER_PASSWORD }, '2@1': { password: OTHER_PASSWORD } } });
      const root = await tmp();
      const { io } = createMockProviderIO({ [fmt('recovery_ask_version_password', '1')]: OTHER_PASSWORD });
      const askSecret = vi.spyOn(io, 'askSecret');
      const bootstrapProvider = buildMediumProvider('p0', 0);

      const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

      expect(askSecret.mock.calls.length, 'a version under a different password must produce exactly ONE prompt — one per candidate shard turns a single password change into a prompt storm').toBe(1);
      expect(
        report.versions.map((v) => v.version).sort((a, b) => a - b),
        'the password the operator supplied must rebuild the version',
      ).toEqual([1, 2]);
      expect(
        (await readManifest(root, 1))?.shards.map((s) => s.remote_path),
        'the manually unlocked version must rebuild from its own map',
      ).toEqual(SLOTS.map((slot) => remotePathFor(slot, 1)));
    });

    it('should keep an unencrypted backup on its existing path when a plain map is corrupt', async () => {
      // With --no-enc the map is raw JSON under an unkeyed SHA-256: a corrupt one
      // fails to parse in readLocationMap (src/core/shard-io.ts), so that shard
      // drops out of the candidates before any map is chosen — an unreadable plain
      // map must never become selectable, and an unencrypted backup must never be
      // asked for a password. What is left is the ordinary promise: the version
      // rebuilds from a sibling that still parses.
      await seedVault({ encrypted: false, overrides: { '0@1': { damaged: true } } });
      const root = await tmp();
      const { io, logs } = createMockProviderIO({});
      const askSecret = vi.spyOn(io, 'askSecret');
      const bootstrapProvider = buildMediumProvider('p0', 0);

      const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io });

      expect(
        warnCount(logs, fmt('recovery_consensus_filename_mismatch', '1')),
        'the filename/header cross-check must be made against the shard the header was actually read from — checking it against the first LISTED entry instead condemns the version as soon as that entry drops out of the candidates',
      ).toBe(0);
      expect(
        report.versions.map((v) => v.version).sort((a, b) => a - b),
        'an unencrypted backup recovers every version — the unparseable header just drops out of the candidates',
      ).toEqual([1, 2]);
      expect(
        (await readManifest(root, 1))?.shards.map((s) => s.remote_path),
        'v1 must be rebuilt from a sibling with a readable plain map',
      ).toEqual(SLOTS.map((slot) => remotePathFor(slot, 1)));
      expect(askSecret.mock.calls.length, 'an unencrypted backup has no password to ask for').toBe(0);
      expect(warnCount(logs, fmt('recovery_decrypt_skip', '1')), 'nothing was skipped for a decryption reason — the unencrypted path must stay as it is').toBe(0);
    });
  });
});
