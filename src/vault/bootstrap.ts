import { deriveKey } from '../core/crypto.js';
import { BfsError, TamperDetectedError } from '../core/errors.js';
import { parseShardHeaderFromStream } from '../core/shard-io.js';
import { t } from '../i18n/index.js';
import { createProvider } from '../providers/provider.js';
import type {
  ProviderConfig,
  ProviderIO,
  RemoteRef,
  ShardHeader,
  ShardLocation,
  StorageProvider,
} from '../types/index.js';

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
export function parseVersionFromFilename(
  filename: string,
): Nullable<{ shardIndex: number; version: number }> {
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
    throw new BfsError(
      `No shard for version ${version} on the bootstrap provider.`,
    );
  }
  return ref;
}

/**
 * Creates, authenticates, and connects a StorageProvider for each entry in the location map.
 * Providers that are unreachable are silently skipped (degraded mode).
 */
async function connectProvidersFromMap(
  locationMap: ShardLocation[],
  vaultName: string,
  io: ProviderIO,
): Promise<StorageProvider[]> {
  const providers: StorageProvider[] = [];
  for (const loc of locationMap) {
    const pc: ProviderConfig = {
      id: loc.provider_id,
      type: loc.provider_type,
      config: loc.connection_config,
    };
    try {
      const p = createProvider(pc, io);
      await p.authenticate();
      p.setVaultName(vaultName);
      providers.push(p);
    } catch {
      // Provider unreachable — include null slot so callers can handle degraded state
    }
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
async function runConsensusCheck(
  bootstrapProvider: StorageProvider,
  providers: StorageProvider[],
  locationMap: ShardLocation[],
  meta: Omit<ShardHeader, 'location_map'>,
  version: number,
  io: ProviderIO,
): Promise<void> {
  const consensusProviders = providers.filter(
    (p) => p.id !== bootstrapProvider.id,
  );
  if (consensusProviders.length === 0) {
    io.warn(t('bootstrap_single_provider_warn'));
    return;
  }

  const consensusProvider = consensusProviders[0]; // length > 0 guarantees element
  const consensusLoc = locationMap.find(
    (loc) => loc.provider_id === consensusProvider.id,
  );
  if (!consensusLoc) return;

  try {
    const consensusStream = await consensusProvider.download({
      provider_id: consensusProvider.id,
      path: `shard_${consensusLoc.shard_index}.bfs.${version}`,
    });
    // Only ~4 KB read for header; payloadStream discarded immediately
    const { header: cm, payloadStream: cps } =
      await parseShardHeaderFromStream(consensusStream);
    cps.destroy();

    const mismatch: string[] = [];
    if (cm.vault_id !== meta.vault_id) mismatch.push('vault_id');
    if (cm.blob_hash !== meta.blob_hash) mismatch.push('blob_hash');
    if (cm.version !== meta.version) mismatch.push('version');
    if (cm.data_shards !== meta.data_shards) mismatch.push('data_shards');
    if (cm.parity_shards !== meta.parity_shards) mismatch.push('parity_shards');
    if (cm.encrypted !== meta.encrypted) mismatch.push('encrypted');

    if (mismatch.length > 0) {
      throw new TamperDetectedError(
        `Consensus check failed: shard headers from providers "${bootstrapProvider.id}" ` +
          `and "${consensusProvider.id}" differ in fields: ${mismatch.join(', ')}.`,
      );
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
 * @param password          - Required if the vault is encrypted
 * @param io                - ProviderIO for authenticating additional providers
 * @returns BootstrapResult
 * @throws BfsError if no shards found or fewer than N shards available
 * @throws TamperDetectedError if consensus check fails
 */
export async function bootstrapFromProvider(
  bootstrapProvider: StorageProvider,
  vaultName: string,
  io: ProviderIO,
  targetVersion?: number,
  password?: string,
): Promise<BootstrapResult> {
  bootstrapProvider.setVaultName(vaultName);

  // Discover available versions from file listing
  const refs = await bootstrapProvider.list('shard_');
  const versionSet = new Set<number>();
  for (const ref of refs) {
    const parsed = parseVersionFromFilename(ref.path);
    if (parsed) versionSet.add(parsed.version);
  }
  if (versionSet.size === 0) {
    throw new BfsError(
      `No shards found for vault "${vaultName}" on the bootstrap provider.`,
    );
  }
  const version =
    targetVersion !== undefined ? targetVersion : Math.max(...versionSet);

  // Download bootstrap shard — only reads ~4 KB for header (no full-shard buffering)
  const bootstrapRef = findTargetShard(refs, version);
  const bootstrapStream = await bootstrapProvider.download(bootstrapRef);
  const { header: meta, payloadStream: ps1 } =
    await parseShardHeaderFromStream(bootstrapStream);
  ps1.destroy(); // discard payload — only header metadata needed

  const parsedFilename = parseVersionFromFilename(bootstrapRef.path);
  if (!parsedFilename)
    throw new BfsError(`Shard filename format invalid: ${bootstrapRef.path}`);
  if (
    parsedFilename.shardIndex !== meta.shard_index ||
    parsedFilename.version !== meta.version
  ) {
    throw new BfsError(
      `Shard filename mismatch: file says index=${parsedFilename.shardIndex} ver=${parsedFilename.version}, ` +
        `header says index=${meta.shard_index} ver=${meta.version}`,
    );
  }

  // Derive key and parse the location map (decrypt if encrypted)
  let encKey: Nullable<Buffer> = null;
  let location_map: ShardLocation[];
  if (meta.encrypted) {
    if (!password)
      throw new BfsError(
        'Vault is encrypted — provide --password to bootstrap.',
      );
    if (!meta.kdf_salt)
      throw new BfsError('kdf_salt missing from encrypted shard header.');
    encKey = await deriveKey(password, meta.kdf_salt);
    // Re-download to parse location map with decryption key (~4 KB read)
    const stream2 = await bootstrapProvider.download(bootstrapRef);
    const { header: h2, payloadStream: ps2 } = await parseShardHeaderFromStream(
      stream2,
      encKey,
    );
    ps2.destroy();
    location_map = h2.location_map;
  } else {
    // Non-encrypted: location_map already parsed in first header read
    location_map = meta.location_map;
  }

  // Connect to all providers discovered in the location map, then run consensus check
  const providers = await connectProvidersFromMap(location_map, vaultName, io);
  await runConsensusCheck(
    bootstrapProvider,
    providers,
    location_map,
    meta,
    version,
    io,
  );

  return {
    vault_id: meta.vault_id,
    vault_name: meta.vault_name,
    version,
    location_map,
    scheme: {
      data_shards: meta.data_shards,
      parity_shards: meta.parity_shards,
    },
    encrypted: meta.encrypted,
    kdf_salt: meta.kdf_salt,
    encKey,
    providers,
  };
}
