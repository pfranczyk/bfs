import { Readable } from 'node:stream';
import { deriveKey } from '../core/crypto.js';
import { BfsError } from '../core/errors.js';
import { hashBuffer, streamToBuffer } from '../core/hash.js';
import { rsRepair } from '../core/reed-solomon.js';
import { buildHeaderBytes, buildShard, buildShardHeaderFromBytes } from '../core/shard-io.js';
import { providerRegistry } from '../providers/provider.js';
import type {
  ManifestShard,
  ProviderConfig,
  ProviderIO,
  RebuildAllVersionsOptions,
  RebuildVersionOptions,
  RelocateProviderOptions,
  RemoteRef,
  ShardHeader,
  ShardLocation,
  UpdateLocationMapsOptions,
  VaultConfig,
  VersionManifest,
} from '../types/index.js';
import { VersionHealth } from '../types/index.js';
import { readConfig, writeConfig } from './config.js';
import { splitLocationSecrets } from './location-map.js';
import { listManifests, readManifest, writeManifest } from './manifest.js';
import { readState } from './state.js';
import { buildRemotePath, extractShardPayload } from './vault-manager.js';

// ─── Report types ─────────────────────────────────────────────────────────────

export interface HealReport {
  repaired: number;
  degraded: number;
  versions_repaired: number[];
  versions_degraded: number[];
}

// ─── Private helpers for rebuildVersion ───────────────────────────────────────

/**
 * Downloads all available shard payloads for a version, skipping the removed provider.
 * Returns a slots array (null where unavailable) and a map of raw shard binaries for
 * header inspection.
 */
async function downloadAvailableShards(config: VaultConfig, manifest: VersionManifest, removedProviderId: string, io: ProviderIO): Promise<{ shardSlots: Nullable<Buffer>[]; shardDataMap: Map<number, Buffer> }> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const version = manifest.version;
  const shardSlots: Nullable<Buffer>[] = new Array(N + K).fill(null);
  const shardDataMap = new Map<number, Buffer>();

  for (const ms of manifest.shards) {
    if (ms.provider_id === removedProviderId) continue;
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) continue;
    try {
      const provider = providerRegistry.create(pc, io);
      await provider.authenticate();
      provider.setVaultName(config.vault_name);
      const stream = await provider.download({ provider_id: ms.provider_id, path: `shard_${ms.shard_index}.bfs.${version}` });
      const data = await streamToBuffer(stream);
      shardSlots[ms.shard_index] = extractShardPayload(data);
      shardDataMap.set(ms.shard_index, data);
    } catch {
      // skip unavailable shard
    }
  }
  return { shardSlots, shardDataMap };
}

/**
 * Extracts shard metadata (blob_size, blob_hash, kdf_salt, etc.) from the first
 * available raw shard binary. Also derives the AES-256-GCM key if the vault is encrypted.
 * @throws BfsError if encrypted but kdf_salt is unavailable after scanning all shards
 */
async function extractShardMeta(
  shardDataMap: Map<number, Buffer>,
  manifest: VersionManifest,
  password: string | undefined,
): Promise<{ encKey: Buffer | undefined; kdf_salt: Nullable<Buffer>; blobSize: bigint; blobHash: string; formatVersion: number; vaultId: string; vaultName: string; rsStripeSize: Nullable<number> }> {
  let encKey: Buffer | undefined;
  let kdf_salt: Nullable<Buffer> = null;
  let blobSize = BigInt(0);
  let blobHash = '';
  let formatVersion = 1;
  let vaultId = '';
  let vaultName = '';
  let rsStripeSize: Nullable<number> = null;

  for (const [, rawData] of shardDataMap) {
    const meta = buildShardHeaderFromBytes(rawData);
    blobSize = meta.blob_size;
    blobHash = meta.blob_hash;
    formatVersion = meta.format_version;
    vaultId = meta.vault_id;
    vaultName = meta.vault_name;
    rsStripeSize = meta.rs_stripe_size;
    if (meta.kdf_salt) {
      kdf_salt = meta.kdf_salt;
      if (manifest.encrypted && password) {
        encKey = await deriveKey(password, meta.kdf_salt);
      }
    }
    break;
  }
  if (manifest.encrypted && password && !encKey) {
    throw new BfsError('Could not retrieve kdf_salt from available shards.');
  }
  return { encKey, kdf_salt, blobSize, blobHash, formatVersion, vaultId, vaultName, rsStripeSize };
}

/**
 * Builds the repaired shard binary and uploads it to the target provider.
 * @throws BfsError if the target provider cannot be authenticated
 */
async function uploadRepairedShard(targetProviderConfig: ProviderConfig, header: ShardHeader, payload: Buffer, filename: string, vaultName: string, encKey: Buffer | undefined, io: ProviderIO): Promise<void> {
  const targetProvider = providerRegistry.create(targetProviderConfig, io);
  await targetProvider.authenticate();
  targetProvider.setVaultName(vaultName);
  const shardBuffer = buildShard(header, payload, encKey);
  await targetProvider.upload(filename, Readable.from(shardBuffer), shardBuffer.length);
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Updates the location map embedded in all available shards of the given version.
 * For encrypted vaults, decrypts the old location map, replaces it, and re-encrypts.
 * Uses provider.updateShardHeader() for each available shard.
 *
 * @param rootDir  - Vault root directory
 * @param version  - Version number to update
 * @param options  - newLocationMap, io, and optional password
 * @throws BfsError if config or manifest is missing, or password is required but absent
 */
export async function updateLocationMaps(rootDir: string, version: number, options: UpdateLocationMapsOptions): Promise<void> {
  const { newLocationMap, io, password } = options;
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const manifest = await readManifest(rootDir, version);
  if (!manifest) throw new BfsError(`Manifest for version ${version} not found.`);

  if (manifest.encrypted && !password) {
    throw new BfsError('Password required to update location maps in an encrypted vault.');
  }

  for (const ms of manifest.shards) {
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) continue; // provider removed from config — skip

    try {
      const provider = providerRegistry.create(pc, io);
      await provider.authenticate();
      provider.setVaultName(config.vault_name);

      const filename = `shard_${ms.shard_index}.bfs.${version}`;
      const ref: RemoteRef = { provider_id: ms.provider_id, path: filename };

      // Download existing shard to read its header metadata
      const shardStream = await provider.download(ref);
      const shardData = await streamToBuffer(shardStream);
      const meta = buildShardHeaderFromBytes(shardData);

      // Derive encryption key if needed
      let encKey: Buffer | undefined;
      if (meta.encrypted && password && meta.kdf_salt) {
        encKey = await deriveKey(password, meta.kdf_salt);
      }

      // Build new shard header with the updated location map
      const newHeader: ShardHeader = {
        magic: 'BFSS',
        format_version: meta.format_version,
        vault_id: meta.vault_id,
        vault_name: meta.vault_name,
        blob_size: meta.blob_size,
        blob_hash: meta.blob_hash,
        data_shards: meta.data_shards,
        parity_shards: meta.parity_shards,
        shard_index: meta.shard_index,
        version: meta.version,
        encrypted: meta.encrypted,
        kdf_salt: meta.kdf_salt,
        rs_stripe_size: meta.rs_stripe_size,
        map_length: 0,
        location_map: newLocationMap,
      };

      const newHeaderBytes = buildHeaderBytes(newHeader, encKey);
      await provider.updateShardHeader(ref, newHeaderBytes);
    } catch {
      // skip unavailable providers — they will need separate heal later
    }
  }
}

/**
 * Rebuilds a lost/corrupted shard using Reed-Solomon repair and uploads it
 * to a new target provider. Also updates location maps on all remaining shards.
 *
 * @param rootDir  - Vault root directory
 * @param version  - Version to repair
 * @param options  - removedProviderId, targetProviderId, io, and optional password
 * @throws BfsError if not enough shards available or password missing for encrypted vault
 */
export async function rebuildVersion(rootDir: string, version: number, options: RebuildVersionOptions): Promise<void> {
  const { removedProviderId, targetProviderId, io, password } = options;
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const manifest = await readManifest(rootDir, version);
  if (!manifest) throw new BfsError(`Manifest for version ${version} not found.`);

  if (manifest.encrypted && !password) {
    throw new BfsError('Password required for RS repair in an encrypted vault.');
  }

  const { data_shards: N, parity_shards: K } = manifest.scheme;

  // Find which shard index belongs to the removed provider
  const removedShard = manifest.shards.find((s) => s.provider_id === removedProviderId);
  if (!removedShard) return; // this version doesn't use the removed provider — nothing to do

  const targetProviderConfig = config.providers.find((p) => p.id === targetProviderId);
  if (!targetProviderConfig) {
    throw new BfsError(`Target provider "${targetProviderId}" not found in config.`);
  }

  // Validate invariant: targetProvider must not already hold a shard for this version
  const targetAlreadyHasShard = manifest.shards.some((s) => s.provider_id === targetProviderId);
  if (targetAlreadyHasShard) {
    throw new BfsError(`Target provider "${targetProviderId}" already holds a shard for version ${version}. Each provider can hold at most one shard per version.`);
  }

  // Download all available shards (skip the removed provider)
  const { shardSlots, shardDataMap } = await downloadAvailableShards(config, manifest, removedProviderId, io);

  const available = shardSlots.filter((s) => s !== null).length;
  if (available < N) {
    throw new BfsError(`Not enough shards to repair version ${version}: need ${N}, got ${available}.`);
  }

  // RS repair — produces all N+K shard payloads
  const repaired = rsRepair(shardSlots, N, K);
  const repairedPayload = repaired[removedShard.shard_index];
  if (!repairedPayload) {
    throw new BfsError(`RS repair failed for shard ${removedShard.shard_index} in version ${version}.`);
  }
  const repairedPayloadHash = hashBuffer(repairedPayload);

  // Build new location map: swap removedProvider → targetProvider
  const newLocationMap: ShardLocation[] = manifest.shards.map((ms) => {
    if (ms.provider_id === removedProviderId) {
      const split = splitLocationSecrets(targetProviderConfig.type, targetProviderConfig.config, io);
      return {
        shard_index: ms.shard_index,
        provider_id: targetProviderId,
        provider_type: targetProviderConfig.type,
        adapterPackage: targetProviderConfig.adapterPackage,
        connection_config: split.connection_config,
        required_inputs: split.required_inputs,
        remote_path: buildRemotePath(targetProviderConfig, config.vault_name, `shard_${ms.shard_index}.bfs.${version}`),
        shard_hash: repairedPayloadHash,
      };
    }
    const sourceProvider = config.providers.find((p) => p.id === ms.provider_id);
    const split = splitLocationSecrets(ms.provider_type, sourceProvider?.config ?? {}, io);
    return {
      shard_index: ms.shard_index,
      provider_id: ms.provider_id,
      provider_type: ms.provider_type,
      adapterPackage: sourceProvider?.adapterPackage ?? null,
      connection_config: split.connection_config,
      required_inputs: split.required_inputs,
      remote_path: ms.remote_path,
      shard_hash: ms.shard_hash,
    };
  });

  // Extract metadata and key from the first available shard
  const shardMeta = await extractShardMeta(shardDataMap, manifest, password);
  const { encKey, kdf_salt, blobSize, blobHash, formatVersion, vaultId, vaultName } = shardMeta;

  // Build and upload the repaired shard to the target provider
  const repairedHeader: ShardHeader = {
    magic: 'BFSS',
    format_version: formatVersion,
    vault_id: vaultId,
    vault_name: vaultName,
    blob_size: blobSize,
    blob_hash: blobHash,
    data_shards: N,
    parity_shards: K,
    shard_index: removedShard.shard_index,
    version,
    encrypted: manifest.encrypted,
    kdf_salt,
    rs_stripe_size: shardMeta.rsStripeSize ?? null,
    map_length: 0,
    location_map: newLocationMap,
  };
  const repairedFilename = `shard_${removedShard.shard_index}.bfs.${version}`;
  await uploadRepairedShard(targetProviderConfig, repairedHeader, repairedPayload, repairedFilename, config.vault_name, encKey, io);

  // Update location maps on all existing (available) shards
  await updateLocationMaps(rootDir, version, { newLocationMap, io, ...(password !== undefined ? { password } : {}) });

  // Update manifest
  const updatedShards: ManifestShard[] = manifest.shards.map((ms) => {
    if (ms.provider_id === removedProviderId) {
      return {
        shard_index: ms.shard_index,
        provider_id: targetProviderId,
        provider_type: targetProviderConfig.type,
        remote_path: buildRemotePath(targetProviderConfig, config.vault_name, `shard_${ms.shard_index}.bfs.${version}`),
        shard_hash: repairedPayloadHash,
      };
    }
    return ms;
  });

  await writeManifest(rootDir, { ...manifest, shards: updatedShards, health: VersionHealth.Healthy });
}

/**
 * Rebuilds all specified versions after a provider was lost.
 * Uploads repaired shards to targetProvider and updates location maps.
 *
 * @param rootDir  - Vault root directory
 * @param options  - removedProviderId, targetProviderId, scope, io, and optional password
 * @returns HealReport
 */
export async function rebuildAllVersions(rootDir: string, options: RebuildAllVersionsOptions): Promise<HealReport> {
  const { removedProviderId, targetProviderId, scope, io, password } = options;
  const state = await readState(rootDir);
  const manifests = await listManifests(rootDir);

  const affectedManifests = manifests.filter((m) => m.shards.some((s) => s.provider_id === removedProviderId));

  let targetVersions: number[];
  if (scope === 'all') {
    targetVersions = affectedManifests.map((m) => m.version);
  } else if (scope === 'latest') {
    targetVersions = affectedManifests.filter((m) => m.version === state.latest_version).map((m) => m.version);
  } else {
    targetVersions = scope;
  }

  const report: HealReport = { repaired: 0, degraded: 0, versions_repaired: [], versions_degraded: [] };

  for (const version of targetVersions) {
    try {
      await rebuildVersion(rootDir, version, { removedProviderId, targetProviderId, io, ...(password !== undefined ? { password } : {}) });
      report.repaired++;
      report.versions_repaired.push(version);
    } catch {
      // Mark as degraded
      const manifest = await readManifest(rootDir, version);
      if (manifest && manifest.health !== VersionHealth.Degraded) {
        manifest.health = VersionHealth.Degraded;
        await writeManifest(rootDir, manifest);
      }
      report.degraded++;
      report.versions_degraded.push(version);
    }
  }

  return report;
}

/**
 * Handles provider relocation: the shard still exists but the provider has a new address.
 * Verifies provider accessibility, confirms shards exist, then updates location maps
 * in all existing shards and in config.json.
 *
 * @param rootDir    - Vault root directory
 * @param providerId - Existing provider id to relocate
 * @param options    - newConnectionConfig, io, optional password and newType
 * @throws BfsError if provider is unreachable at new address or shards are missing
 */
export async function relocateProvider(rootDir: string, providerId: string, options: RelocateProviderOptions): Promise<void> {
  const { newConnectionConfig, io, password, newType } = options;
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const existingProvider = config.providers.find((p) => p.id === providerId);
  if (!existingProvider) throw new BfsError(`Provider "${providerId}" not found in config.`);

  const resolvedType = newType ?? existingProvider.type;
  // When the type changes the adapter may also change — refresh the package
  // metadata from the registry so the probed provider advertises the correct
  // provenance. When the type is unchanged, keep the persisted adapterPackage.
  const updatedMeta = providerRegistry.getMeta(resolvedType);
  const updatedAdapterPackage = resolvedType === existingProvider.type ? existingProvider.adapterPackage : updatedMeta ? `${updatedMeta.packageName}@${updatedMeta.packageVersion}` : null;

  // Create a temporary config with the new connection parameters
  const updatedProviderConfig = { ...existingProvider, type: resolvedType, adapterPackage: updatedAdapterPackage, config: newConnectionConfig };
  const tempProvider = providerRegistry.create(updatedProviderConfig, io);

  // Verify accessibility
  const healthy = await tempProvider.healthCheck();
  if (!healthy) {
    throw new BfsError(`Provider "${providerId}" is not accessible at the new address.`);
  }

  await tempProvider.authenticate();
  tempProvider.setVaultName(config.vault_name);

  // Verify shards exist on the new address for all relevant versions
  const manifests = await listManifests(rootDir);
  const affectedManifests = manifests.filter((m) => m.shards.some((s) => s.provider_id === providerId));

  for (const manifest of affectedManifests) {
    const ms = manifest.shards.find((s) => s.provider_id === providerId);
    if (!ms) continue;
    const filename = `shard_${ms.shard_index}.bfs.${manifest.version}`;
    const refs = await tempProvider.list(filename);
    if (!refs.some((r) => r.path === filename)) {
      throw new BfsError(`Shard "${filename}" not found at new provider address for version ${manifest.version}.`);
    }
  }

  // Update config.json with the new connection config (and type if changed).
  // When the type changes, refresh adapterPackage from the registry so the
  // persisted metadata matches the new adapter's provenance.
  const resolvedMeta = providerRegistry.getMeta(resolvedType);
  const resolvedAdapterPackage = resolvedMeta ? `${resolvedMeta.packageName}@${resolvedMeta.packageVersion}` : null;
  const updatedProviders = config.providers.map((p) => (p.id === providerId ? { ...p, type: resolvedType, adapterPackage: resolvedAdapterPackage, config: newConnectionConfig } : p));
  await writeConfig(rootDir, { ...config, providers: updatedProviders });

  // Update location maps in all affected shards (new connection_config)
  for (const manifest of affectedManifests) {
    const newLocationMap: ShardLocation[] = manifest.shards.map((ms) => {
      if (ms.provider_id === providerId) {
        const filename = `shard_${ms.shard_index}.bfs.${manifest.version}`;
        const split = splitLocationSecrets(resolvedType, newConnectionConfig, io);
        return {
          shard_index: ms.shard_index,
          provider_id: providerId,
          provider_type: resolvedType,
          adapterPackage: resolvedAdapterPackage,
          connection_config: split.connection_config,
          required_inputs: split.required_inputs,
          remote_path: [String(newConnectionConfig.path ?? ''), config.vault_name, filename].join('/').replace(/\\/g, '/'),
          shard_hash: ms.shard_hash,
        };
      }
      const pc = config.providers.find((p) => p.id === ms.provider_id);
      const split = splitLocationSecrets(ms.provider_type, pc?.config ?? {}, io);
      return {
        shard_index: ms.shard_index,
        provider_id: ms.provider_id,
        provider_type: ms.provider_type,
        adapterPackage: pc?.adapterPackage ?? null,
        connection_config: split.connection_config,
        required_inputs: split.required_inputs,
        remote_path: ms.remote_path,
        shard_hash: ms.shard_hash,
      };
    });

    // Re-read config (now updated) for the location map update
    await updateLocationMaps(rootDir, manifest.version, { newLocationMap, io, ...(password !== undefined ? { password } : {}) });
  }
}
