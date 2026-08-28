import { Readable } from 'node:stream';
import { decryptShardPayload, deriveKey, deriveShardNonce, encryptShardPayload } from '../core/crypto.js';
import { BfsError, ShardCorruptedError, TamperDetectedError } from '../core/errors.js';
import { assertSafeVaultName } from '../core/fs-utils.js';
import { hashBuffer, streamToBuffer } from '../core/hash.js';
import { rsRepair, rsRepairStriped } from '../core/reed-solomon.js';
import { buildHeaderBytes, buildShard, buildShardHeaderFromBytes, buildShardV2, buildSidecarBytes, SHARD_HEADER_READ_BYTES, shardChecksumMatches } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type {
  ManifestShard,
  ProviderConfig,
  ProviderIO,
  RebuildAllVersionsOptions,
  RebuildShardInPlaceOptions,
  RebuildVersionOptions,
  RelocateProviderOptions,
  RemoteRef,
  ShardHeader,
  ShardIdentity,
  ShardLocation,
  StorageProvider,
  UpdateLocationMapsOptions,
  VaultConfig,
  VersionManifest,
} from '../types/index.js';
import { VersionHealth } from '../types/index.js';
import { readConfig, writeConfig } from './config.js';
import { splitLocationSecrets } from './location-map.js';
import { applyHealthChange, listManifests, readManifest, writeManifest } from './manifest.js';
import { buildRemotePath, extractShardPayload } from './vault-manager.js';

// --- Report types -------------------------------------------------------------

/** Why one version could not be rebuilt: the step, the storage and its own words. */
export interface RebuildFailure {
  version: number;
  message: string;
}

/**
 * What a rebuild run came to. `versions_degraded` are the versions that were
 * attempted and failed; `versions_not_attempted` those the run never reached,
 * because an earlier failure would have repeated for them (the target
 * refusing, a sibling not answering). Both are stamped degraded - the
 * operator declared the old storage lost and nothing replaced it there.
 */
export interface HealReport {
  repaired: number;
  degraded: number;
  versions_repaired: number[];
  versions_degraded: number[];
  versions_not_attempted: number[];
  failures: RebuildFailure[];
}

/** A sibling that did not answer at all - it will not answer for the next version either. */
interface UnreachableSibling {
  provider_id: string;
  message: string;
}

// --- Private helpers for rebuildVersion ---------------------------------------

/**
 * Downloads the shard payloads available for a version, skipping the removed
 * provider and any shard that fails its own trailing checksum - a shard damaged
 * on its medium must not seed the version's metadata nor enter the RS decode.
 *
 * A sibling that does not answer at all (create / authenticate) is recorded
 * separately from one that merely lacks the part: the first will not answer
 * for the next version either, so a caller looping over versions can stop
 * instead of failing them one by one.
 *
 * @returns a slots array (null where a shard is unavailable or damaged), a map
 *          of the accepted raw shard binaries for header inspection, how many
 *          siblings were rejected for failing their own checksum, and the
 *          siblings that did not answer
 */
async function downloadAvailableShards(
  config: VaultConfig,
  manifest: VersionManifest,
  removedProviderId: string,
  io: ProviderIO,
): Promise<{ shardSlots: Nullable<Buffer>[]; shardDataMap: Map<number, Buffer>; damagedSiblings: number; unreachable: UnreachableSibling[] }> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const version = manifest.version;
  const shardSlots: Nullable<Buffer>[] = new Array(N + K).fill(null);
  const shardDataMap = new Map<number, Buffer>();
  const unreachable: UnreachableSibling[] = [];
  let damagedSiblings = 0;

  for (const ms of manifest.shards) {
    if (ms.provider_id === removedProviderId) continue;
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) continue;
    let provider: StorageProvider;
    try {
      provider = providerRegistry.create(pc, io);
      await provider.authenticate();
      provider.setVaultName(config.vault_name);
    } catch (err: unknown) {
      unreachable.push({ provider_id: ms.provider_id, message: _messageOf(err) });
      continue;
    }
    try {
      const stream = await provider.download({ provider_id: ms.provider_id, path: `shard_${ms.shard_index}.bfs.${version}` });
      const data = await streamToBuffer(stream);
      // A shard that fails its own trailing checksum rotted on the medium. Its
      // header must not seed the version's identity (extractShardMeta reads
      // kdf_salt and the blob metadata from whichever shard it sees first) and
      // its payload must not enter the RS decode, or the repair bakes the damage
      // into the rebuilt shard. Dropping it here is also what keeps a divergence
      // between the surviving shards meaningful: a header that disagrees while
      // its own checksum verifies was rewritten deliberately, not corrupted.
      if (!shardChecksumMatches(data)) {
        damagedSiblings++;
        io.warn(fmt('heal_shard_corrupt_skip', ms.provider_id));
        continue;
      }
      shardSlots[ms.shard_index] = extractShardPayload(data);
      shardDataMap.set(ms.shard_index, data);
    } catch {
      // The storage answered but this part is not there or not readable - a
      // problem of this version, not of the storage.
    }
  }
  return { shardSlots, shardDataMap, damagedSiblings, unreachable };
}

/** Renders any thrown value as the text the operator gets. */
function _messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** How the repaired version's health is recorded once the new shard is in place. */
interface RepairVerdict {
  health: VersionHealth;
  deepRot: boolean;
}

/**
 * Works out the verdict a finished repair leaves behind. The repair replaces one
 * part; every other part is exactly as the media held it, so a sibling that could
 * not be read - rotted or unreachable - still costs the version its redundancy
 * and must not be stamped healthy. Rot is the stronger finding of the two: it was
 * read off the bytes, so it carries provenance, while an unreachable sibling
 * establishes nothing and retires as soon as the medium is back.
 *
 * @param soundSiblings   - Siblings that yielded a shard passing its own checksum
 * @param manifest        - Manifest of the version being repaired (for the scheme)
 * @param damagedSiblings - Siblings rejected for failing their own checksum
 * @returns the health to stamp and whether it rests on rot read off the media
 */
function verdictAfterRepair(soundSiblings: number, manifest: VersionManifest, damagedSiblings: number): RepairVerdict {
  const expectedSiblings = manifest.scheme.data_shards + manifest.scheme.parity_shards - 1;
  const health = soundSiblings >= expectedSiblings ? VersionHealth.Healthy : VersionHealth.Degraded;
  return { health, deepRot: damagedSiblings > 0 };
}

/**
 * Extracts and cross-validates shard metadata across ALL available raw shards.
 * Every shard of a version carries the same vault_id, vault_name, blob_hash,
 * blob_size, rs_stripe_size and kdf_salt, so any divergence between siblings
 * means a tampered (unencrypted) header - heal refuses rather than silently
 * adopting a forged field from whichever shard happened to be read first. Also
 * validates vault_name as a safe path segment (it drives the remote shard path)
 * and derives the AES-256-GCM key when the vault is encrypted.
 * @throws TamperDetectedError if available shards disagree on identity fields
 * @throws UnsafePathError if vault_name is not a safe path segment
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
  let seen = false;

  for (const [, rawData] of shardDataMap) {
    const meta = buildShardHeaderFromBytes(rawData);
    if (!seen) {
      blobSize = meta.blob_size;
      blobHash = meta.blob_hash;
      formatVersion = meta.format_version;
      vaultId = meta.vault_id;
      vaultName = meta.vault_name;
      rsStripeSize = meta.rs_stripe_size;
      seen = true;
    } else {
      const diffs: string[] = [];
      if (meta.vault_id !== vaultId) diffs.push('vault_id');
      if (meta.vault_name !== vaultName) diffs.push('vault_name');
      if (meta.blob_hash !== blobHash) diffs.push('blob_hash');
      if (meta.blob_size !== blobSize) diffs.push('blob_size');
      if (meta.rs_stripe_size !== rsStripeSize) diffs.push('rs_stripe_size');
      if (diffs.length > 0) {
        throw new TamperDetectedError(`Shard headers for version ${manifest.version} disagree on: ${diffs.join(', ')}.`);
      }
    }
    if (meta.kdf_salt) {
      if (kdf_salt && !kdf_salt.equals(meta.kdf_salt)) {
        throw new TamperDetectedError(`Shard headers for version ${manifest.version} disagree on: kdf_salt.`);
      }
      kdf_salt = meta.kdf_salt;
      if (manifest.encrypted && password && !encKey) {
        encKey = await deriveKey(password, meta.kdf_salt);
      }
    }
  }

  if (manifest.encrypted && password && !encKey) {
    throw new BfsError('Could not retrieve kdf_salt from available shards.');
  }
  // vault_name becomes a directory segment on every medium - reject traversal
  // before it reaches buildRemotePath (the provider chokepoint guards too).
  assertSafeVaultName(vaultName);
  return { encKey, kdf_salt, blobSize, blobHash, formatVersion, vaultId, vaultName, rsStripeSize };
}

/** Arguments for {@link uploadRepairedShard}. */
interface UploadRepairedShardOptions {
  /** Target provider config the repaired shard is written to. */
  targetProviderConfig: ProviderConfig;
  /** Shard header to serialize (V2 striped or V1 legacy, by format_version). */
  header: ShardHeader;
  /** Shard payload in stored form (encrypted ciphertext+tag, or raw). */
  payload: Buffer;
  /** Remote filename (shard_{index}.bfs.{version}). */
  filename: string;
  /** Vault subdirectory name on the target provider. */
  vaultName: string;
  /** Encryption key for the header location map (undefined when unencrypted). */
  encKey: Buffer | undefined;
  /** ProviderIO for probing the target provider. */
  io: ProviderIO;
}

/**
 * Builds the repaired shard binary and uploads it to the target provider.
 * @returns the byte length of the shard as uploaded, for the read-back check
 * @throws BfsError if the target provider cannot be reached or provisioned
 */
async function uploadRepairedShard(options: UploadRepairedShardOptions): Promise<number> {
  const { targetProviderConfig, header, payload, filename, vaultName, encKey, io } = options;
  const targetProvider = providerRegistry.create(targetProviderConfig, io);
  targetProvider.setVaultName(vaultName);
  // A rebuild target is a possibly-fresh or wiped medium (lost disk / replaced
  // server), so its base directory may not exist yet. probeConnection provisions
  // it - exactly as init does - and validates connectivity; a bare authenticate()
  // would instead list the base path and hard-fail on a provider (SSH) that lists
  // strictly, leaving the reconstructed shard unwritten.
  await targetProvider.probeConnection();
  // V2 shards carry a striped header (with rs_stripe_size) and a payload already
  // in stored form (encrypted ciphertext+tag, or raw); V1 legacy uses buildShard.
  const shardBuffer = header.format_version >= 2 ? buildShardV2(header, payload, encKey) : buildShard(header, payload, encKey);
  await targetProvider.upload(filename, Readable.from(shardBuffer), shardBuffer.length);
  return shardBuffer.length;
}

interface RepairShardPayloadOptions {
  shardSlots: Nullable<Buffer>[];
  formatVersion: number;
  dataShards: number;
  parityShards: number;
  removedIndex: number;
  encrypted: boolean;
  encKey: Buffer | undefined;
  version: number;
  rsStripeSize: Nullable<number>;
}

/**
 * Rebuilds the removed shard's payload in the exact on-disk form its siblings
 * use. V2 (format_version >= 2): striped RS repair over the plaintext payloads,
 * then per-shard AES-GCM re-encryption with the deterministic nonce. V1 legacy:
 * flat RS repair, payload stored verbatim (V1 encrypts the whole blob before RS,
 * so shard payloads are ciphertext slices that RS-repair directly). Returns the
 * final stored payload plus the SHA-256 of the plaintext payload - the value
 * push records as shard_hash.
 *
 * @param options - shard slots, scheme, removed index, encryption context
 * @returns finalPayload (stored form) and plaintextHash
 * @throws BfsError if RS repair fails, or a V2 encrypted vault lacks the key or rs_stripe_size
 */
function _repairShardPayload(options: RepairShardPayloadOptions): { finalPayload: Buffer; plaintextHash: string } {
  const { shardSlots, formatVersion, dataShards: N, parityShards: K, removedIndex, encrypted, encKey, version, rsStripeSize } = options;
  if (formatVersion < 2) {
    const payload = rsRepair(shardSlots, N, K)[removedIndex];
    if (!payload) throw new BfsError(`RS repair failed for shard ${removedIndex} in version ${version}.`);
    return { finalPayload: payload, plaintextHash: hashBuffer(payload) };
  }
  if (rsStripeSize === null) {
    throw new BfsError(`V2 shard header for version ${version} is missing rs_stripe_size; cannot repair.`);
  }
  if (encrypted && !encKey) {
    throw new BfsError(`Encryption key required to repair encrypted version ${version}.`);
  }
  const plaintextSlots = encrypted && encKey ? shardSlots.map((s, i) => (s !== null ? decryptShardPayload(s, encKey, deriveShardNonce(encKey, version, i)) : null)) : shardSlots;
  const plaintext = rsRepairStriped(plaintextSlots, N, K, rsStripeSize)[removedIndex];
  if (!plaintext) throw new BfsError(`RS repair failed for shard ${removedIndex} in version ${version}.`);
  const finalPayload = encrypted && encKey ? encryptShardPayload(plaintext, encKey, deriveShardNonce(encKey, version, removedIndex)) : plaintext;
  return { finalPayload, plaintextHash: hashBuffer(plaintext) };
}

// --- Public API ---------------------------------------------------------------

/**
 * Updates the location map embedded in all available shards of the given version.
 * For encrypted vaults, decrypts the old location map, replaces it, and re-encrypts.
 * Each provider decides how the updated header is stored: `usesSidecar() === true`
 * (what all built-ins do) writes it to the `hdr_` sidecar next to the shard,
 * leaving the payload untouched; `false` rewrites it in place via
 * `updateShardHeader()`.
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
    if (!pc) continue; // provider removed from config - skip

    const provider = providerRegistry.create(pc, io);
    try {
      await provider.authenticate();
    } catch {
      // Provider unreachable - skip; it will need a separate heal later.
      continue;
    }

    try {
      provider.setVaultName(config.vault_name);

      const filename = `shard_${ms.shard_index}.bfs.${version}`;
      const ref: RemoteRef = { provider_id: ms.provider_id, path: filename };

      // Read the shard's frozen header fields. A sidecar provider takes a bounded
      // header read (KB) instead of pulling the whole shard just to restamp the
      // location map; the in-shard header's non-map fields never change on relocate.
      const usesSidecar = provider.usesSidecar();
      const meta = usesSidecar ? buildShardHeaderFromBytes(await provider.downloadHeader(ref, SHARD_HEADER_READ_BYTES)) : buildShardHeaderFromBytes(await streamToBuffer(await provider.download(ref)));

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

      // Sidecar: upload only the new header (KB) beside the untouched payload.
      // In-place: rewrite the whole shard with the new header + recomputed checksum.
      if (usesSidecar) {
        await provider.uploadHeaderSidecar(ref, buildSidecarBytes(newHeader, encKey));
      } else {
        await provider.updateShardHeader(ref, buildHeaderBytes(newHeader, encKey));
      }
    } catch {
      // The provider is reachable but the header rewrite failed - this shard's
      // location map is now stale. Surface it instead of hiding it behind the
      // "unavailable" skip; the operator can heal or repair that provider.
      io.warn(fmt('heal_locationmap_update_failed', ms.provider_id));
    }
  }
}

/** What one rebuild attempt of a version came to. */
type RebuildOutcome =
  | { status: 'repaired' }
  | { status: 'skipped' }
  | {
      status: 'failed';
      /** The cause will repeat: for every version (target) or for every version using `deadSibling`. */
      stop: boolean;
      /** The sibling that did not answer, when that is what stopped this version. */
      deadSibling: Nullable<string>;
      message: string;
    };

/** Everything a rebuild of one version needs before it touches the media. */
interface RebuildContext {
  config: VaultConfig;
  manifest: VersionManifest;
  removedShard: ManifestShard;
  targetProviderConfig: ProviderConfig;
}

/**
 * Rebuilds a lost/corrupted shard using Reed-Solomon repair and uploads it
 * to a new target provider. Also updates location maps on all remaining shards.
 *
 * @param rootDir  - Vault root directory
 * @param version  - Version to repair
 * @param options  - removedProviderId, targetProviderId, io, and optional password
 * @throws BfsError when the version could not be rebuilt - too few parts on the
 *   other storages, a sibling that did not answer, the target refusing the part,
 *   or the part not reading back as written - or when the password is missing
 *   for an encrypted vault
 * @throws TamperDetectedError if the surviving shard headers disagree on identity fields
 * @throws UnsafePathError if the recorded vault_name is not a safe path segment
 */
export async function rebuildVersion(rootDir: string, version: number, options: RebuildVersionOptions): Promise<void> {
  const outcome = await _attemptRebuildVersion(rootDir, version, options);
  // Named by version here: a caller looping on its own (repair's migration)
  // records this text as it is, without the per-version line the rebuild
  // report adds around it.
  if (outcome.status === 'failed') throw new BfsError(fmt('heal_rebuild_version_failed', String(version), outcome.message));
}

/**
 * One rebuild attempt of one version, reported as an outcome instead of a
 * throw, so a caller looping over versions can tell a failure that will repeat
 * for every version (the target refusing, a sibling not answering) from one
 * that is this version's own (too few parts). Tampering still throws.
 */
async function _attemptRebuildVersion(rootDir: string, version: number, options: RebuildVersionOptions): Promise<RebuildOutcome> {
  const { removedProviderId, targetProviderId, io, password } = options;
  const ctx = await _loadRebuildContext(rootDir, version, removedProviderId, targetProviderId);
  if (ctx === null) return { status: 'skipped' };
  const { config, manifest, removedShard, targetProviderConfig } = ctx;
  if (manifest.encrypted && !password) throw new BfsError('Password required for RS repair in an encrypted vault.');
  const { data_shards: N, parity_shards: K } = manifest.scheme;

  const { shardSlots, shardDataMap, damagedSiblings, unreachable } = await downloadAvailableShards(config, manifest, removedProviderId, io);
  const available = shardSlots.filter((s) => s !== null).length;
  if (available < N) {
    const silent = unreachable[0];
    if (silent !== undefined) {
      return { status: 'failed', stop: true, deadSibling: silent.provider_id, message: fmt('heal_rebuild_sibling_unreachable', silent.provider_id, silent.message) };
    }
    return { status: 'failed', stop: false, deadSibling: null, message: fmt('heal_rebuild_step_parts', String(N), String(available)) };
  }

  // Cross-validate metadata across every available shard and derive the key -
  // needed to choose the V1 vs V2 repair path before rebuilding the payload.
  const meta = await extractShardMeta(shardDataMap, manifest, password);
  // Rebuild the removed shard's payload in the exact on-disk form its siblings
  // use (V2: striped RS + per-shard GCM; V1 legacy: flat RS). plaintextHash is
  // the value push records as shard_hash (SHA-256 of the plaintext payload).
  const { finalPayload, plaintextHash } = _repairShardPayload({
    shardSlots,
    formatVersion: meta.formatVersion,
    dataShards: N,
    parityShards: K,
    removedIndex: removedShard.shard_index,
    encrypted: manifest.encrypted,
    encKey: meta.encKey,
    version,
    rsStripeSize: meta.rsStripeSize,
  });
  const filename = `shard_${removedShard.shard_index}.bfs.${version}`;
  const newLocationMap = _swapLocationMap({ config, manifest, removedProviderId, targetProviderConfig, plaintextHash, io });
  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: meta.formatVersion,
    vault_id: meta.vaultId,
    vault_name: meta.vaultName,
    blob_size: meta.blobSize,
    blob_hash: meta.blobHash,
    data_shards: N,
    parity_shards: K,
    shard_index: removedShard.shard_index,
    version,
    encrypted: manifest.encrypted,
    kdf_salt: meta.kdf_salt,
    rs_stripe_size: meta.rsStripeSize,
    map_length: 0,
    location_map: newLocationMap,
  };
  // The identity read back is the one written into the header - the siblings'
  // vault_id - so the check is "did the target keep what it was given".
  const identity: ShardIdentity = { vault_id: meta.vaultId, shard_index: removedShard.shard_index, version };
  const failure = await _uploadAndConfirm({ targetProviderConfig, header, payload: finalPayload, filename, vaultName: config.vault_name, encKey: meta.encKey, io, identity });
  if (failure !== null) return { status: 'failed', stop: true, deadSibling: null, message: failure };

  // Update location maps on all existing (available) shards, then the manifest.
  await updateLocationMaps(rootDir, version, { newLocationMap, io, ...(password !== undefined ? { password } : {}) });
  await _commitRebuiltManifest({ rootDir, config, manifest, removedProviderId, targetProviderConfig, plaintextHash, available, damagedSiblings });
  return { status: 'repaired' };
}

/**
 * Loads what one version's rebuild needs and checks the invariants that make
 * the rebuild impossible rather than failed. Null when the version does not
 * use the removed provider - nothing to do.
 */
async function _loadRebuildContext(rootDir: string, version: number, removedProviderId: string, targetProviderId: string): Promise<Nullable<RebuildContext>> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');
  const manifest = await readManifest(rootDir, version);
  if (!manifest) throw new BfsError(`Manifest for version ${version} not found.`);
  const removedShard = manifest.shards.find((s) => s.provider_id === removedProviderId);
  if (!removedShard) return null;
  const targetProviderConfig = config.providers.find((p) => p.id === targetProviderId);
  if (!targetProviderConfig) throw new BfsError(`Target provider "${targetProviderId}" not found in config.`);
  // Invariant: 1 provider = 1 shard per version.
  if (manifest.shards.some((s) => s.provider_id === targetProviderId)) {
    throw new BfsError(`Target provider "${targetProviderId}" already holds a shard for version ${version}. Each provider can hold at most one shard per version.`);
  }
  return { config, manifest, removedShard, targetProviderConfig };
}

/** Inputs for {@link _swapLocationMap}. */
interface SwapLocationMapOptions {
  config: VaultConfig;
  manifest: VersionManifest;
  removedProviderId: string;
  targetProviderConfig: ProviderConfig;
  plaintextHash: string;
  io: ProviderIO;
}

/** The version's location map with the removed provider's entry pointing at the target. */
function _swapLocationMap(options: SwapLocationMapOptions): ShardLocation[] {
  const { config, manifest, removedProviderId, targetProviderConfig, plaintextHash, io } = options;
  return manifest.shards.map((ms) => {
    if (ms.provider_id === removedProviderId) {
      const split = splitLocationSecrets(targetProviderConfig.type, targetProviderConfig.config, io);
      return {
        shard_index: ms.shard_index,
        provider_id: targetProviderConfig.id,
        provider_type: targetProviderConfig.type,
        adapterPackage: targetProviderConfig.adapterPackage,
        connection_config: split.connection_config,
        required_inputs: split.required_inputs,
        remote_path: buildRemotePath(targetProviderConfig, config.vault_name, `shard_${ms.shard_index}.bfs.${manifest.version}`),
        shard_hash: plaintextHash,
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
}

/** Inputs for {@link _uploadAndConfirm}: the upload plus the identity the part must read back with. */
interface UploadAndConfirmOptions extends UploadRepairedShardOptions {
  identity: ShardIdentity;
}

/**
 * Uploads the rebuilt part and reads it back - by size and by identity - so a
 * server that accepted the write but kept a truncated or foreign file is a
 * failure, not a success. One more upload when the part does not read back as
 * written, since that can be a passing condition; then the version fails.
 *
 * @returns the failure to report (step, storage, the storage's own words), or null on success
 */
async function _uploadAndConfirm(options: UploadAndConfirmOptions): Promise<Nullable<string>> {
  const { targetProviderConfig, filename, vaultName, io, identity } = options;
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let size: number;
    try {
      size = await uploadRepairedShard(options);
    } catch (err: unknown) {
      // The per-version probe inside the upload may meet a pinned server
      // identity that does not match - a security event, never a write failure.
      if (err instanceof TamperDetectedError) throw err;
      return fmt('heal_rebuild_step_write', filename, targetProviderConfig.id, _messageOf(err));
    }
    const mismatch = await _readBackMismatch({ targetProviderConfig, vaultName, filename, expectedSize: size, identity, io });
    if (mismatch === null) return null;
    if (!mismatch.retry || attempt === attempts) return fmt('heal_rebuild_step_verify', filename, targetProviderConfig.id, mismatch.detail);
  }
  return null;
}

/** Inputs for {@link _readBackMismatch}. */
interface ReadBackOptions {
  targetProviderConfig: ProviderConfig;
  vaultName: string;
  filename: string;
  expectedSize: number;
  identity: ShardIdentity;
  io: ProviderIO;
}

/** Why the uploaded part does not read back as written, or null when it does. */
async function _readBackMismatch(options: ReadBackOptions): Promise<Nullable<ReadBackMismatch>> {
  const { targetProviderConfig, vaultName, filename, expectedSize, identity, io } = options;
  const target = providerRegistry.create(targetProviderConfig, io);
  target.setVaultName(vaultName);
  const ref: RemoteRef = { provider_id: targetProviderConfig.id, path: filename };
  try {
    const stored = await target.getSize(ref);
    if (stored !== expectedSize) return { detail: fmt('heal_rebuild_size_detail', String(stored), String(expectedSize)), retry: true };
    const verdict = await target.verifyShard(ref, identity);
    if (verdict.ok) return null;
    // A storage that cannot look inside its own files answers `unverifiable`
    // - a complete answer from the courier, not a mismatch (decisions.md:
    // "Adapter nie weryfikuje treści"). The size check above still stands;
    // the identity is taken on trust, and said so.
    if (verdict.reason === 'unverifiable') {
      io.warn(fmt('heal_rebuild_unverifiable', filename, targetProviderConfig.id, verdict.detail));
      return null;
    }
    // A refused login will not change on a second upload; a wrong, truncated
    // or missing file might be a passing condition, so those get one more try.
    return { detail: verdict.detail, retry: verdict.reason !== 'auth_failed' };
  } catch (err: unknown) {
    // A pinned identity that did not match is a security event, never a
    // read-back result - and never a reason to upload the part again.
    if (err instanceof TamperDetectedError) throw err;
    // The storage could not be asked at all - a transport fault, not a part
    // that read back wrong. Uploading the part again would not answer it.
    return { detail: _messageOf(err), retry: false };
  }
}

/** What the read-back found: the difference, and whether another upload is worth a try. */
interface ReadBackMismatch {
  detail: string;
  retry: boolean;
}

/** Inputs for {@link _commitRebuiltManifest}. */
interface CommitRebuiltManifestOptions {
  rootDir: string;
  config: VaultConfig;
  manifest: VersionManifest;
  removedProviderId: string;
  targetProviderConfig: ProviderConfig;
  plaintextHash: string;
  available: number;
  damagedSiblings: number;
}

/** Records the moved part in the manifest with the verdict the repair leaves behind. */
async function _commitRebuiltManifest(options: CommitRebuiltManifestOptions): Promise<void> {
  const { rootDir, config, manifest, removedProviderId, targetProviderConfig, plaintextHash, available, damagedSiblings } = options;
  const updatedShards: ManifestShard[] = manifest.shards.map((ms) => {
    if (ms.provider_id !== removedProviderId) return ms;
    return {
      shard_index: ms.shard_index,
      provider_id: targetProviderConfig.id,
      provider_type: targetProviderConfig.type,
      remote_path: buildRemotePath(targetProviderConfig, config.vault_name, `shard_${ms.shard_index}.bfs.${manifest.version}`),
      shard_hash: plaintextHash,
    };
  });
  const verdict = verdictAfterRepair(available, manifest, damagedSiblings);
  await writeManifest(rootDir, applyHealthChange({ ...manifest, shards: updatedShards }, verdict.health, verdict.deepRot));
}

/**
 * Reconstructs a provider's LOST shard for one version with Reed-Solomon and
 * re-uploads it to the SAME provider (id unchanged) - the `bfs repair --rebuild`
 * counterpart to {@link rebuildVersion}'s move-to-a-new-provider model. Unlike
 * rebuildVersion there is no provider swap and no "target already holds a shard"
 * invariant, because the provider keeps its own index. Optionally targets a new
 * connection config (rebuild onto a fresh medium). Handles V1 flat and V2
 * striped payloads via {@link _repairShardPayload}. As defense-in-depth the
 * rebuilt payload's SHA-256 must match the recorded `shard_hash`.
 *
 * @param rootDir  - Vault root directory
 * @param version  - Version whose shard to rebuild
 * @param options  - providerId, io, optional password and newConnectionConfig
 * @throws BfsError when config/manifest missing, too few shards, or password missing
 * @throws ShardCorruptedError when the rebuilt payload's hash mismatches the manifest
 */
export async function rebuildShardInPlace(rootDir: string, version: number, options: RebuildShardInPlaceOptions): Promise<void> {
  const { providerId, io, password, newConnectionConfig } = options;
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');
  const manifest = await readManifest(rootDir, version);
  if (!manifest) throw new BfsError(`Manifest for version ${version} not found.`);
  if (manifest.encrypted && !password) throw new BfsError('Password required for RS repair in an encrypted vault.');

  const shard = manifest.shards.find((s) => s.provider_id === providerId);
  if (!shard) return; // this version doesn't use this provider - nothing to rebuild
  const existing = config.providers.find((p) => p.id === providerId);
  if (!existing) throw new BfsError(`Provider "${providerId}" not found in config.`);
  const targetProviderConfig: ProviderConfig = newConnectionConfig ? { ...existing, config: newConnectionConfig } : existing;

  const { finalPayload, plaintextHash, meta, soundSiblings, damagedSiblings } = await reconstructLostShard(config, manifest, shard, password, io);

  const filename = `shard_${shard.shard_index}.bfs.${version}`;
  const newRemotePath = buildRemotePath(targetProviderConfig, config.vault_name, filename);
  const newLocationMap = buildRebuiltLocationMap(config, manifest, providerId, targetProviderConfig, plaintextHash, newRemotePath, io);
  const header = buildRebuiltHeader(meta, shard, manifest, newLocationMap);
  await uploadRepairedShard({ targetProviderConfig, header, payload: finalPayload, filename, vaultName: config.vault_name, encKey: meta.encKey, io });
  await updateLocationMaps(rootDir, version, { newLocationMap, io, ...(password !== undefined ? { password } : {}) });

  const updatedShards = manifest.shards.map((ms) => (ms.provider_id === providerId ? { ...ms, remote_path: newRemotePath, shard_hash: plaintextHash } : ms));
  const verdict = verdictAfterRepair(soundSiblings, manifest, damagedSiblings);
  await writeManifest(rootDir, applyHealthChange({ ...manifest, shards: updatedShards }, verdict.health, verdict.deepRot));
}

/**
 * Downloads the surviving shards, Reed-Solomon-reconstructs the lost shard's
 * payload, and verifies it against the manifest hash. Also reports what the
 * siblings looked like, which is what decides the repaired version's health.
 *
 * @throws BfsError when fewer than N shards remain
 * @throws ShardCorruptedError when the rebuilt payload's hash mismatches the manifest
 */
async function reconstructLostShard(config: VaultConfig, manifest: VersionManifest, shard: ManifestShard, password: string | undefined, io: ProviderIO) {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const { shardSlots, shardDataMap, damagedSiblings } = await downloadAvailableShards(config, manifest, shard.provider_id, io);
  const available = shardSlots.filter((s) => s !== null).length;
  if (available < N) {
    throw new BfsError(`Not enough shards to rebuild version ${manifest.version}: need ${N}, got ${available}.`);
  }
  const meta = await extractShardMeta(shardDataMap, manifest, password);
  const { finalPayload, plaintextHash } = _repairShardPayload({
    shardSlots,
    formatVersion: meta.formatVersion,
    dataShards: N,
    parityShards: K,
    removedIndex: shard.shard_index,
    encrypted: manifest.encrypted,
    encKey: meta.encKey,
    version: manifest.version,
    rsStripeSize: meta.rsStripeSize,
  });
  if (shard.shard_hash && shard.shard_hash !== plaintextHash) {
    throw new ShardCorruptedError(`RS rebuild produced a mismatched payload for version ${manifest.version} shard ${shard.shard_index}.`);
  }
  return { finalPayload, plaintextHash, meta, soundSiblings: available, damagedSiblings };
}

/** Assembles the rebuilt shard's header from the reconstructed metadata and new location map. */
function buildRebuiltHeader(meta: Awaited<ReturnType<typeof extractShardMeta>>, shard: ManifestShard, manifest: VersionManifest, newLocationMap: ShardLocation[]): ShardHeader {
  return {
    magic: 'BFSS',
    format_version: meta.formatVersion,
    vault_id: meta.vaultId,
    vault_name: meta.vaultName,
    blob_size: meta.blobSize,
    blob_hash: meta.blobHash,
    data_shards: manifest.scheme.data_shards,
    parity_shards: manifest.scheme.parity_shards,
    shard_index: shard.shard_index,
    version: manifest.version,
    encrypted: manifest.encrypted,
    kdf_salt: meta.kdf_salt,
    rs_stripe_size: meta.rsStripeSize,
    map_length: 0,
    location_map: newLocationMap,
  };
}

/**
 * Builds the location map for an in-place rebuild: the rebuilt provider keeps
 * its id but gets the (possibly new) remote path and the freshly-computed
 * payload hash; every other entry is preserved with its provider's config.
 */
function buildRebuiltLocationMap(config: VaultConfig, manifest: VersionManifest, providerId: string, targetProviderConfig: ProviderConfig, plaintextHash: string, newRemotePath: string, io: ProviderIO): ShardLocation[] {
  return manifest.shards.map((ms) => {
    if (ms.provider_id === providerId) {
      const split = splitLocationSecrets(targetProviderConfig.type, targetProviderConfig.config, io);
      return {
        shard_index: ms.shard_index,
        provider_id: providerId,
        provider_type: targetProviderConfig.type,
        adapterPackage: targetProviderConfig.adapterPackage,
        connection_config: split.connection_config,
        required_inputs: split.required_inputs,
        remote_path: newRemotePath,
        shard_hash: plaintextHash,
      };
    }
    const src = config.providers.find((p) => p.id === ms.provider_id);
    const split = splitLocationSecrets(ms.provider_type, src?.config ?? {}, io);
    return {
      shard_index: ms.shard_index,
      provider_id: ms.provider_id,
      provider_type: ms.provider_type,
      adapterPackage: src?.adapterPackage ?? null,
      connection_config: split.connection_config,
      required_inputs: split.required_inputs,
      remote_path: ms.remote_path,
      shard_hash: ms.shard_hash,
    };
  });
}

/**
 * Rebuilds all specified versions after a provider was lost.
 * Uploads repaired shards to targetProvider and updates location maps.
 *
 * @param rootDir  - Vault root directory
 * @param options  - removedProviderId, targetProviderId, scope, io, and optional password
 * @returns HealReport - what moved, what failed and why, what was never attempted
 * @throws BfsError when the target is not usable at all (probed once, before the loop)
 * @throws TamperDetectedError when a version's surviving shard headers disagree -
 *         a security event, never absorbed into the degraded report
 */
export async function rebuildAllVersions(rootDir: string, options: RebuildAllVersionsOptions): Promise<HealReport> {
  const { removedProviderId, targetProviderId, scope, io, password } = options;
  const manifests = await listManifests(rootDir);

  const affectedManifests = manifests.filter((m) => m.shards.some((s) => s.provider_id === removedProviderId));

  let targetVersions: number[];
  if (scope === 'all') {
    targetVersions = affectedManifests.map((m) => m.version);
  } else if (scope === 'latest') {
    // "Latest" means the newest version this copy can act on, not the newest
    // number the storage holds: after a recovery that met a version it could not
    // open, `state.latest_version` names a version with no manifest, and matching
    // on it would rebuild nothing while the provider is removed from the config
    // anyway - leaving the newest version that DOES have a manifest short a part.
    const newest = Math.max(0, ...manifests.map((m) => m.version));
    targetVersions = affectedManifests.filter((m) => m.version === newest).map((m) => m.version);
  } else {
    targetVersions = scope;
  }

  const report: HealReport = { repaired: 0, degraded: 0, versions_repaired: [], versions_degraded: [], versions_not_attempted: [], failures: [] };

  if (targetVersions.length === 0) return report;

  // The target is probed once, before any sibling part is fetched: a target
  // that cannot be written would otherwise cost one full transfer per version
  // before failing each of them the same way.
  await _probeRebuildTarget(rootDir, targetProviderId, targetVersions, io);

  // Siblings that did not answer. A version that needs one of them is not
  // attempted - the storage will not answer for it either - but versions
  // recorded on other storages still get their turn.
  const deadSiblings = new Set<string>();
  const usesDeadSibling = (version: number): boolean => manifests.some((m) => m.version === version && m.shards.some((s) => deadSiblings.has(s.provider_id)));

  for (let i = 0; i < targetVersions.length; i++) {
    const version = targetVersions[i];
    if (usesDeadSibling(version)) {
      await _stampDegraded(rootDir, version);
      report.versions_not_attempted.push(version);
      continue;
    }
    // Tampering throws out of the attempt: a forged sibling header is a
    // security event, never absorbed into a degraded report.
    const outcome = await _attemptRebuildVersion(rootDir, version, { removedProviderId, targetProviderId, io, ...(password !== undefined ? { password } : {}) });
    if (outcome.status === 'skipped') continue;
    if (outcome.status === 'repaired') {
      report.repaired++;
      report.versions_repaired.push(version);
      continue;
    }
    await _stampDegraded(rootDir, version);
    report.degraded++;
    report.versions_degraded.push(version);
    report.failures.push({ version, message: outcome.message });
    if (!outcome.stop) continue;
    if (outcome.deadSibling !== null) {
      deadSiblings.add(outcome.deadSibling);
      continue;
    }
    // The target itself failed - that will repeat for every remaining version.
    // Stop here and stamp what was not attempted: its storage was declared
    // lost all the same.
    for (const rest of targetVersions.slice(i + 1)) {
      await _stampDegraded(rootDir, rest);
      report.versions_not_attempted.push(rest);
    }
    break;
  }

  return report;
}

/**
 * Probes the rebuild target once, before the loop. A target that cannot be
 * reached, written or provisioned fails the whole run right here - with every
 * version in scope stamped degraded, since the operator has declared the old
 * storage lost and nothing replaced it.
 *
 * @throws BfsError naming the target and the provider's own reason
 */
async function _probeRebuildTarget(rootDir: string, targetProviderId: string, versions: number[], io: ProviderIO): Promise<void> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');
  const targetProviderConfig = config.providers.find((p) => p.id === targetProviderId);
  if (!targetProviderConfig) throw new BfsError(`Target provider "${targetProviderId}" not found in config.`);
  try {
    const target = providerRegistry.create(targetProviderConfig, io);
    target.setVaultName(config.vault_name);
    await target.probeConnection();
  } catch (err: unknown) {
    // A pinned server identity that did not match is a security event, not an
    // unusable target - it must reach the operator as what it is.
    if (err instanceof TamperDetectedError) throw err;
    for (const version of versions) await _stampDegraded(rootDir, version);
    throw new BfsError(`${fmt('heal_rebuild_target_unusable', targetProviderId, _messageOf(err))} ${t('heal_rebuild_retry_hint')}`);
  }
}

/** Marks a healthy version degraded; damaged stays damaged, degraded stays as it is. */
async function _stampDegraded(rootDir: string, version: number): Promise<void> {
  const manifest = await readManifest(rootDir, version);
  if (manifest !== null && manifest.health === VersionHealth.Healthy) {
    await writeManifest(rootDir, applyHealthChange(manifest, VersionHealth.Degraded));
  }
}

/**
 * Handles provider relocation: the shard still exists but the provider has a new address.
 * Verifies provider accessibility, confirms shards exist, then updates location maps
 * in all existing shards and in config.json.
 *
 * @param rootDir    - Vault root directory
 * @param providerId - Existing provider id to relocate
 * @param options    - newConnectionConfig, io, optional password, newType and
 *                     versions (scope of the header rewrite; the config change is always global)
 * @throws BfsError if provider is unreachable at new address or shards are missing
 */
export async function relocateProvider(rootDir: string, providerId: string, options: RelocateProviderOptions): Promise<void> {
  const { newConnectionConfig, io, password, newType, versions } = options;
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const existingProvider = config.providers.find((p) => p.id === providerId);
  if (!existingProvider) throw new BfsError(`Provider "${providerId}" not found in config.`);

  const resolvedType = newType ?? existingProvider.type;
  // When the type changes the adapter may also change - refresh the package
  // metadata from the registry so the probed provider advertises the correct
  // provenance. When the type is unchanged, keep the persisted adapterPackage.
  const updatedMeta = providerRegistry.getMeta(resolvedType);
  const updatedAdapterPackage = resolvedType === existingProvider.type ? existingProvider.adapterPackage : updatedMeta ? `${updatedMeta.packageName}@${updatedMeta.packageVersion}` : null;

  // Create a temporary config with the new connection parameters
  const updatedProviderConfig = { ...existingProvider, type: resolvedType, adapterPackage: updatedAdapterPackage, config: newConnectionConfig };
  const tempProvider = providerRegistry.create(updatedProviderConfig, io);

  // Verify accessibility. healthCheck() only yields a boolean, which would mask
  // WHY the address is unusable behind a generic "not accessible" - sending the
  // operator to debug connectivity when the real cause is often a rejected host
  // key. Drive authenticate() and forward its classified error so the message
  // tells them whether they need --known-host / --accept-new-host-key.
  try {
    await tempProvider.authenticate();
  } catch (err) {
    throw new BfsError(fmt('heal_relocate_unreachable', providerId, err instanceof Error ? err.message : String(err)));
  }
  tempProvider.setVaultName(config.vault_name);

  // Verify shards exist on the new address for all relevant versions
  const manifests = await listManifests(rootDir);
  const affectedManifests = manifests.filter((m) => m.shards.some((s) => s.provider_id === providerId) && (versions === undefined || versions.includes(m.version)));

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
          remote_path: buildRemotePath({ id: providerId, type: resolvedType, adapterPackage: resolvedAdapterPackage, config: newConnectionConfig }, config.vault_name, filename),
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
