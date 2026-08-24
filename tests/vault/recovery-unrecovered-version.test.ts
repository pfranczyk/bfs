import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKey } from '../../src/core/crypto.js';
import { buildHeaderBytes } from '../../src/core/shard-io.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';
import { readManifest } from '../../src/vault/manifest.js';
import { recover } from '../../src/vault/recovery.js';
import { readState } from '../../src/vault/state.js';

// --- Contract under test -----------------------------------------------------
//
// Recovery bootstraps from the newest version the bootstrap medium carries, so a
// medium that missed a push - its upload failed, or it joined the pool later -
// puts recovery on an older version. The newer ones surface afterwards, while
// listing the other media, and one of them may be sealed under a password nobody
// supplied. Recovery skips it and reports success, which is correct: the rest of
// the backup is worth having.
//
// What the skip must not do is erase the version. `state.latest_version` is the
// highest version ON THE STORAGE, and `push` takes the next number from it - set
// from the highest *recovered* version, it hands the next push a number that is
// already taken, and that push overwrites the parts of the version whose password
// is still missing. The collision guard cannot catch it: those parts carry our
// own vault_id, which is exactly what a normal re-push looks like.

const VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
/** Another backup of the same owner, sharing the medium and the password. */
const FOREIGN_VAULT_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const VAULT_NAME = 'recovery-unrecovered';
const MEDIUM_TYPE = 'mock-recovery-unrecovered';

/** The password recovery is given; it opens v1 only. */
const PASSWORD = 'known-secret';
/** The password v2 was sealed with after a rotation - nobody supplies it. */
const ROTATED_PASSWORD = 'rotated-secret';

const SLOTS = [0, 1, 2] as const;
const STRIPE_SIZE = 64 * 1024;

/** slot -> version -> serialized shard-header bytes that medium serves. */
let media: Map<number, Map<number, Buffer>>;

/** Argon2id is expensive; every (password, salt) pair is derived once per run. */
const keyCache = new Map<string, Buffer>();

/** Per-version KDF salt, shared by every shard of that version (as push writes it). */
function saltFor(version: number): Buffer {
  return Buffer.alloc(16, version);
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

/** The honest location map every shard of `version` carries. */
function locationMapFor(version: number): ShardLocation[] {
  return SLOTS.map((slot) => ({
    shard_index: slot,
    provider_id: `p${slot}`,
    provider_type: MEDIUM_TYPE,
    adapterPackage: null,
    connection_config: { slot },
    required_inputs: [],
    remote_path: `/${VAULT_NAME}/shard_${slot}.bfs.${version}`,
    shard_hash: 'a'.repeat(64),
  }));
}

/** Builds the header bytes one medium serves for one version. */
async function buildServed(slot: number, version: number, password: string, vaultId: string): Promise<Buffer> {
  const salt = saltFor(version);
  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: 2,
    vault_id: vaultId,
    vault_name: VAULT_NAME,
    blob_size: BigInt(1024 * version),
    blob_hash: version.toString().padStart(2, '0').repeat(32),
    data_shards: 2,
    parity_shards: 1,
    shard_index: slot,
    version,
    encrypted: true,
    kdf_salt: salt,
    rs_stripe_size: STRIPE_SIZE,
    map_length: 0,
    location_map: locationMapFor(version),
  };
  return buildHeaderBytes(header, await vaultKeyFor(password, salt));
}

/**
 * Seeds the media. Slot 0 - the bootstrap medium - never received v2, so
 * bootstrap lands on v1 and v2 is met only while listing slots 1 and 2.
 *
 * `v2VaultId` makes v2 belong to a different backup sharing the medium; its map
 * then opens with the pooled password and the only thing rejecting it is the
 * identity check.
 */
async function seedVault(options: { v2Password?: string; v2VaultId?: string } = {}): Promise<void> {
  media = new Map(SLOTS.map((slot) => [slot as number, new Map<number, Buffer>()]));
  for (const slot of SLOTS) {
    media.get(slot)?.set(1, await buildServed(slot, 1, PASSWORD, VAULT_ID));
    if (slot !== 0) media.get(slot)?.set(2, await buildServed(slot, 2, options.v2Password ?? ROTATED_PASSWORD, options.v2VaultId ?? VAULT_ID));
  }
}

/** Parses the version number out of a shard filename (shard_N.bfs.V). */
function versionOf(filename: string): number {
  return Number(/\.bfs\.(\d+)$/.exec(filename)?.[1] ?? '0');
}

/** Base of a connected StorageProvider - every method a stub but the ones recovery touches. */
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

/** Builds a provider bound to one medium (`slot`). */
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
    displayName: 'Mock (recovery unrecovered version)',
    create: (config: ProviderConfig): StorageProvider => buildMediumProvider(config.id, Number(config.config.slot)),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

function unregisterMediumProvider(): void {
  (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(MEDIUM_TYPE);
}

describe('recover() meeting a version it cannot open', () => {
  let roots: string[];

  beforeEach(async () => {
    roots = [];
    registerMediumProvider();
  });

  afterEach(async () => {
    unregisterMediumProvider();
    vi.restoreAllMocks();
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  });

  async function tmp(): Promise<string> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'bfs-recovery-unrecovered-'));
    roots.push(dir);
    return dir;
  }

  /** Runs a recovery given the passwords listed (default: the one opening v1 only). */
  async function runRecovery(root: string, passwords: string[] = [PASSWORD]): Promise<void> {
    const { io } = createMockProviderIO({});
    await recover(root, { vaultName: VAULT_NAME, provider: buildMediumProvider('p0', 0), io, passwords });
  }

  /** Runs a recovery that is given the password for v1 only. */
  async function recoverWithKnownPasswordOnly(root: string): Promise<void> {
    await runRecovery(root);
  }

  it('should record the version it could not open as a marker', async () => {
    await seedVault();
    const root = await tmp();

    await recoverWithKnownPasswordOnly(root);

    const marker = await fs.readFile(path.join(root, '.bfs', 'manifests', 'v002.json'), 'utf-8');
    expect(JSON.parse(marker), 'a version present on the media but not opened must leave a record of its own, not vanish').toEqual({});
  });

  it('should still rebuild the version it could open', async () => {
    await seedVault();
    const root = await tmp();

    await recoverWithKnownPasswordOnly(root);

    expect((await readManifest(root, 1))?.version, 'skipping one version must not cost the versions that did open').toBe(1);
    expect(await readManifest(root, 2), 'the marker is not a manifest - no consumer may act on it as one').toBeNull();
  });

  // The number `push` builds on. Left at the highest RECOVERED version, the next
  // push reuses a number that exists on the media and overwrites its parts.
  it('should record the highest version on the media as the latest, not the highest recovered', async () => {
    await seedVault();
    const root = await tmp();

    await recoverWithKnownPasswordOnly(root);

    const state = await readState(root);
    expect(state.latest_version, 'v2 is on the media, so the next push must build on it - otherwise push claims v2 again and overwrites the parts of the version whose password is still missing').toBe(2);
  });

  // The marker says "yours, and only a password away". A version belonging to a
  // different backup that happens to share the medium is neither, and pointing
  // the operator at it would send them after someone else's data.
  it('should not mark a version that belongs to another backup', async () => {
    await seedVault({ v2VaultId: FOREIGN_VAULT_ID, v2Password: PASSWORD });
    const root = await tmp();

    await runRecovery(root);

    await expect(fs.readFile(path.join(root, '.bfs', 'manifests', 'v002.json'), 'utf-8'), 'a foreign backup version must leave no record in this copy').rejects.toThrow();
  });

  // Recovery is run more than once - the messages that send an operator to it say
  // so - and each run brings whichever passwords are at hand. A run without the
  // password for a version already rebuilt must not trade its manifest, the only
  // local copy of that version's location map, for a record saying nothing.
  it('should not replace a manifest it already rebuilt with a marker', async () => {
    await seedVault();
    const root = await tmp();
    await runRecovery(root, [PASSWORD, ROTATED_PASSWORD]);
    const rebuilt = await readManifest(root, 2);
    expect(rebuilt?.version, 'test setup: the first run must rebuild v2').toBe(2);

    await runRecovery(root);

    expect(await readManifest(root, 2), 'a later run without the password must leave the rebuilt manifest alone - replacing it would drop the only local record of where that version lives').toEqual(rebuilt);
  });
});
