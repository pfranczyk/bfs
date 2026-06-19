import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { serializeShardHeader } from '../../src/core/shard-io.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';
import { recover } from '../../src/vault/recovery.js';

// ─── Contract under test (RED) — S2 sibling, in the multi-version recovery loop ─
//
// `processVersion` (src/vault/recovery.ts, ~lines 186-200) runs its OWN, weaker
// consensus than bootstrap's `runConsensusCheck`. It downloads up to two shard
// headers for a version and compares ONLY header fields between them
// (vault_id / blob_hash / version / data_shards / parity_shards). On divergence
// it does a soft `io.warn` + `consensusOk = false` — it never throws, and it
// NEVER compares the CONTENTS of the location_map.
//
// With encryption off the location_map is raw JSON guarded only by an unkeyed
// trailing SHA-256. An attacker who rewrites a single shard can redirect a
// sibling provider's connection coordinates (host/port/path) without touching
// any compared header field. The re-sealed shard is byte-valid, so today's
// per-version consensus reports the version as consensus-OK despite the tamper.
//
// GREEN contract: for each shard_index present in BOTH the primary and the
// reachable sibling's location_map, processVersion also compares provider_type,
// connection_config (host/port/path), required_inputs and remote_path. Any
// divergence marks that version consensus NON-OK — i.e.
// report.versions[v].consensus === false. Consistent with processVersion's
// existing soft model (a flag, not a hard throw — it loops over many versions).
//
// The latest version (the bootstrap target) is kept honest so bootstrap's own
// hard consensus passes and recovery reaches the per-version loop; an OLDER
// version is forged so its detection is processVersion's soft flag, not a
// bootstrap throw. RED today: the forged older map and the honest sibling map
// agree on every HEADER field, so processVersion never sets consensusOk = false
// → that version is reported consensus === true. The strict-false assertion
// below fails for the right reason (no location_map comparison), not a setup error.

const VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
const VAULT_NAME = 'recovery-consensus-map';

/** Provider type registered for this test; each instance serves its OWN map. */
const MAP_TYPE = 'mock-recovery-map';

/** Versions present in the vault: v2 latest (bootstrap target, kept honest),
 * v1 older (forged — exercises processVersion's per-version soft consensus). */
const VERSIONS = [1, 2] as const;

/** Per-(id@version) honest/forged location map a provider serves via downloadHeader. */
let serveMaps: Map<string, ShardLocation[]>;

/**
 * Base of a connected StorageProvider — every method a no-op stub except the
 * ones recovery touches (authenticate, setVaultName, list, downloadHeader).
 * list/downloadHeader are overridden per instance by the factory below.
 */
function baseProvider(id: string, type: string): StorageProvider {
  return {
    id,
    type,
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

/** Builds a non-encrypted V2 shard header carrying the given location map. */
function buildHeaderBytes(locationMap: ShardLocation[], shardIndex: number, version: number): Buffer {
  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: 2,
    vault_id: VAULT_ID,
    vault_name: VAULT_NAME,
    blob_size: 256n,
    blob_hash: 'b'.repeat(64),
    data_shards: 2,
    parity_shards: 1,
    shard_index: shardIndex,
    version,
    encrypted: false,
    kdf_salt: null,
    rs_stripe_size: 64 * 1024,
    map_length: 0,
    location_map: locationMap,
  };
  return serializeShardHeader(header);
}

/** Parses the version number from a shard filename (shard_N.bfs.V). */
function versionOf(path: string): number {
  return Number(/\.bfs\.(\d+)$/.exec(path)?.[1] ?? '0');
}

/** A location-map entry for the given index with an explicit host. */
function mapLoc(shardIndex: number, host: string): ShardLocation {
  return {
    shard_index: shardIndex,
    provider_id: `p${shardIndex}`,
    provider_type: MAP_TYPE,
    adapterPackage: null,
    connection_config: { host, port: 9999, path: `/p${shardIndex}` },
    required_inputs: [],
    remote_path: `/p${shardIndex}/shard_${shardIndex}.bfs.1`,
    shard_hash: 'a'.repeat(64),
  };
}

/**
 * Registers MAP_TYPE so adapter preflight passes and bootstrap can build the
 * sibling providers from the location map. Each created instance lists one shard
 * for version 1 and serves its OWN map (keyed by id in `serveMaps`) on
 * downloadHeader — so the primary (p0) serves the forged map and the consensus
 * sibling serves the honest one.
 */
function registerMapProvider(): void {
  providerRegistry.register(MAP_TYPE, {
    lang: 'en',
    displayName: 'Mock (recovery map)',
    create: (config: ProviderConfig): StorageProvider => buildMapProvider(config.id),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

/**
 * Builds one MAP_TYPE provider instance wired to its per-(id, version) served
 * map. It lists a shard for every version in VERSIONS and serves the map keyed
 * `${id}@${version}` on downloadHeader, so the latest version can stay honest
 * (bootstrap consensus passes) while an older version carries a forged map
 * (processVersion soft-flags it).
 */
function buildMapProvider(id: string): StorageProvider {
  const p = baseProvider(id, MAP_TYPE);
  const parsed = /^p(\d+)$/.exec(id);
  const ownIndex = parsed ? Number(parsed[1]) : 0;
  (p.list as ReturnType<typeof vi.fn>).mockResolvedValue(VERSIONS.map((v) => ({ provider_id: id, path: `shard_${ownIndex}.bfs.${v}` })) as RemoteRef[]);
  (p.downloadHeader as ReturnType<typeof vi.fn>).mockImplementation(async (ref: RemoteRef) => {
    const v = versionOf(ref.path);
    return buildHeaderBytes(serveMaps.get(`${id}@${v}`) ?? [], ownIndex, v);
  });
  return p;
}

function unregisterMapProvider(): void {
  (providerRegistry as unknown as { entries: Map<string, unknown> }).entries.delete(MAP_TYPE);
}

async function tmp(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'bfs-consensus-map-'));
}

describe('processVersion location_map cross-check (S2 sibling)', () => {
  beforeEach(() => {
    serveMaps = new Map();
    registerMapProvider();
  });

  afterEach(() => {
    unregisterMapProvider();
    vi.restoreAllMocks();
  });

  it('should report consensus=false when an older version diverges in connection_config', async () => {
    const root = await tmp();

    // v2 (latest) is honest on every provider, so bootstrap — which targets the
    // latest version — passes its hard consensus and recovery proceeds.
    // v1 (older) is forged on the primary shard (shard_1 host = "attacker") while
    // the reachable sibling carries the honest v1 map. Every HEADER field is
    // identical, so processVersion's header-only consensus does not fire — only
    // the location_map cross-check catches the redirected host, soft-flagging v1.
    const honest = [mapLoc(0, 'honest'), mapLoc(1, 'honest'), mapLoc(2, 'honest')];
    const forgedV1 = [mapLoc(0, 'honest'), mapLoc(1, 'attacker'), mapLoc(2, 'honest')];

    // v2 honest everywhere (bootstrap target).
    serveMaps.set('p0@2', honest);
    serveMaps.set('p1@2', honest);
    serveMaps.set('p2@2', honest);
    // v1 forged on the primary (p0), honest on the consensus sibling.
    serveMaps.set('p0@1', forgedV1);
    serveMaps.set('p1@1', honest);
    serveMaps.set('p2@1', honest);

    // Bootstrap provider = p0 (serves honest v2 to bootstrap, forged v1 to processVersion).
    const bootstrapProvider = buildMapProvider('p0');

    const { io } = createMockProviderIO({});

    const report = await recover(root, { vaultName: VAULT_NAME, provider: bootstrapProvider, io });

    const v1 = report.versions.find((v) => v.version === 1);
    const v2 = report.versions.find((v) => v.version === 2);
    expect(v1).toBeDefined();
    expect(v2).toBeDefined();
    // The honest latest version passes consensus; the forged older version is
    // soft-flagged via the location_map cross-check.
    expect(v2?.consensus).toBe(true);
    expect(v1?.consensus).toBe(false);

    await fs.rm(root, { recursive: true, force: true });
  });
});
