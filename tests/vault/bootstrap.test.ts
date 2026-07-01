import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TamperDetectedError } from '../../src/core/errors.js';
import { serializeShardHeader } from '../../src/core/shard-io.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';
import { bootstrapFromProvider } from '../../src/vault/bootstrap.js';

// ─── Contract under test (RED) ──────────────────────────────────────────────
//
// The recovery credential-phishing fix introduces an OPTIONAL provider hook:
//
//   connectForRecovery?(io: ProviderIO, pool: readonly RecoverySecret[]):
//     Promise<string | null>;
//
// `connectProvidersFromMap` (private, in src/vault/bootstrap.ts) must dispatch
// to this hook whenever the provider implements it — INDEPENDENT of the
// entry's `required_inputs` — and only fall back to the legacy
// `connectWithInputs` / `io.askSecret` path when the provider does NOT.
//
// `connectProvidersFromMap` is private, so these tests drive dispatch through
// the exported `bootstrapFromProvider`: a fake bootstrap provider serves a
// `--no-enc` V2 shard header whose `location_map` names provider types we
// register in the registry. Each registered factory builds a provider with (or
// without) `connectForRecovery`, and we spy on the hook + on `io.askSecret`.
//
// Today (RED) `connectProvidersFromMap` never calls the hook (behavioural-RED):
// the spy is created when the provider is built but is never invoked, so the
// fallback `askSecret` path runs instead. The hook is reached only through a
// local cast here, so typecheck stays green until the GREEN integration code
// references `connectForRecovery` on the StorageProvider type itself.

const VAULT_ID = '550e8400-e29b-41d4-a716-446655440000';
const VAULT_NAME = 'bootstrap-test';

/** Spy recording every connectForRecovery dispatch (provider id → io + pool). */
type RecoverySpy = ReturnType<typeof vi.fn>;

/** Provider type whose factory builds an instance implementing connectForRecovery. */
const TYPE_WITH_HOOK = 'mock-with-recovery';
/** Provider type whose factory builds an instance WITHOUT connectForRecovery. */
const TYPE_NO_HOOK = 'mock-no-recovery';

/** Tracks askSecret prompts seen across a bootstrap run (fallback-path probe). */
let askSecretPrompts: string[];
/** Per-id connectForRecovery spies, keyed by provider id. */
let recoverySpies: Map<string, RecoverySpy>;

/**
 * Base of a connected StorageProvider — every method is a no-op stub except the
 * ones bootstrap actually touches on a non-bootstrap provider (authenticate,
 * setVaultName). connectForRecovery is layered on top by the with-hook factory.
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

/**
 * Registers the two mock provider types. The with-hook factory attaches a
 * spied `connectForRecovery` that "succeeds" (returns null = no reusable
 * secret) so dispatch is observable without a real connection.
 */
function registerMockProviders(): void {
  providerRegistry.register(TYPE_WITH_HOOK, {
    lang: 'en',
    displayName: 'Mock (recovery hook)',
    create: (config: ProviderConfig, _io: ProviderIO): StorageProvider => {
      const p = baseProvider(config.id, TYPE_WITH_HOOK) as StorageProvider & { connectForRecovery?: (io: ProviderIO, pool: readonly { value: string; origin: string }[]) => Promise<string | null> };
      const spy = vi.fn(async (_io: ProviderIO, _pool: readonly { value: string; origin: string }[]) => null);
      recoverySpies.set(config.id, spy);
      p.connectForRecovery = spy;
      return p;
    },
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });

  providerRegistry.register(TYPE_NO_HOOK, {
    lang: 'en',
    displayName: 'Mock (no recovery hook)',
    create: (config: ProviderConfig): StorageProvider => baseProvider(config.id, TYPE_NO_HOOK),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

function unregisterMockProviders(): void {
  const entries = (providerRegistry as unknown as { entries: Map<string, unknown> }).entries;
  entries.delete(TYPE_WITH_HOOK);
  entries.delete(TYPE_NO_HOOK);
}

/** Builds a non-encrypted V2 shard header carrying the given location map. */
function buildHeaderBytes(locationMap: ShardLocation[], shardIndex: number): Buffer {
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
    version: 1,
    encrypted: false,
    kdf_salt: null,
    rs_stripe_size: 64 * 1024,
    map_length: 0,
    location_map: locationMap,
  };
  return serializeShardHeader(header);
}

/**
 * Fake bootstrap provider: lists exactly one shard for version 1 and serves the
 * serialized `--no-enc` header for whichever shard_index it owns. The header it
 * serves carries the FULL location map, so bootstrap discovers every sibling.
 */
function makeBootstrapProvider(ownIndex: number, locationMap: ShardLocation[]): StorageProvider {
  const p = baseProvider(`p${ownIndex}`, TYPE_NO_HOOK);
  (p.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ provider_id: `p${ownIndex}`, path: `shard_${ownIndex}.bfs.1` }] as RemoteRef[]);
  (p.downloadHeader as ReturnType<typeof vi.fn>).mockResolvedValue(buildHeaderBytes(locationMap, ownIndex));
  return p;
}

/** A location-map entry for the given index, type and required_inputs. */
function loc(shardIndex: number, type: string, requiredInputs: string[]): ShardLocation {
  return {
    shard_index: shardIndex,
    provider_id: `p${shardIndex}`,
    provider_type: type,
    adapterPackage: null,
    connection_config: { host: '127.0.0.1', port: 9999, path: `/p${shardIndex}` },
    required_inputs: requiredInputs,
    remote_path: `/p${shardIndex}/shard_${shardIndex}.bfs.1`,
    shard_hash: 'a'.repeat(64),
  };
}

describe('connectProvidersFromMap dispatch to connectForRecovery', () => {
  beforeEach(() => {
    askSecretPrompts = [];
    recoverySpies = new Map();
    registerMockProviders();
  });

  afterEach(() => {
    unregisterMockProviders();
    vi.restoreAllMocks();
  });

  /**
   * Mock io that records every askSecret prompt (the legacy fallback path) and
   * answers with a non-empty value. The non-empty answer matters: with a blank
   * answer the legacy connectWithInputs short-circuits before instantiating the
   * provider, so a missing-dispatch failure could not be distinguished from a
   * never-built provider. A real secret lets the provider be constructed (and
   * its connectForRecovery spy registered), so the failing assertion is
   * specifically "the hook was not dispatched", not "the provider never ran".
   */
  function recordingIo(): ProviderIO {
    const { io } = createMockProviderIO({});
    io.askSecret = async (prompt: string): Promise<string> => {
      askSecretPrompts.push(prompt);
      return 'fallback-secret';
    };
    return io;
  }

  it('should call connectForRecovery for a provider that implements it (not the askSecret fallback)', async () => {
    // p0 = bootstrap (no hook). p1 = with-hook + a stripped secret. p2 = no hook.
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_WITH_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    const bootstrap = makeBootstrapProvider(0, map);
    const io = recordingIo();

    await bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 });

    const spy = recoverySpies.get('p1');
    expect(spy).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
    // Dispatched with (io, pool) where pool is an array.
    const callArgs = (spy as RecoverySpy).mock.calls[0];
    expect(callArgs[0]).toBe(io);
    expect(Array.isArray(callArgs[1])).toBe(true);
    // The legacy askSecret fallback must NOT run for the with-hook entry.
    expect(askSecretPrompts.some((p) => p.includes('p1'))).toBe(false);
  });

  it('should fall back to askSecret for a provider WITHOUT connectForRecovery', async () => {
    // p0 = bootstrap. p1 = no hook with a stripped secret → legacy prompt path.
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_NO_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    const bootstrap = makeBootstrapProvider(0, map);
    const io = recordingIo();

    await bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 });

    // No connectForRecovery spy was ever created for a no-hook provider.
    expect(recoverySpies.size).toBe(0);
    // The fallback path prompted for p1's stripped secret.
    expect(askSecretPrompts.some((p) => p.includes('p1'))).toBe(true);
  });

  it('should dispatch to connectForRecovery even when required_inputs is empty', async () => {
    // Guards the "attacker omits required_inputs" hole: the hook fires on
    // provider capability, NOT on the entry declaring required_inputs.
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_WITH_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    const bootstrap = makeBootstrapProvider(0, map);
    const io = recordingIo();

    await bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 });

    const spy = recoverySpies.get('p1');
    expect(spy).toBeDefined();
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

// ─── S2 — consensus compares location_map contents (RED) ─────────────────────
//
// Today `runConsensusCheck` (src/vault/bootstrap.ts) compares only HEADER fields
// (vault_id / blob_hash / version / data_shards / parity_shards / encrypted)
// between the bootstrap shard and ONE reachable sibling — it never compares the
// CONTENTS of the location_map. With encryption off, the map is raw JSON guarded
// only by an unkeyed trailing checksum: an attacker who rewrites a single shard
// can redirect a sibling provider's connection coordinates (host/port/path/user,
// required_inputs, remote_path) without touching any compared header field. The
// re-sealed shard is byte-valid, so the forgery passes today's consensus.
//
// GREEN contract: for each shard_index present in BOTH the bootstrap map and the
// reachable sibling's map, consensus also compares provider_type,
// connection_config (host/port/path/user), required_inputs and remote_path;
// any divergence throws TamperDetectedError.
//
// RED today: the forged bootstrap map (shard_1 host = "attacker") and the honest
// sibling map (shard_1 host = "honest") agree on every HEADER field, so
// bootstrapFromProvider returns normally instead of throwing TamperDetectedError.
describe('runConsensusCheck location_map cross-check (S2)', () => {
  const HONEST_TYPE = 'mock-honest-map';

  /** Per-id honest location map the sibling provider serves via downloadHeader. */
  let honestMaps: Map<string, ShardLocation[]>;

  beforeEach(() => {
    honestMaps = new Map();
    // A reachable sibling provider that authenticates (so it joins the connected
    // pool that runConsensusCheck cross-checks against) and serves its OWN header
    // — carrying the honest location_map — when consensus calls downloadHeader.
    providerRegistry.register(HONEST_TYPE, {
      lang: 'en',
      displayName: 'Mock (honest map)',
      create: (config: ProviderConfig): StorageProvider => {
        const p = baseProvider(config.id, HONEST_TYPE);
        const parsed = /^p(\d+)$/.exec(config.id);
        const ownIndex = parsed ? Number(parsed[1]) : 0;
        // The forged "attacker" host is a fake address that never connects: its
        // provider authenticate() rejects, so it drops out of the connected pool
        // and the honest sibling (p2) becomes the consensus cross-check target.
        if (config.config.host === 'attacker') {
          (p.authenticate as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unreachable attacker host'));
        }
        const map = honestMaps.get(config.id) ?? [];
        (p.downloadHeader as ReturnType<typeof vi.fn>).mockResolvedValue(buildHeaderBytes(map, ownIndex));
        return p;
      },
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
  });

  afterEach(() => {
    const entries = (providerRegistry as unknown as { entries: Map<string, unknown> }).entries;
    entries.delete(HONEST_TYPE);
    vi.restoreAllMocks();
  });

  /** Builds a location-map entry with an explicit host in connection_config. */
  function honestLoc(shardIndex: number, host: string): ShardLocation {
    return {
      shard_index: shardIndex,
      provider_id: `p${shardIndex}`,
      provider_type: HONEST_TYPE,
      adapterPackage: null,
      connection_config: { host, port: 9999, path: `/p${shardIndex}` },
      required_inputs: [],
      remote_path: `/p${shardIndex}/shard_${shardIndex}.bfs.1`,
      shard_hash: 'a'.repeat(64),
    };
  }

  it('should throw TamperDetectedError when a sibling entry diverges in connection_config', async () => {
    // Bootstrap shard_0 carries a FORGED map: shard_1 host = "attacker".
    // Reachable sibling shard_2 carries an HONEST map: shard_1 host = "honest".
    // Header fields are identical between the two maps, so today's header-only
    // consensus does NOT fire — yet the maps disagree on shard_1's host.
    const forgedMap = [honestLoc(0, 'honest'), honestLoc(1, 'attacker'), honestLoc(2, 'honest')];
    const honestSiblingMap = [honestLoc(0, 'honest'), honestLoc(1, 'honest'), honestLoc(2, 'honest')];

    // The bootstrap provider (p0) serves the forged map. The first reachable
    // sibling that consensus cross-checks is p2 (p1's "attacker" host is a fake
    // address that never connects), so p2 must serve the honest map.
    honestMaps.set('p2', honestSiblingMap);

    const bootstrap = baseProvider('p0', HONEST_TYPE);
    (bootstrap.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ provider_id: 'p0', path: 'shard_0.bfs.1' }] as RemoteRef[]);
    (bootstrap.downloadHeader as ReturnType<typeof vi.fn>).mockResolvedValue(buildHeaderBytes(forgedMap, 0));

    const { io } = createMockProviderIO({});

    await expect(bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 })).rejects.toThrow(TamperDetectedError);
  });
});
