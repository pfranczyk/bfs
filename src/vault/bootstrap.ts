import { Readable } from 'node:stream';
import { deriveKey } from '../core/crypto.js';
import { BfsError, TamperDetectedError } from '../core/errors.js';
import { parseShardHeaderFromStream, readShardHeaderBytes, SHARD_HEADER_READ_BYTES } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ProviderConfig, ProviderIO, RecoverySecret, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../types/index.js';
import { shardHeaderConsensusMismatch } from './consensus.js';

// ─── Result types ─────────────────────────────────────────────────────────────

export interface BootstrapResult {
  vault_id: string;
  vault_name: string;
  version: number;
  location_map: ShardLocation[];
  scheme: { data_shards: number; parity_shards: number };
  encrypted: boolean;
  kdf_salt: Nullable<Buffer>;
  /** Encryption key derived from password + kdf_salt (only set when encrypted=true and password provided) */
  encKey: Nullable<Buffer>;
  /** Providers discovered and connected from the location map */
  providers: StorageProvider[];
}

/**
 * Parses a version number from a shard filename.
 * Format: shard_{index}.bfs.{version}
 *
 * @param filename - e.g. "shard_0.bfs.10"
 * @returns { shardIndex, version } or null if the filename does not match
 */
export function parseVersionFromFilename(filename: string): Nullable<{ shardIndex: number; version: number }> {
  const match = /^shard_(\d+)\.bfs\.(\d+)$/.exec(filename);
  if (!match) return null;
  return { shardIndex: Number(match[1]), version: Number(match[2]) };
}

// ─── Private helpers ──────────────────────────────────────────────────────────

/**
 * Finds the RemoteRef for the given version among a provider's listed shard files.
 * @throws BfsError if no shard for that version exists in refs
 */
function findTargetShard(refs: RemoteRef[], version: number): RemoteRef {
  const ref = refs.find((r) => {
    const p = parseVersionFromFilename(r.path);
    return p !== null && p.version === version;
  });
  if (!ref) {
    throw new BfsError(`No shard for version ${version} on the bootstrap provider.`);
  }
  return ref;
}

/**
 * Asks the operator for one required input (a stripped secret) interactively.
 * Returns null when nothing usable was supplied — an empty answer, or no
 * interactive terminal (askSecret throws on EOF / non-TTY). Recovery treats
 * null as "cannot supply" and degrades by skipping the provider, never crashing.
 */
async function promptInput(io: ProviderIO, providerId: string, field: string): Promise<Nullable<string>> {
  try {
    const value = await io.askSecret(fmt('recovery_ask_transport_password', field, providerId));
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** Builds, authenticates and connects one provider from a config; null if unreachable. */
async function connectOne(loc: ShardLocation, config: Record<string, unknown>, vaultName: string, io: ProviderIO): Promise<Nullable<StorageProvider>> {
  try {
    const pc: ProviderConfig = { id: loc.provider_id, type: loc.provider_type, adapterPackage: loc.adapterPackage, config };
    const p = providerRegistry.create(pc, io);
    await p.authenticate();
    p.setVaultName(vaultName);
    return p;
  } catch {
    return null;
  }
}

/**
 * Connects a provider whose location map declares required_inputs (secrets
 * stripped from the header). Each input is taken from the shared pool first —
 * one credential reused across many providers, so the operator is asked once —
 * otherwise prompted interactively. On success the supplied values are written
 * back into loc.connection_config (so reconstructConfig persists them) and into
 * the pool. Returns null (degraded skip) when the operator gives up (blank
 * answer) or there is no interactive TTY to supply the input.
 */
async function connectWithInputs(loc: ShardLocation, required: string[], vaultName: string, io: ProviderIO, inputPool: Map<string, string>): Promise<Nullable<StorageProvider>> {
  // Unbounded by design: at this critical disaster-recovery moment the operator
  // retries as long as they need (recall the password, fix a typo). A blank
  // answer (promptInput → null) is the explicit "give up" signal; in a
  // non-interactive session promptInput also returns null on the first prompt,
  // so this never spins forever.
  let reusePool = true;
  for (;;) {
    const config: Record<string, unknown> = { ...loc.connection_config };
    const collected = new Map<string, string>();
    for (const field of required) {
      // The first round may reuse a pooled credential (shared across providers);
      // once a pooled value has failed to connect, later rounds always prompt.
      const pooled = reusePool ? inputPool.get(field) : undefined;
      const value = pooled ?? (await promptInput(io, loc.provider_id, field));
      if (value === null) return null; // operator gave up, or no interactive TTY → degraded
      config[field] = value;
      collected.set(field, value);
    }
    const provider = await connectOne(loc, config, vaultName, io);
    if (provider) {
      for (const [field, value] of collected) {
        loc.connection_config[field] = value; // persist into BootstrapResult map → config.json
        inputPool.set(field, value);
      }
      return provider;
    }
    reusePool = false; // pooled value failed; from now on always prompt
  }
}

/** Arguments for {@link connectViaRecoveryHook}. */
interface RecoveryHookArgs {
  /** Provider instance (already created) implementing connectForRecovery. */
  provider: StorageProvider;
  /** Location-map entry being connected. */
  loc: ShardLocation;
  /** Vault subdirectory name on the provider. */
  vaultName: string;
  /** ProviderIO for the credential interaction. */
  io: ProviderIO;
  /** Shared secret pool carried between recovery-hook providers (blind courier). */
  pool: RecoverySecret[];
  /** When true, the operator pre-approved the recovered locations (unattended run). */
  trustLocations: boolean;
}

/**
 * Connects a provider that owns its credential interaction via
 * connectForRecovery (the provider shows the target host and collects/reuses the
 * secret itself). The hook authenticates; on success the provider joins the
 * connected set and any returned secret is added to the pool for sibling reuse.
 * The secret is NOT written back into connection_config — BFS is blind to which
 * field it is — so it is never persisted to config.json by this path. Returns
 * null (degraded skip) when the operator declines or the connection fails.
 */
async function connectViaRecoveryHook(args: RecoveryHookArgs): Promise<Nullable<StorageProvider>> {
  const { provider, loc, vaultName, io, pool, trustLocations } = args;
  const hook = provider.connectForRecovery;
  if (!hook) return null; // caller guarantees the hook exists; defensive
  try {
    const secret = await hook.call(provider, io, pool, { trustLocation: trustLocations });
    provider.setVaultName(vaultName);
    if (secret !== null && secret !== undefined && secret.length > 0) {
      pool.push({ value: secret, origin: loc.provider_id });
      // Persist the collected secret into config.json (parity with the legacy
      // path and with a normal config) so a later non-interactive pull/push can
      // reconnect. required_inputs names the stripped secret field — BFS knows
      // it is a secret (getSecretFields → required_inputs); only "which field is
      // the host" is opaque to it, and the provider already showed that.
      const fields = loc.required_inputs ?? [];
      if (fields.length === 1) {
        const field = fields[0];
        if (field) loc.connection_config[field] = secret;
      }
    }
    return provider;
  } catch {
    return null; // operator declined or the provider was unreachable → degraded skip
  }
}

/**
 * Creates and connects a StorageProvider for each location-map entry.
 *
 * A provider that implements connectForRecovery owns the whole credential step:
 * BFS dispatches to it — INDEPENDENT of the entry's required_inputs — so a
 * crafted map cannot bypass the "show host before secret" guard by omitting
 * required_inputs. The pool of secrets collected this way is carried between
 * such providers (blind courier) for reuse.
 *
 * A provider without the hook uses the legacy path: entries declaring
 * required_inputs are prompted via io.askSecret (cannot show the host); inline
 * and guest entries connect directly. Anything still unreachable is skipped
 * (degraded mode).
 *
 * Pool seeding: the connectForRecovery pool starts EMPTY for interactive
 * recovery — the operator's bootstrap secret is never auto-sent to a (possibly
 * redirected) sibling without them seeing the host. It is seeded from the
 * bootstrap credential ONLY under --trust-locations (trustLocations=true), where
 * the operator pre-approved the recovered locations for an unattended run.
 */
async function connectProvidersFromMap(locationMap: ShardLocation[], vaultName: string, io: ProviderIO, seedInputs: Map<string, string>, trustLocations: boolean): Promise<StorageProvider[]> {
  const providers: StorageProvider[] = [];
  const inputPool = new Map(seedInputs); // legacy fallback pool (field → value)
  // connectForRecovery pool (value + origin). Empty for interactive recovery;
  // seeded from the bootstrap credential only when the operator opted into
  // unattended recovery with --trust-locations.
  const recoveryPool: RecoverySecret[] = trustLocations ? [...seedInputs.values()].map((value) => ({ value, origin: 'bootstrap' })) : [];
  for (const loc of locationMap) {
    // Build an instance to detect the recovery hook. Dispatch is by provider
    // capability, not by the entry's required_inputs.
    let probe: Nullable<StorageProvider> = null;
    try {
      probe = providerRegistry.create({ id: loc.provider_id, type: loc.provider_type, adapterPackage: loc.adapterPackage, config: { ...loc.connection_config } }, io);
    } catch {
      probe = null;
    }

    if (probe && typeof probe.connectForRecovery === 'function') {
      const connected = await connectViaRecoveryHook({ provider: probe, loc, vaultName, io, pool: recoveryPool, trustLocations });
      if (connected) providers.push(connected);
      continue;
    }

    const required = loc.required_inputs;
    const provider = required && required.length > 0 ? await connectWithInputs(loc, required, vaultName, io, inputPool) : await connectOne(loc, loc.connection_config, vaultName, io);
    if (provider) providers.push(provider);
  }
  return providers;
}

/** Arguments for {@link runConsensusCheck}. */
interface ConsensusCheckArgs {
  /** Already-authenticated provider the recovery started from. */
  bootstrapProvider: StorageProvider;
  /** Vault subdirectory name on each provider. */
  vaultName: string;
  /** Location map parsed from the bootstrap shard header. */
  locationMap: ShardLocation[];
  /** Bootstrap shard header fields (everything except the location map). */
  meta: Omit<ShardHeader, 'location_map'>;
  /** Version being bootstrapped. */
  version: number;
  /** ProviderIO for connecting siblings and warning. */
  io: ProviderIO;
}

/**
 * Cross-checks the bootstrap shard against the other shards in its location map
 * BEFORE any credential is sent. Each sibling is read with NO secret — built
 * from the stripped connection_config and connected with a bare authenticate;
 * a provider that needs a credential just to connect (e.g. FTP) throws here and
 * is skipped, so consensus never sends a secret. For every reachable sibling the
 * header fields and — for unencrypted vaults — the location_map contents are
 * compared with the bootstrap shard; any divergence aborts recovery. This is the
 * gate that stops a forged, unencrypted location map from redirecting a provider
 * to an attacker host. When no sibling is reachable without a secret it warns and
 * continues — the per-provider connectForRecovery host gate is the remaining
 * defense.
 *
 * @throws TamperDetectedError when a reachable sibling's header or location_map
 *   diverges from the bootstrap shard
 */
async function runConsensusCheck(args: ConsensusCheckArgs): Promise<void> {
  const { bootstrapProvider, vaultName, locationMap, meta, version, io } = args;
  let checked = 0;
  for (const loc of locationMap) {
    if (loc.provider_id === bootstrapProvider.id) continue;

    let sibling: StorageProvider;
    try {
      sibling = providerRegistry.create({ id: loc.provider_id, type: loc.provider_type, adapterPackage: loc.adapterPackage, config: { ...loc.connection_config } }, io);
      await sibling.authenticate();
      sibling.setVaultName(vaultName);
    } catch {
      continue; // unreachable without a secret — skip for consensus
    }

    let cm: ShardHeader;
    try {
      const bytes = await readShardHeaderBytes(sibling, { provider_id: loc.provider_id, path: `shard_${loc.shard_index}.bfs.${version}` }, SHARD_HEADER_READ_BYTES);
      const parsed = await parseShardHeaderFromStream(Readable.from(bytes));
      parsed.payloadStream.on('error', () => {}).destroy();
      cm = parsed.header;
    } catch {
      continue; // header unreadable — skip this sibling
    }

    const mismatch = shardHeaderConsensusMismatch({ ...meta, location_map: locationMap }, cm);
    if (mismatch.length > 0) {
      throw new TamperDetectedError(`Consensus check failed: shard headers from providers "${bootstrapProvider.id}" and "${loc.provider_id}" differ in fields: ${mismatch.join(', ')}.`);
    }
    checked++;
  }

  if (checked === 0) {
    io.warn(t('bootstrap_single_provider_warn'));
  }
}

/** Options for {@link bootstrapFromProvider}. */
export interface BootstrapOptions {
  /** Vault subdirectory name on the provider. */
  vaultName: string;
  /** ProviderIO for authenticating additional providers. */
  io: ProviderIO;
  /** Specific version to bootstrap; undefined = latest found. */
  targetVersion?: number | undefined;
  /** Known passwords to try for encrypted vaults (asks interactively if none work). */
  passwords?: string[] | undefined;
  /** Stripped transport secrets seeded into sibling connections (field → value). */
  transportInputs?: Record<string, string> | undefined;
  /** When true, seed sibling recovery from the bootstrap credential (unattended run). */
  trustLocations?: boolean | undefined;
}

/**
 * Bootstraps discovery from a single storage provider.
 * Downloads one shard, parses its header (optionally decrypting the location map),
 * verifies consensus with a second shard from a different provider,
 * and returns the discovered metadata and connected providers.
 *
 * @param bootstrapProvider - Already authenticated provider to start from
 * @param options           - vault name, IO, and optional version / passwords / transport inputs / trust flag
 * @returns BootstrapResult
 * @throws BfsError if no shards found or fewer than N shards available
 * @throws TamperDetectedError if consensus check fails
 */
export async function bootstrapFromProvider(bootstrapProvider: StorageProvider, options: BootstrapOptions): Promise<BootstrapResult> {
  const { vaultName, io, targetVersion, passwords, transportInputs } = options;
  const trustLocations = options.trustLocations ?? false;
  bootstrapProvider.setVaultName(vaultName);

  // Discover available versions from file listing
  const refs = await bootstrapProvider.list('shard_');
  const versionSet = new Set<number>();
  for (const ref of refs) {
    const parsed = parseVersionFromFilename(ref.path);
    if (parsed) versionSet.add(parsed.version);
  }
  if (versionSet.size === 0) {
    throw new BfsError(`No shards found for vault "${vaultName}" on the bootstrap provider.`);
  }
  const version = targetVersion !== undefined ? targetVersion : Math.max(...versionSet);

  // Pull only the header window — providers MUST avoid streaming the full
  // payload over the wire (FTP issues SIZE + aborts after maxBytes).
  const bootstrapRef = findTargetShard(refs, version);
  // Sidecar-aware: prefer the sidecar's current location map over the frozen
  // in-shard one so a relocated sibling is discovered at its new address.
  const headerBytes = await readShardHeaderBytes(bootstrapProvider, bootstrapRef, SHARD_HEADER_READ_BYTES);
  const { header: meta, payloadStream: ps1 } = await parseShardHeaderFromStream(Readable.from(headerBytes));
  ps1.on('error', () => {}).destroy();

  const parsedFilename = parseVersionFromFilename(bootstrapRef.path);
  if (!parsedFilename) throw new BfsError(`Shard filename format invalid: ${bootstrapRef.path}`);
  if (parsedFilename.shardIndex !== meta.shard_index || parsedFilename.version !== meta.version) {
    throw new BfsError(`Shard filename mismatch: file says index=${parsedFilename.shardIndex} ver=${parsedFilename.version}, ` + `header says index=${meta.shard_index} ver=${meta.version}`);
  }

  // Derive key and parse the location map (decrypt if encrypted)
  let encKey: Nullable<Buffer> = null;
  let location_map: ShardLocation[] = [];
  if (meta.encrypted) {
    if (!meta.kdf_salt) throw new BfsError('kdf_salt missing from encrypted shard header.');

    // Try provided passwords first, then ask interactively with retry.
    // We already hold the header bytes — re-parse them with each candidate
    // key instead of re-fetching the shard from the provider per attempt.
    const candidates = passwords ?? [];
    let resolved = false;
    for (const pwd of candidates) {
      try {
        encKey = await deriveKey(pwd, meta.kdf_salt);
        const { header: h, payloadStream: ps } = await parseShardHeaderFromStream(Readable.from(headerBytes), encKey);
        ps.on('error', () => {}).destroy();
        location_map = h.location_map;
        resolved = true;
        break;
      } catch {
        // wrong password — try next
      }
    }
    if (!resolved) {
      // Ask interactively, retrying until the password works or the operator
      // gives up with a blank entry. Unbounded: at this critical recovery moment
      // they keep trying until they recall the password. A blank entry (or no
      // interactive TTY) aborts — the encrypted vault cannot be opened without it.
      let firstTry = true;
      while (!resolved) {
        const ver = String(version);
        const prompt = firstTry ? fmt('bootstrap_ask_password', ver) : fmt('bootstrap_wrong_password_retry', ver);
        firstTry = false;
        const pwd = await io.askSecret(prompt);
        if (!pwd) throw new BfsError('Password required for encrypted backup.');
        try {
          encKey = await deriveKey(pwd, meta.kdf_salt);
          const { header: h, payloadStream: ps } = await parseShardHeaderFromStream(Readable.from(headerBytes), encKey);
          ps.on('error', () => {}).destroy();
          location_map = h.location_map;
          // Add successful interactive password to the pool for processVersion
          candidates.push(pwd);
          resolved = true;
        } catch {
          // wrong password — retry
        }
      }
    }
  } else {
    // Non-encrypted: location_map already parsed in first header read
    location_map = meta.location_map;
  }

  // Consensus BEFORE connecting with credentials: cross-check the bootstrap
  // shard against its siblings (read without secrets) so a forged location map
  // aborts here, before any secret could reach an attacker host.
  await runConsensusCheck({ bootstrapProvider, vaultName, locationMap: location_map, meta, version, io });

  // Connect to all providers discovered in the location map. A provider that
  // implements connectForRecovery owns its credential prompt (and shows its
  // host before sending the secret); others fall back to the legacy
  // required_inputs path.
  const seedInputs = new Map<string, string>(Object.entries(transportInputs ?? {}));
  const providers = await connectProvidersFromMap(location_map, vaultName, io, seedInputs, trustLocations);

  return { vault_id: meta.vault_id, vault_name: meta.vault_name, version, location_map, scheme: { data_shards: meta.data_shards, parity_shards: meta.parity_shards }, encrypted: meta.encrypted, kdf_salt: meta.kdf_salt, encKey, providers };
}
