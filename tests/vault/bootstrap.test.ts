import { afterEach, assert, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveKey, generateSalt } from '../../src/core/crypto.js';
import { TamperDetectedError } from '../../src/core/errors.js';
import { serializeShardHeader } from '../../src/core/shard-io.js';
import { t } from '../../src/i18n/index.js';
import { createMockProviderIO, providerRegistry } from '../../src/providers/provider.js';
import type { ProviderConfig, ProviderIO, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../../src/types/index.js';
import { bootstrapFromProvider } from '../../src/vault/bootstrap.js';

// --- Contract under test (RED) ----------------------------------------------
//
// The recovery credential-phishing fix introduces an OPTIONAL provider hook:
//
//   connectForRecovery?(io: ProviderIO, pool: readonly RecoverySecret[]):
//     Promise<Nullable<string>>;
//
// `connectProvidersFromMap` (private, in src/vault/bootstrap.ts) must dispatch
// to this hook whenever the provider implements it - INDEPENDENT of the
// entry's `required_inputs` - and only fall back to the legacy
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

/** Spy recording every connectForRecovery dispatch (provider id -> io + pool). */
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
 * Base of a connected StorageProvider - every method is a no-op stub except the
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
      const p = baseProvider(config.id, TYPE_WITH_HOOK) as StorageProvider & { connectForRecovery?: (io: ProviderIO, pool: readonly { value: string; origin: string }[]) => Promise<Nullable<string>> };
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
    // p0 = bootstrap. p1 = no hook with a stripped secret -> legacy prompt path.
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

// --- Config updates handed back by a provider during recovery -----------------
//
// A provider may learn something during recovery that belongs in its own saved
// configuration - the server identity the operator confirmed, so that the next
// command does not ask again and an unattended one does not refuse. The core is
// blind to field semantics, so the provider hands the update back through the
// optional `takeConfigUpdates()` and the core merges it into the location-map
// entry the instance was built from (reconstructConfig writes config.json from
// those entries). Only instances built from map entries count: the bootstrap
// medium reaches config.json through its own entry, never through the bootstrap
// instance, whose id is a temporary one and whose medium may be a copy of a part
// on another server. Boundaries: the update lands in connection_config only,
// secret fields are dropped, a merged config the provider itself rejects drops
// the whole update, and an instance that did not end up connected hands back
// nothing - nor does a consensus instance, which never takes a decision.

/** Provider type whose instances implement connectForRecovery and takeConfigUpdates. */
const TYPE_UPDATES_HOOK = 'mock-updates-hook';
/** Provider type with takeConfigUpdates but no connectForRecovery (direct connect path). */
const TYPE_UPDATES_DIRECT = 'mock-updates-direct';

/** How an instance came to be asked for its updates. */
type InstanceRole = 'recovery-hook' | 'authenticate';

/** Per-test answer: what an instance of `id` reached through `role` hands back. */
let updatesFor: (id: string, role: InstanceRole) => Nullable<Record<string, unknown>>;
/** Ids whose connection fails (operator declined, server unreachable) on either path. */
let failingIds: Set<string>;
/** Secret a recovery-hook instance of `id` returns (what the operator typed). */
let secretFor: Map<string, string>;
/** When true, validateConfig also demands a non-empty `password`, as a real adapter does. */
let requirePassword: boolean;
/** Location map every updates-provider instance serves in its header (null = unreadable). */
let servedMap: Nullable<ShardLocation[]>;

/**
 * Builds a provider whose `takeConfigUpdates` answers per instance role: an
 * instance that went through connectForRecovery reports 'recovery-hook', one that
 * was only authenticated (consensus, direct connect) reports 'authenticate'. The
 * secret field is `password`; validateConfig rejects a `host_key_fingerprint`
 * that does not start with `SHA256:` (and a missing password under
 * `requirePassword`). With `servedMap` set the instance serves a parseable header
 * of its own shard, so consensus really compares it.
 */
function updatesProvider(config: ProviderConfig, type: string, withHook: boolean): StorageProvider {
  const p = baseProvider(config.id, type) as StorageProvider & {
    connectForRecovery?: (io: ProviderIO, pool: readonly { value: string; origin: string }[]) => Promise<Nullable<string>>;
    takeConfigUpdates?: () => Nullable<Record<string, unknown>>;
  };
  let role: InstanceRole = 'authenticate';
  (p.getSecretFields as ReturnType<typeof vi.fn>).mockReturnValue(['password']);
  (p.validateConfig as ReturnType<typeof vi.fn>).mockImplementation((c: Record<string, unknown>) => {
    const errors: string[] = [];
    const fp = c.host_key_fingerprint;
    if (!(fp === undefined || fp === null || (typeof fp === 'string' && fp.startsWith('SHA256:')))) errors.push('host_key_fingerprint is not a fingerprint');
    if (requirePassword && !(typeof c.password === 'string' && c.password.length > 0)) errors.push('password is required');
    return errors;
  });
  (p.authenticate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
    if (failingIds.has(config.id)) throw new Error('unreachable');
  });
  const shardIndex = Number(config.id.replace(/^p/, ''));
  (p.downloadHeader as ReturnType<typeof vi.fn>).mockImplementation(async () => (servedMap === null ? Buffer.alloc(0) : buildHeaderBytes(servedMap, shardIndex)));
  if (withHook) {
    p.connectForRecovery = vi.fn(async () => {
      role = 'recovery-hook';
      if (failingIds.has(config.id)) throw new Error('declined');
      return secretFor.get(config.id) ?? null;
    });
  }
  p.takeConfigUpdates = () => updatesFor(config.id, role);
  return p;
}

function registerUpdatesProviders(): void {
  providerRegistry.register(TYPE_UPDATES_HOOK, {
    lang: 'en',
    displayName: 'Mock (updates, recovery hook)',
    create: (config: ProviderConfig): StorageProvider => updatesProvider(config, TYPE_UPDATES_HOOK, true),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
  providerRegistry.register(TYPE_UPDATES_DIRECT, {
    lang: 'en',
    displayName: 'Mock (updates, direct connect)',
    create: (config: ProviderConfig): StorageProvider => updatesProvider(config, TYPE_UPDATES_DIRECT, false),
    help: () => ({ usage: '', description: '', flags: [], examples: [] }),
  });
}

function unregisterUpdatesProviders(): void {
  const entries = (providerRegistry as unknown as { entries: Map<string, unknown> }).entries;
  entries.delete(TYPE_UPDATES_HOOK);
  entries.delete(TYPE_UPDATES_DIRECT);
}

/** The connection_config bootstrap left on the entry of `id`. */
function entryConfig(map: readonly ShardLocation[], id: string): Record<string, unknown> {
  const entry = map.find((l) => l.provider_id === id);
  assert(entry !== undefined, `no location-map entry for ${id}`);
  return entry.connection_config;
}

describe('connectProvidersFromMap merges config updates handed back by a provider', () => {
  beforeEach(() => {
    askSecretPrompts = [];
    recoverySpies = new Map();
    failingIds = new Set();
    secretFor = new Map();
    requirePassword = false;
    servedMap = null;
    updatesFor = () => null;
    registerMockProviders();
    registerUpdatesProviders();
  });

  afterEach(() => {
    unregisterUpdatesProviders();
    unregisterMockProviders();
    vi.restoreAllMocks();
  });

  it('should write the update of a recovery-hook instance into its own location-map entry', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:confirmed-p1' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1', host_key_fingerprint: 'SHA256:confirmed-p1' });
    expect(entryConfig(result.location_map, 'p2')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p2' });
  });

  it('should write the update of a directly connected instance into its own location-map entry', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_DIRECT, []), loc(2, TYPE_NO_HOOK, [])];
    updatesFor = (id) => (id === 'p1' ? { host_key_fingerprint: 'SHA256:confirmed-p1' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1').host_key_fingerprint).toBe('SHA256:confirmed-p1');
  });

  // The bootstrap medium is also an entry of the map, connected under its real
  // provider id - that is the instance whose update counts. The bootstrap
  // instance itself (temporary id, possibly pointed at a copy of the part on
  // another server) hands back a different key, which must not land anywhere.
  it('should pin the bootstrap medium through its own map entry and ignore the bootstrap instance', async () => {
    const map = [loc(0, TYPE_UPDATES_HOOK, []), loc(1, TYPE_NO_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    updatesFor = (id, role) => (id === 'p0' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:map-entry-p0' } : null);
    const bootstrap = makeBootstrapProvider(0, map) as StorageProvider & { takeConfigUpdates?: () => Nullable<Record<string, unknown>> };
    (bootstrap as { id: string }).id = 'bootstrap-mock';
    bootstrap.takeConfigUpdates = () => ({ host_key_fingerprint: 'SHA256:bootstrap-copy' });
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p0').host_key_fingerprint).toBe('SHA256:map-entry-p0');
    for (const entry of result.location_map) {
      expect(JSON.stringify(entry)).not.toContain('SHA256:bootstrap-copy');
    }
  });

  // The same layout with the map entry handing back nothing: an implementation
  // that pastes the bootstrap instance's update onto the entry of the same part
  // index would be overwritten by the entry's own update in the case above and
  // pass it - here nothing covers it up.
  it('should not pin the bootstrap medium from the bootstrap instance when its map entry hands back nothing', async () => {
    const map = [loc(0, TYPE_UPDATES_HOOK, []), loc(1, TYPE_NO_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    const bootstrap = makeBootstrapProvider(0, map) as StorageProvider & { takeConfigUpdates?: () => Nullable<Record<string, unknown>> };
    (bootstrap as { id: string }).id = 'bootstrap-mock';
    bootstrap.takeConfigUpdates = () => ({ host_key_fingerprint: 'SHA256:bootstrap-copy' });
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(result.providers.some((p) => p.id === 'p0')).toBe(true);
    expect(entryConfig(result.location_map, 'p0')).not.toHaveProperty('host_key_fingerprint');
  });

  // The main path of an attended recovery: the operator types the password
  // (handed back by the hook and persisted under the single required input) and
  // confirms the server identity (handed back as an update). Both must land: the
  // secret filter applies to the update alone, not to the merged config, and the
  // validation runs on the config as it will be saved - with the secret in it.
  it('should keep the typed secret and land the update when the provider requires the secret to validate', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    secretFor = new Map([['p1', 'typed-by-operator']]);
    requirePassword = true;
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:confirmed-p1', password: 'smuggled-secret' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1', password: 'typed-by-operator', host_key_fingerprint: 'SHA256:confirmed-p1' });
  });

  // Twin of the case above without a smuggled password in the update - a real
  // adapter never hands one back. Validating the bare update before the typed
  // secret is written would drop the pin here, while the smuggled value above
  // would mask that order.
  it('should validate the update against the config as saved, with the typed secret in it', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    secretFor = new Map([['p1', 'typed-by-operator']]);
    requirePassword = true;
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:confirmed-p1' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1', password: 'typed-by-operator', host_key_fingerprint: 'SHA256:confirmed-p1' });
  });

  // The secret fields come from getSecretFields(), not from the entry's
  // required_inputs: an entry that declares none (nothing stripped, or a legacy
  // map) must not become a way to smuggle a secret into config.json.
  it('should drop secret fields from an update and keep the rest', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:confirmed-p1', password: 'smuggled-secret' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    const config = entryConfig(result.location_map, 'p1');
    expect(config.host_key_fingerprint).toBe('SHA256:confirmed-p1');
    expect(config).not.toHaveProperty('password');
  });

  it('should drop the whole update when the merged config fails the validation of the provider', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'not-a-fingerprint', note: 'rides along' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1' });
  });

  // Positive control for the validation case above: the same shape with a valid
  // fingerprint lands, so the drop is decided by validateConfig, not by the field.
  it('should keep an update whose merged config passes the validation of the provider', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:confirmed-p1', note: 'rides along' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1', host_key_fingerprint: 'SHA256:confirmed-p1', note: 'rides along' });
  });

  // A value that does not survive a JSON round trip cannot be written to
  // config.json as handed back, so the update is dropped in whole.
  it('should drop the whole update when it carries a value that is not JSON', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:confirmed-p1', callback: () => 'not data' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1' });
  });

  it('should land the update in connection_config only and leave the rest of the entry untouched', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    secretFor = new Map([['p1', 'typed-by-operator']]);
    updatesFor = (id, role) => (id === 'p1' && role === 'recovery-hook' ? { host_key_fingerprint: 'SHA256:confirmed-p1', remote_path: '/elsewhere', provider_id: 'hijacked', required_inputs: [] } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    const entry = result.location_map.find((l) => l.shard_index === 1);
    assert(entry !== undefined, 'entry for shard 1 missing');
    expect(entry.connection_config.host_key_fingerprint).toBe('SHA256:confirmed-p1');
    expect(entry.provider_id).toBe('p1');
    expect(entry.remote_path).toBe('/p1/shard_1.bfs.1');
    expect(entry.required_inputs).toEqual(['password']);
  });

  // The direct path builds a probe instance first and connects a second one; an
  // update from either must not land when the connection failed.
  it('should take nothing from a directly connected instance whose connection failed', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_DIRECT, []), loc(2, TYPE_NO_HOOK, [])];
    failingIds = new Set(['p1']);
    updatesFor = (id) => (id === 'p1' ? { host_key_fingerprint: 'SHA256:never-confirmed' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(result.providers.some((p) => p.id === 'p1')).toBe(false);
    expect(entryConfig(result.location_map, 'p1')).not.toHaveProperty('host_key_fingerprint');
  });

  // The direct path that prompts for a stripped secret (no recovery hook): the
  // typed secret and the update both land.
  it('should land the update of an instance connected after the operator typed its stripped secret', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_DIRECT, ['password']), loc(2, TYPE_NO_HOOK, [])];
    requirePassword = true;
    updatesFor = (id) => (id === 'p1' ? { host_key_fingerprint: 'SHA256:confirmed-p1' } : null);
    const { io } = createMockProviderIO({});
    io.askSecret = async (): Promise<string> => 'typed-by-operator';

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1', password: 'typed-by-operator', host_key_fingerprint: 'SHA256:confirmed-p1' });
  });

  it('should take nothing from an instance whose recovery connection failed', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    failingIds = new Set(['p1']);
    updatesFor = (id) => (id === 'p1' ? { host_key_fingerprint: 'SHA256:never-confirmed' } : null);
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(result.providers.some((p) => p.id === 'p1')).toBe(false);
    expect(entryConfig(result.location_map, 'p1')).not.toHaveProperty('host_key_fingerprint');
  });

  // Consensus reads siblings without a secret before any decision is taken; an
  // update an instance built there might hold is not the operator's decision.
  // The sibling serves a matching header, so consensus really compares it (no
  // "single provider" warning) - an implementation collecting after a successful
  // comparison would otherwise slip past.
  it('should take nothing from a consensus instance', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_UPDATES_HOOK, []), loc(2, TYPE_NO_HOOK, [])];
    servedMap = map;
    updatesFor = (id, role) => (id === 'p1' && role === 'authenticate' ? { host_key_fingerprint: 'SHA256:consensus-instance' } : null);
    const { io, logs } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(logs.some((l) => l.level === 'warn' && l.message === t('bootstrap_single_provider_warn'))).toBe(false);
    expect(entryConfig(result.location_map, 'p1')).not.toHaveProperty('host_key_fingerprint');
  });

  // An adapter compiled against the contract without the hook keeps recovering
  // exactly as before: its entry is not touched.
  it('should leave the entry of a provider without takeConfigUpdates unchanged', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_WITH_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    const { io } = createMockProviderIO({});

    const result = await bootstrapFromProvider(makeBootstrapProvider(0, map), { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(result.providers.some((p) => p.id === 'p1')).toBe(true);
    expect(entryConfig(result.location_map, 'p1')).toEqual({ host: '127.0.0.1', port: 9999, path: '/p1' });
  });
});

// --- S2 - consensus compares location_map contents (RED) ---------------------
//
// Today `runConsensusCheck` (src/vault/bootstrap.ts) compares only HEADER fields
// (vault_id / blob_hash / version / data_shards / parity_shards / encrypted)
// between the bootstrap shard and ONE reachable sibling - it never compares the
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
    // - carrying the honest location_map - when consensus calls downloadHeader.
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
    // consensus does NOT fire - yet the maps disagree on shard_1's host.
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

// --- consensus must not fire a doomed auth on a secret-less sibling ----------
//
// runConsensusCheck (src/vault/bootstrap.ts) cross-checks siblings built from the
// STRIPPED connection_config: the secret named in required_inputs is NOT in the
// map, because consensus runs before any credential is collected. A sibling whose
// required_inputs is non-empty is therefore unreachable at consensus time and
// must be skipped BEFORE any authenticate() call. This matters for a transport
// that authenticates WITH the secret (SSH password auth): a bare authenticate()
// there is a full, doomed credential attempt, and on a real OpenSSH server >=9.8 a
// burst of such failures from one source trips PerSourcePenalties and poisons the
// following recovery connection.
//
// This test asserts the observable TRIGGER - that no credentialed authenticate()
// is fired at the secret-less sibling. The mock registry does not model
// PerSourcePenalties, so the full storm is exercised end-to-end only against a
// real penalizing server via scripts/cli-e2e/scenarios/80-ssh-all.
describe('runConsensusCheck must not attempt a doomed auth on a secret-less sibling', () => {
  const SSH_LIKE_TYPE = 'mock-ssh-like';
  const PLAIN_TYPE = 'mock-plain-consensus';
  /** Ids of SSH-like siblings whose authenticate() fired WITHOUT the stripped secret present. */
  let secretlessAuths: string[];

  beforeEach(() => {
    secretlessAuths = [];
    // A plain sibling/bootstrap type that connects with no secret (no stripped
    // input) - models a guest/anon provider whose secret-less authenticate is
    // legitimate, so it must not be counted as a doomed attempt.
    providerRegistry.register(PLAIN_TYPE, {
      lang: 'en',
      displayName: 'Mock (plain, no secret)',
      create: (config: ProviderConfig): StorageProvider => baseProvider(config.id, PLAIN_TYPE),
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
    // An SSH-like sibling: it authenticates ONLY with a password. Built from the
    // stripped map (no password) it records the doomed attempt and fails, exactly
    // as a real SSH password-auth with an empty password would.
    providerRegistry.register(SSH_LIKE_TYPE, {
      lang: 'en',
      displayName: 'Mock (ssh-like, password auth)',
      create: (config: ProviderConfig): StorageProvider => {
        const p = baseProvider(config.id, SSH_LIKE_TYPE);
        const hasSecret = 'password' in config.config && String(config.config.password ?? '').length > 0;
        (p.authenticate as ReturnType<typeof vi.fn>).mockImplementation(async () => {
          if (!hasSecret) {
            secretlessAuths.push(config.id);
            throw new Error('SSH auth failed: password required');
          }
        });
        return p;
      },
      help: () => ({ usage: '', description: '', flags: [], examples: [] }),
    });
  });

  afterEach(() => {
    const entries = (providerRegistry as unknown as { entries: Map<string, unknown> }).entries;
    entries.delete(SSH_LIKE_TYPE);
    entries.delete(PLAIN_TYPE);
    vi.restoreAllMocks();
  });

  it('should skip a secret-less SSH sibling without firing a credentialed authenticate during consensus', async () => {
    // p0 = bootstrap (plain, no secret). p1 = SSH-like sibling whose password
    // was stripped from the map (required_inputs=['password']). Consensus must
    // NOT call p1.authenticate() with the bare, secret-less config.
    const map = [loc(0, PLAIN_TYPE, []), loc(1, SSH_LIKE_TYPE, ['password'])];
    const bootstrap = makeBootstrapProvider(0, map);

    const { io } = createMockProviderIO({});
    // The credentialed connect phase (after consensus) supplies the secret - that
    // authenticate carries a password and is legitimate, so it is not recorded.
    io.askSecret = async (): Promise<string> => 'the-password';

    await bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(secretlessAuths).toEqual([]);
  });
});

// --- Recovery on a machine with nobody at the keyboard -----------------------
//
// `--bootstrap`, cron and a closed stdin all mark the run non-interactive
// (`io.interactive === false`). A prompt issued there never settles: the event
// loop empties, the process dies where it stands, and recovery leaves a
// half-written .bfs/ behind a zero exit code. Both prompting points of the
// bootstrap path must therefore decide without asking - the transport secret of
// a sibling degrades to a skip, and the missing vault password ends the run
// with a message naming how to supply one.
describe('bootstrapFromProvider with no one to answer a prompt', () => {
  beforeEach(() => {
    askSecretPrompts = [];
    recoverySpies = new Map();
    registerMockProviders();
  });

  afterEach(() => {
    unregisterMockProviders();
    vi.restoreAllMocks();
  });

  it('should skip a sibling whose stripped secret cannot be asked for', async () => {
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_NO_HOOK, ['password']), loc(2, TYPE_NO_HOOK, [])];
    const bootstrap = makeBootstrapProvider(0, map);
    const { io } = createMockProviderIO({}, process.cwd(), false);
    const askSecret = vi.spyOn(io, 'askSecret').mockResolvedValue('would-be-answered');

    const result = await bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 });

    expect(askSecret).not.toHaveBeenCalled();
    expect(result.providers.some((p) => p.id === 'p1')).toBe(false);
  });

  it('should refuse an encrypted backup with no password instead of prompting for one', async () => {
    const salt = generateSalt();
    const key = await deriveKey('the-password', salt);
    const map = [loc(0, TYPE_NO_HOOK, []), loc(1, TYPE_NO_HOOK, [])];
    const bootstrap = baseProvider('p0', TYPE_NO_HOOK);
    (bootstrap.list as ReturnType<typeof vi.fn>).mockResolvedValue([{ provider_id: 'p0', path: 'shard_0.bfs.1' }] as RemoteRef[]);
    (bootstrap.downloadHeader as ReturnType<typeof vi.fn>).mockResolvedValue(
      serializeShardHeader(
        {
          magic: 'BFSS',
          format_version: 2,
          vault_id: VAULT_ID,
          vault_name: VAULT_NAME,
          blob_size: 256n,
          blob_hash: 'b'.repeat(64),
          data_shards: 2,
          parity_shards: 1,
          shard_index: 0,
          version: 1,
          encrypted: true,
          kdf_salt: salt,
          rs_stripe_size: 64 * 1024,
          map_length: 0,
          location_map: map,
        },
        key,
      ),
    );
    const { io } = createMockProviderIO({}, process.cwd(), false);
    const askSecret = vi.spyOn(io, 'askSecret').mockResolvedValue('the-password');

    await expect(bootstrapFromProvider(bootstrap, { vaultName: VAULT_NAME, io, targetVersion: 1 })).rejects.toThrow(/--password/);

    expect(askSecret).not.toHaveBeenCalled();
  });
});
