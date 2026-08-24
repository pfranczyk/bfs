import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKey } from '../../src/core/crypto.js';
import { DecryptionError } from '../../src/core/errors.js';
import { buildShardHeaderFromBytes, serializeShardHeader } from '../../src/core/shard-io.js';
import { fmt } from '../../src/i18n/index.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';
import { readManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';

// --- Contract under test -----------------------------------------------------
//
// Within one version every shard carries the SAME kdf_salt and the SAME location
// map - only the map's ciphertext differs (a fresh random nonce per seal). So the
// map of a version opens from ANY of its shards with the same password.
//
// `rebuildVersionManifest` (src/vault/version-rebuild.ts) resolves the map from `primaryData`,
// the FIRST shard header it managed to collect for that version. It stops
// collecting at two headers, and the second one feeds `shardHeaderConsensusMismatch`
// (src/vault/consensus.ts) only - it is never used as an alternative map source.
// When the primary's encrypted map is undecryptable, `tryDecryptLocationMap`
// (src/vault/password-pool.ts) burns through the password pool, recovery warns
// (`recovery_decrypt_skip`) and returns null: the WHOLE version is dropped even
// though its untouched siblings still hold a map that opens with the very
// password already in the pool.
//
// Contrast: `extractShardMeta` in src/vault/heal.ts walks EVERY fetched shard and
// takes the material from whichever one carries it.
//
// Two versions are needed to reach the defect at all: bootstrapping FROM a
// damaged shard fails earlier, inside `bootstrapFromProvider`, and without that
// shard's map recovery never learns where the other providers live. Here v2 (the
// bootstrap target) is intact everywhere and carries the full provider list; only
// v1 is damaged on the medium recovery happens to read first.
//
// Target behaviour: v1's manifest is rebuilt from a healthy sibling's map.

const VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
const VAULT_NAME = 'recovery-sibling-map';

/** Provider type registered for this test; each instance serves ONE medium. */
const MEDIUM_TYPE = 'mock-recovery-sibling';

/** The single password that opens every version of this backup. */
const PASSWORD = 'sibling-map-secret';

/** Media in the pool; slot number doubles as the shard index it stores. */
const SLOTS = [0, 1, 2] as const;

/** Map id of the medium whose v1 map is damaged - what a report must name. */
const DAMAGED_MEDIUM_ID = 'p0';

/** v2 = latest (bootstrap target, always intact); v1 = the damaged one. */
const VERSIONS = [1, 2] as const;

/** slot -> version -> serialized shard-header bytes that medium serves. */
let media: Map<number, Map<number, Buffer>>;

/** Argon2id is expensive; salts are fixed per version, so derive each key once. */
const keyCache = new Map<string, Buffer>();

/** Per-version KDF salt, shared by every shard of that version (as push writes it). */
function saltFor(version: number): Buffer {
  return Buffer.alloc(16, version);
}

/** Derives (and memoizes) the vault key for one version's salt. */
async function vaultKeyFor(version: number): Promise<Buffer> {
  const salt = saltFor(version);
  const cached = keyCache.get(salt.toString('hex'));
  if (cached) return cached;
  const key = await deriveKey(PASSWORD, salt);
  keyCache.set(salt.toString('hex'), key);
  return key;
}

/** Distinct, valid-hex blob hash per version (consensus compares it per version). */
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

/** An encrypted FORMAT_VERSION 2 shard header for one slot of one version. */
function shardHeaderFor(slot: number, version: number, locationMap: ShardLocation[]): ShardHeader {
  return {
    magic: 'BFSS',
    format_version: 2,
    vault_id: VAULT_ID,
    vault_name: VAULT_NAME,
    blob_size: BigInt(1024 * version),
    blob_hash: blobHashFor(version),
    data_shards: 2,
    parity_shards: 1,
    shard_index: slot,
    version,
    encrypted: true,
    kdf_salt: saltFor(version),
    rs_stripe_size: 64 * 1024,
    map_length: 0,
    location_map: locationMap,
  };
}

/**
 * Flips the last byte of a serialized header - the tail of the GCM tag sealing
 * the encrypted location map. The header still parses (every plaintext field is
 * intact), but no password opens its map. Mirrors the single-byte header damage
 * the CLI e2e harness injects.
 */
function damageEncryptedMap(headerBytes: Buffer): Buffer {
  const copy = Buffer.from(headerBytes);
  const last = copy.length - 1;
  copy[last] = (copy[last] ?? 0) ^ 0xff;
  return copy;
}

/** Parses the version number out of a shard filename (shard_N.bfs.V). */
function versionOf(filename: string): number {
  return Number(/\.bfs\.(\d+)$/.exec(filename)?.[1] ?? '0');
}

/**
 * Seeds every medium with an intact v2 header and a v1 header that is damaged on
 * the listed slots. Damage is confined to the encrypted location map.
 */
async function seedVault(corruptV1Slots: readonly number[]): Promise<void> {
  media = new Map(SLOTS.map((slot) => [slot as number, new Map<number, Buffer>()]));
  for (const version of VERSIONS) {
    const key = await vaultKeyFor(version);
    const map = locationMapFor(version);
    for (const slot of SLOTS) {
      const bytes = serializeShardHeader(shardHeaderFor(slot, version, map), key);
      const served = version === 1 && corruptV1Slots.includes(slot) ? damageEncryptedMap(bytes) : bytes;
      media.get(slot)?.set(version, served);
    }
  }
}

/**
 * Base of a connected StorageProvider - every method a no-op stub except the
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
 * slot, so two ids can point at the SAME physical medium - the layout a real
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
    displayName: 'Mock (recovery sibling)',
    create: (config: ProviderConfig): StorageProvider => buildMediumProvider(config.id, Number(config.config.slot)),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

function unregisterMediumProvider(): void {
  (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(MEDIUM_TYPE);
}

/** The bytes one medium serves for a version; throws when the fixture never seeded them. */
function servedBytes(slot: number, version: number): Buffer {
  const bytes = media.get(slot)?.get(version);
  if (!bytes) throw new Error(`fixture holds no shard for slot ${slot} version ${version}`);
  return bytes;
}

/** Counts warnings carrying exactly `message`. */
function warnCount(logs: Array<{ level: string; message: string }>, message: string): number {
  return logs.filter((l) => l.level === 'warn' && l.message === message).length;
}

/** Counts warnings naming a medium - how a report points the operator at it. */
function warnsNaming(logs: Array<{ level: string; message: string }>, mediumId: string): number {
  return logs.filter((l) => l.level === 'warn' && l.message.includes(mediumId)).length;
}

/** Decrypts one served header with the pooled password; null when it cannot be opened. */
async function openServedMap(slot: number, version: number): Promise<Nullable<ShardLocation[]>> {
  const bytes = media.get(slot)?.get(version);
  if (!bytes) return null;
  try {
    return buildShardHeaderFromBytes(bytes, await vaultKeyFor(version)).location_map;
  } catch {
    return null;
  }
}

describe('recover() resolving a version location map across sibling shards', () => {
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
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-sibling-map-'));
    roots.push(dir);
    return dir;
  }

  it('should seed a v1 shard whose header still parses but whose map no longer opens', async () => {
    await seedVault([0]);
    const damaged = servedBytes(0, 1);
    const key = await vaultKeyFor(1);

    // Parsed WITHOUT a key: the damage must be confined to the sealed map, or the
    // fixture would be testing an unreadable HEADER - a different failure entirely.
    const plaintextFields = buildShardHeaderFromBytes(damaged);

    expect(plaintextFields.shard_index, 'the damaged header must still expose its shard index - the damage is in the sealed map, not the header layout').toBe(0);
    expect(plaintextFields.version, 'the damaged header must still expose its version').toBe(1);
    expect(plaintextFields.encrypted, 'the damaged header must still declare itself encrypted').toBe(true);
    expect(plaintextFields.kdf_salt, 'the KDF salt must survive the damage - a wrong salt would fail for a different reason').toEqual(saltFor(1));
    expect(() => buildShardHeaderFromBytes(damaged, key), 'the pooled password must NOT open the damaged map - that IS the injected damage').toThrow(DecryptionError);

    expect((await openServedMap(1, 1))?.length, 'slot 1 v1 map must open with the pooled password').toBe(3);
    expect((await openServedMap(2, 1))?.length, 'slot 2 v1 map must open with the pooled password').toBe(3);
    expect((await openServedMap(0, 2))?.length, 'slot 0 v2 map must open - bootstrap reads this one').toBe(3);
  });

  it('should report the damaged medium and withhold consensus when the map comes from a sibling', async () => {
    await seedVault([0]);
    const root = await tmp();
    const { io, logs } = createMockProviderIO({});
    const bootstrapProvider = buildMediumProvider('p0', 0);

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

    expect(report.versions.find((v) => v.version === 1)?.consensus, 'a version rebuilt from a sibling map must not be reported as consensus-clean - the medium that disagreed is still damaged after recovery finishes').toBe(false);
    expect(
      warnsNaming(logs, DAMAGED_MEDIUM_ID),
      `recovery must name the medium whose map could not be opened ("${DAMAGED_MEDIUM_ID}") so verify/repair can be pointed at it - healing the version silently leaves a damaged shard nobody knows about`,
    ).toBeGreaterThanOrEqual(1);
  });

  it('should resolve a sibling map without asking the operator anything', async () => {
    await seedVault([0]);
    const root = await tmp();
    const { io, logs } = createMockProviderIO({});
    const askSecret = vi.spyOn(io, 'askSecret');
    const bootstrapProvider = buildMediumProvider('p0', 0);

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

    expect(askSecret.mock.calls.length, 'the pooled password already opens v1 on a healthy sibling - every prompt here is one the operator should never have seen').toBe(0);
    expect(warnCount(logs, fmt('recovery_pool_password_failed', '1')), 'the pool is not exhausted while a sibling still opens with a pooled password').toBe(0);
    expect(warnCount(logs, fmt('recovery_decrypt_skip', '1')), 'a version resolved from a sibling map must not be reported as skipped').toBe(0);
    expect(
      report.versions.map((v) => v.version).sort((a, b) => a - b),
      'v1 must be rebuilt from a healthy sibling',
    ).toEqual([1, 2]);
  });

  it('should rebuild a version whose first collected shard has an undecryptable map', async () => {
    await seedVault([0]);
    const root = await tmp();
    const { io } = createMockProviderIO({});
    // Bootstrap id matches the map entry for slot 0, so the collected headers are
    // the damaged primary (slot 0) plus a HEALTHY sibling (slot 1) - the sibling
    // is fetched for consensus, but never consulted for the location map.
    const bootstrapProvider = buildMediumProvider('p0', 0);

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

    const rebuilt = report.versions.map((v) => v.version).sort((a, b) => a - b);
    expect(rebuilt, 'v1 must be rebuilt from a healthy sibling whose map opens with the pooled password - dropping it loses a recoverable version').toEqual([1, 2]);

    const v1 = await readManifest(root, 1);
    expect(
      v1?.shards.map((s) => s.remote_path),
      'the rebuilt v1 manifest must carry v1 remote paths, proving it came from a v1 sibling map',
    ).toEqual(SLOTS.map((slot) => remotePathFor(slot, 1)));
  });

  it('should rebuild a version when the first two collected shards are the same damaged medium', async () => {
    await seedVault([0]);
    const root = await tmp();
    const { io } = createMockProviderIO({});
    // The bootstrap provider carries an id of its own while pointing at the SAME
    // medium as map entry p0, so the two headers recovery collects are one and
    // the same damaged shard and the healthy siblings are never even fetched.
    const bootstrapProvider = buildMediumProvider('bootstrap', 0);

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

    const rebuilt = report.versions.map((v) => v.version).sort((a, b) => a - b);
    expect(rebuilt, 'v1 must be rebuilt by reaching past the duplicated damaged medium to a healthy sibling').toEqual([1, 2]);

    const v1 = await readManifest(root, 1);
    expect(
      v1?.shards.map((s) => s.remote_path),
      'the rebuilt v1 manifest must carry v1 remote paths',
    ).toEqual(SLOTS.map((slot) => remotePathFor(slot, 1)));
  });

  it('should rebuild every version when all shard headers are intact', async () => {
    await seedVault([]);
    const root = await tmp();
    const { io, logs } = createMockProviderIO({});
    const bootstrapProvider = buildMediumProvider('p0', 0);

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

    const rebuilt = report.versions.map((v) => v.version).sort((a, b) => a - b);
    expect(rebuilt, 'an undamaged backup must recover every version').toEqual([1, 2]);
    expect(await readManifest(root, 1)).not.toBeNull();
    expect(await readManifest(root, 2)).not.toBeNull();
    expect(
      report.versions.every((v) => v.consensus),
      'an undamaged backup must report every version as agreed',
    ).toBe(true);
    // Control for the fallback assertions above: with nothing damaged, no warning
    // names a medium - so a passing "the damaged medium is named" assertion cannot
    // be satisfied by chatter recovery emits anyway.
    expect(warnsNaming(logs, DAMAGED_MEDIUM_ID), 'an undamaged backup must not name any medium in a warning').toBe(0);
  });

  it('should skip a version whose shard headers are all undecryptable, prompting once', async () => {
    await seedVault(SLOTS);
    const root = await tmp();
    const { io, logs } = createMockProviderIO({});
    const askSecret = vi.spyOn(io, 'askSecret');
    const bootstrapProvider = buildMediumProvider('p0', 0);

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io, passwords: [PASSWORD] });

    expect(
      report.versions.map((v) => v.version),
      'with no readable v1 map anywhere the version stays skipped',
    ).toEqual([2]);
    expect(await readManifest(root, 1)).toBeNull();
    // Counts, not presence: walking the candidate shards must cost the operator
    // nothing extra. One damaged version is one prompt and one report line - three
    // of each would be the pool being burned per shard instead of per version.
    expect(askSecret.mock.calls.length, 'the operator must be asked once per VERSION, not once per candidate shard').toBe(1);
    expect(warnCount(logs, fmt('recovery_pool_password_failed', '1')), 'the exhausted pool must be reported once per version, not once per candidate shard').toBe(1);
    expect(warnCount(logs, fmt('recovery_decrypt_skip', '1')), 'the skip must be reported exactly once - reported, and not repeated per shard').toBe(1);
  });
});
