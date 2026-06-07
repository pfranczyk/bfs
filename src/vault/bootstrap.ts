import { Readable } from 'node:stream';
import { deriveKey } from '../core/crypto.js';
import { BfsError, TamperDetectedError } from '../core/errors.js';
import { parseShardHeaderFromStream, SHARD_HEADER_READ_BYTES } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ProviderConfig, ProviderIO, RemoteRef, ShardHeader, ShardLocation, StorageProvider } from '../types/index.js';

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

/**
 * Creates, authenticates and connects a StorageProvider for each location-map
 * entry. Entries declaring required_inputs (secrets stripped from the header)
 * are supplied from the pool first — seeded with the operator's --bootstrap
 * secrets, so providers sharing a credential connect without a prompt — then
 * interactively. Legacy entries (secret still inline) and guest entries
 * (required_inputs empty) connect directly. Anything still unreachable is
 * skipped (degraded mode).
 */
async function connectProvidersFromMap(locationMap: ShardLocation[], vaultName: string, io: ProviderIO, seedInputs: Map<string, string>): Promise<StorageProvider[]> {
  const providers: StorageProvider[] = [];
  const inputPool = new Map(seedInputs);
  for (const loc of locationMap) {
    const required = loc.required_inputs;
    const provider = required && required.length > 0 ? await connectWithInputs(loc, required, vaultName, io, inputPool) : await connectOne(loc, loc.connection_config, vaultName, io);
    if (provider) providers.push(provider);
  }
  return providers;
}

/**
 * Fetches a shard from a different provider and compares critical header fields
 * against the bootstrap shard's metadata. Detects tampering or data corruption.
 * If no second provider is reachable, logs a warning and continues.
 *
 * @throws TamperDetectedError if any header field differs between the two shards
 */
async function runConsensusCheck(bootstrapProvider: StorageProvider, providers: StorageProvider[], locationMap: ShardLocation[], meta: Omit<ShardHeader, 'location_map'>, version: number, io: ProviderIO): Promise<void> {
  const consensusProviders = providers.filter((p) => p.id !== bootstrapProvider.id);
  if (consensusProviders.length === 0) {
    io.warn(t('bootstrap_single_provider_warn'));
    return;
  }

  const consensusProvider = consensusProviders[0]; // length > 0 guarantees element
  const consensusLoc = locationMap.find((loc) => loc.provider_id === consensusProvider.id);
  if (!consensusLoc) return;

  try {
    const consensusBytes = await consensusProvider.downloadHeader({ provider_id: consensusProvider.id, path: `shard_${consensusLoc.shard_index}.bfs.${version}` }, SHARD_HEADER_READ_BYTES);
    const { header: cm, payloadStream: cps } = await parseShardHeaderFromStream(Readable.from(consensusBytes));
    cps.on('error', () => {}).destroy();

    const mismatch: string[] = [];
    if (cm.vault_id !== meta.vault_id) mismatch.push('vault_id');
    if (cm.blob_hash !== meta.blob_hash) mismatch.push('blob_hash');
    if (cm.version !== meta.version) mismatch.push('version');
    if (cm.data_shards !== meta.data_shards) mismatch.push('data_shards');
    if (cm.parity_shards !== meta.parity_shards) mismatch.push('parity_shards');
    if (cm.encrypted !== meta.encrypted) mismatch.push('encrypted');

    if (mismatch.length > 0) {
      throw new TamperDetectedError(`Consensus check failed: shard headers from providers "${bootstrapProvider.id}" ` + `and "${consensusProvider.id}" differ in fields: ${mismatch.join(', ')}.`);
    }
  } catch (err) {
    if (err instanceof TamperDetectedError) throw err;
    // Consensus provider unreachable — warn but continue
  }
}

/**
 * Bootstraps discovery from a single storage provider.
 * Downloads one shard, parses its header (optionally decrypting the location map),
 * verifies consensus with a second shard from a different provider,
 * and returns the discovered metadata and connected providers.
 *
 * @param bootstrapProvider - Already authenticated provider to start from
 * @param vaultName         - Vault subdirectory name on the provider
 * @param targetVersion     - Specific version to bootstrap; null/undefined = latest found
 * @param passwords         - Known passwords to try for encrypted vaults (asks interactively if none work)
 * @param io                - ProviderIO for authenticating additional providers
 * @returns BootstrapResult
 * @throws BfsError if no shards found or fewer than N shards available
 * @throws TamperDetectedError if consensus check fails
 */
export async function bootstrapFromProvider(bootstrapProvider: StorageProvider, vaultName: string, io: ProviderIO, targetVersion?: number, passwords?: string[], transportInputs?: Record<string, string>): Promise<BootstrapResult> {
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
  const headerBytes = await bootstrapProvider.downloadHeader(bootstrapRef, SHARD_HEADER_READ_BYTES);
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

  // Connect to all providers discovered in the location map, then run consensus
  // check. The operator's --bootstrap secrets seed the pool, so providers that
  // share a credential connect without an extra prompt.
  const seedInputs = new Map<string, string>(Object.entries(transportInputs ?? {}));
  const providers = await connectProvidersFromMap(location_map, vaultName, io, seedInputs);
  await runConsensusCheck(bootstrapProvider, providers, location_map, meta, version, io);

  return { vault_id: meta.vault_id, vault_name: meta.vault_name, version, location_map, scheme: { data_shards: meta.data_shards, parity_shards: meta.parity_shards }, encrypted: meta.encrypted, kdf_salt: meta.kdf_salt, encKey, providers };
}
