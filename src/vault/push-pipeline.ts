/**
 * Push pipeline - full implementation of `bfs push`.
 *
 * This module contains the push() function and all its private helpers.
 * vault-manager.ts re-exports push and buildRemotePath as the public entry points.
 *
 * Dependency rule: this file MUST NOT import from ./vault-manager.js.
 */

import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { estimateBlobSize, packBlob, packBlobToFile, packBlobToFileZipped, scanDirClassified } from '../core/blob-pack.js';
import { parseBlobFileTable, parseBlobFileTableFromFile } from '../core/blob-unpack.js';
import { trackFile, untrackFile } from '../core/cleanup.js';
import { deriveKey, deriveShardNonce, encryptStream, exceedsGcmPlaintextLimit, GCM_MAX_PLAINTEXT_BYTES, generateSalt } from '../core/crypto.js';
import type { SkippedFile } from '../core/errors.js';
import { BfsError, ProviderError, PushCacheCorruptedError, PushCacheNoLockError, PushCacheUnavailableError, PushDriftError, PushExcludedError, PushSkippedError } from '../core/errors.js';
import { hashBuffer, hashStream, SHA256_BYTES } from '../core/hash.js';
import { appendToBfsignore, createIgnoreFilter } from '../core/ignore.js';
import { calcShardPayloadSize, rsEncodeStriped } from '../core/reed-solomon.js';
import { buildShardStream, serializeShardHeader, uuidToBuffer, V2_MAX_STRIPE_SIZE } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { CatalogDrift, ExcludedEntry, ManifestShard, ProviderConfig, ProviderIO, PushOptions, PushResult, ShardHeader, ShardLocation, StorageProvider, VaultConfig, VaultState, VersionManifest } from '../types/index.js';
import { PushMode, VersionHealth } from '../types/index.js';
import { catalogHasDrift, diffCatalog, snapshotCatalog } from './catalog-verify.js';
import { assertSchemeValid, readConfig } from './config.js';
import { splitLocationSecrets } from './location-map.js';
import type { PushLock, PushLockFailedReason } from './lockfile.js';
import { acquireCachePushLock, acquirePushLock, pushLockPath, readLock, removeLock, writeLockAtomic } from './lockfile.js';
import { writeManifest } from './manifest.js';
import { confirmRecoveredLocations } from './recovered-locations.js';
import { readState, writeState } from './state.js';
import { assertNoForeignVault } from './vault-collision.js';

// --- Push-only V2 constants --------------------------------------------------
// V2_STRIPE_SIZE is intentionally kept in vault-manager.ts because pull needs it too.

/** Minimum stripe size floor (16 MiB). */
const V2_MIN_STRIPE_SIZE = 16 * 1024 * 1024;
/** packBlob() uses Buffer.concat - cap to avoid excessive RAM from double-buffering. */
const V2_MAX_BLOB_IN_RAM = 4 * 1024 * 1024 * 1024;

/** Magic bytes and fixed header size of the BFS blob format. */
const BLOB_MAGIC = Buffer.from([0x42, 0x46, 0x53, 0x00]);
const BLOB_HEADER_SIZE = 70;

// --- RAM budget utilities ----------------------------------------------------

/** Resolves the RAM budget in bytes from user config or system auto-detect. */
function resolveRamBudget(maxRamMb: Nullable<number> | undefined): number {
  return maxRamMb != null ? maxRamMb * 1024 * 1024 : Math.floor(os.totalmem() * 0.25);
}

interface StripeSizeParams {
  maxRamMb: Nullable<number> | undefined;
  N: number;
  K: number;
  blobSize: number;
}

/**
 * Computes the stripe size that fits a RAM budget, dividing it by (N + K).
 * Encoding peaks above that - see computeRamThreshold for why the budget is
 * optimistic (`proposals/followups.plan.md` #3).
 */
function computeStripeSize(params: StripeSizeParams): number {
  const ramBytes = resolveRamBudget(params.maxRamMb);
  const fromRam = Math.floor(ramBytes / (params.N + params.K));
  const fromBlob = calcShardPayloadSize(params.blobSize, params.N);
  return Math.min(Math.max(V2_MIN_STRIPE_SIZE, Math.min(fromRam, V2_MAX_STRIPE_SIZE)), fromBlob);
}

/**
 * Per-shard plaintext payload size (bytes) for striped encoding - identical for
 * data and parity shards, and equal to what passes through one encryptStream
 * (a single AES-GCM key+nonce). Used both to size the upload and to guard the
 * GCM plaintext limit.
 */
function rawShardPayloadSize(blobSize: number, N: number, stripeSize: number): number {
  const numStripes = Math.ceil(blobSize / (N * stripeSize));
  return numStripes * stripeSize;
}

/**
 * Computes the RAM threshold for keeping the blob in memory vs writing to disk.
 * Reserves (N+K) x V2_MAX_STRIPE_SIZE for the RS encoder. That reservation is
 * smaller than what encoding actually peaks at - rsEncodeStriped also holds an
 * N-wide input block, and the WASM encoder copies the working block into its own
 * linear memory - so the budget is optimistic by design until that is reworked
 * (`proposals/followups.plan.md` #3).
 */
function computeRamThreshold(maxRamMb: Nullable<number> | undefined, N: number, K: number): number {
  const ramBytes = resolveRamBudget(maxRamMb);
  const rsOverhead = (N + K) * V2_MAX_STRIPE_SIZE;
  return Math.min(Math.max(0, ramBytes - rsOverhead), V2_MAX_BLOB_IN_RAM);
}

// --- V2 streaming helpers (push-only) ---------------------------------------

/**
 * Async generator that yields fixed-size stripe chunks for one data shard.
 * Each yield covers one stripe - the shard's slice of each RS stripe row.
 *
 * @param source     - Blob as Buffer (RAM) or file path (disk)
 * @param blobSize   - Total blob byte count
 * @param shardIndex - Which data shard (0..N-1)
 * @param N          - Number of data shards
 * @param stripeSize - Bytes per shard per stripe
 */
async function* _stripedShardChunks(source: Buffer | string, blobSize: number, shardIndex: number, N: number, stripeSize: number): AsyncGenerator<Buffer> {
  const stripeInputSize = N * stripeSize;
  const numStripes = Math.ceil(blobSize / stripeInputSize);

  if (Buffer.isBuffer(source)) {
    for (let s = 0; s < numStripes; s++) {
      const shardStart = s * stripeInputSize + shardIndex * stripeSize;
      const chunk = Buffer.alloc(stripeSize);
      if (shardStart < source.length) {
        const readEnd = Math.min(shardStart + stripeSize, source.length);
        source.subarray(shardStart, readEnd).copy(chunk);
      }
      yield chunk;
    }
  } else {
    const fh = await fs.open(source, 'r');
    try {
      for (let s = 0; s < numStripes; s++) {
        const shardStart = s * stripeInputSize + shardIndex * stripeSize;
        const chunk = Buffer.alloc(stripeSize);
        if (shardStart < blobSize) {
          await fh.read(chunk, 0, Math.min(stripeSize, blobSize - shardStart), shardStart);
        }
        yield chunk;
      }
    } finally {
      await fh.close();
    }
  }
}

/**
 * Returns a Readable stream of striped shard data for shard `shardIndex`.
 * See `_stripedShardChunks` for the data layout.
 */
function _stripedShardStream(source: Buffer | string, blobSize: number, shardIndex: number, N: number, stripeSize: number): Readable {
  return Readable.from(_stripedShardChunks(source, blobSize, shardIndex, N, stripeSize));
}

// --- Shared utilities (local copy - push must not import vault-manager) --

/**
 * Validates that a configured directory (or its parent) exists before use.
 * A local copy - the no-import-from-vault-manager rule forbids sharing it
 * through that module.
 */
async function _validateConfigDir(dir: string, configFlag: string): Promise<void> {
  const target = path.dirname(dir) === dir ? dir : path.dirname(dir);
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      throw new BfsError(`${t('path_not_dir')}: ${dir}\n  ${fmt('config_dir_hint', configFlag, configFlag)}`);
    }
  } catch (e: unknown) {
    if (e instanceof BfsError) throw e;
    throw new BfsError(`${fmt('dir_not_exist', dir)}\n  ${fmt('config_dir_hint', configFlag, configFlag)}`);
  }
}

/**
 * Hashes the plain blob content (all bytes except the trailing 32-byte SHA-256 checksum).
 *
 * @param source - Packed blob as Buffer (RAM) or file path (disk)
 * @param size   - Total blob byte count (including the 32-byte checksum)
 * @returns SHA-256 hex string of blob[0..size-32]
 */
async function _hashBlobWithoutChecksum(source: Buffer | string, size: number): Promise<string> {
  if (Buffer.isBuffer(source)) {
    return hashBuffer(source.subarray(0, size - SHA256_BYTES));
  }
  // createReadStream `end` is inclusive (0-indexed), so the last hashed byte
  // is size - SHA256_BYTES - 1 - exactly the bytes before the trailing checksum.
  return hashStream(createReadStream(source, { start: 0, end: size - SHA256_BYTES - 1 }));
}

/**
 * Verifies a cached blob against the SHA-256 sealed in its own last 32 bytes.
 *
 * Every other path packs the blob and uploads it within one run, so its bytes
 * cannot change in between. A resume is the exception: the file has been sitting
 * on disk since an earlier run and may have rotted there. Nothing downstream
 * would notice - the parts are sealed over whatever they are handed, so a
 * corrupt blob yields a version that verifies, deep-verifies, and only fails at
 * the first restore, blaming the storage for damage that happened locally.
 *
 * The verified digest is returned rather than discarded: it is by definition the
 * same value `blob_hash` carries, so the caller reuses it instead of hashing the
 * file a second time. That matters here more than anywhere - a resume exists for
 * backups too large to push in one go.
 *
 * A file that never finished becoming a blob is a different case and keeps its
 * older behaviour: an interrupted pack writes the header LAST, so a Ctrl+C
 * mid-pack leaves a zeroed prefix, and a plain BfsError sends that down the
 * "no usable backup data" path, which packs the directory again by itself.
 * Refusing there would turn a self-healing situation into two manual commands.
 *
 * @param cachePath - Path of the cached pending blob
 * @param size      - Total blob byte count, including the trailing checksum
 * @param io        - Provider IO used to announce the read before it starts
 * @returns SHA-256 hex of the blob content, equal to the seal it was checked against
 * @throws PushCacheCorruptedError when a genuine blob's content does not match its seal
 * @throws BfsError when the file never became a blob (too short, or no magic)
 */
async function _verifyCachedBlobSeal(cachePath: string, size: number, io: ProviderIO): Promise<string> {
  if (size <= BLOB_HEADER_SIZE + SHA256_BYTES) throw new BfsError('Cached backup data is too short to be a blob');
  const seal = Buffer.alloc(SHA256_BYTES);
  const magic = Buffer.alloc(BLOB_MAGIC.length);
  const fh = await fs.open(cachePath, 'r');
  try {
    await fh.read(magic, 0, magic.length, 0);
    if (magic.compare(BLOB_MAGIC) !== 0) throw new BfsError('Cached backup data does not start with a blob header');
    const { bytesRead } = await fh.read(seal, 0, SHA256_BYTES, size - SHA256_BYTES);
    if (bytesRead < SHA256_BYTES) throw new BfsError('Cached backup data is truncated below its checksum');
  } finally {
    await fh.close();
  }
  // Everything above is a pair of bounded reads; hashing walks the whole file, which is
  // slowest exactly where a resume matters, so it announces itself first. The
  // wording stops at "checking" - a cache that fails is refused, and a line
  // claiming it is already in use would have to be taken back. Announcing only
  // past the shape checks keeps it off the unfinished-pack path, which re-packs
  // and would otherwise read as "checking... no cached backup data found".
  io.info(t('vault_checking_cached_blob'));
  const actual = await _hashBlobWithoutChecksum(cachePath, size);
  if (actual !== seal.toString('hex')) throw new PushCacheCorruptedError(cachePath);
  return actual;
}

/**
 * Reads how many files a cached blob holds and their uncompressed total from its
 * file table. A V2 blob carries one entry per user file in both the plain and the
 * compressed layout, so compression makes no difference to what can be read here.
 *
 * @param cachePath - Path of the cached pending blob, already checked against its seal
 * @returns File count and total uncompressed size, as the manifest records them
 * @throws PushCacheCorruptedError when the file table cannot be parsed
 */
async function _readCachedBlobFigures(cachePath: string): Promise<{ file_count: number; total_size: number }> {
  try {
    const entries = await parseBlobFileTableFromFile(cachePath);
    return { file_count: entries.length, total_size: entries.reduce((s, e) => s + Number(e.size), 0) };
  } catch (err) {
    // The seal already proved these are the bytes the interrupted run wrote, so
    // a file table that will not parse means the blob contradicts itself - and a
    // restore reads that same table, so this cache could never be unpacked.
    // Saying so beats falling through to a silent re-pack that discards it.
    if (err instanceof BfsError) throw new PushCacheCorruptedError(cachePath);
    throw err;
  }
}

// --- buildRemotePath ---------------------------------------------------------

/**
 * Builds the remote_path for a shard on a given provider.
 * Uses forward slashes: {config.path}/{vault_name}/{filename}.
 */
export function buildRemotePath(providerConfig: ProviderConfig, vaultName: string, filename: string): string {
  const base = String(providerConfig.config.path ?? '');
  return [base, vaultName, filename].join('/').replace(/\\/g, '/');
}

// --- openProviders -----------------------------------------------------------

/** Creates, authenticates, and sets vault name on all providers in config. */
async function openProviders(config: VaultConfig, io: ProviderIO): Promise<StorageProvider[]> {
  const providers: StorageProvider[] = [];
  for (const pc of config.providers) {
    const p = providerRegistry.create(pc, io);
    await p.authenticate();
    p.setVaultName(config.vault_name);
    providers.push(p);
  }
  return providers;
}

/**
 * Pre-upload collision guard: refuse to push when any provider's location
 * already holds a DIFFERENT backup (a shard whose header carries a foreign
 * vault_id). Runs before packing so a colliding push wastes no pack/encode work,
 * and covers the --cache path too. list()/downloadHeader() self-connect on the
 * built-in providers, so no prior authenticate() is needed here.
 */
async function _assertNoForeignVaults(config: VaultConfig, io: ProviderIO): Promise<void> {
  for (const pc of config.providers) {
    const p = providerRegistry.create(pc, io);
    await assertNoForeignVault(p, config.vault_name, config.vault_id, io);
  }
}

// --- Push lock ---------------------------------------------------------------

/**
 * Acquires .bfs/push.lock for the current push attempt. The lock is the
 * concurrency mutex: a fresh push takes it atomically (acquirePushLock,
 * O_EXCL), so two overlapping pushes cannot both proceed. For fromCache=true it
 * validates the resume state - a lock recording no cache throws
 * PushCacheUnavailableError, a missing lock or missing cached blob throws
 * PushCacheNoLockError - refuses only under a live concurrent operation
 * (acquireCachePushLock), then resets uploaded/failed for a fresh retry.
 */
async function _initPushLock(rootDir: string, fromCache: boolean, cachePath: string, targetVersion: number, config: VaultConfig): Promise<PushLock> {
  const lockPath = pushLockPath(rootDir);

  if (fromCache) {
    const existing = await readLock<PushLock>(lockPath);
    if (existing === null) {
      const missing: string[] = ['.bfs/push.lock'];
      const blobStat = await fs.stat(cachePath).catch(() => null);
      if (blobStat === null) missing.push(cachePath);
      throw new PushCacheNoLockError(missing);
    }
    if (existing.blob_pending_path === null) {
      throw new PushCacheUnavailableError();
    }
    const blobStat = await fs.stat(existing.blob_pending_path).catch(() => null);
    if (blobStat === null) {
      throw new PushCacheNoLockError([existing.blob_pending_path]);
    }
  }

  const lock: PushLock = {
    format_version: 1,
    operation: 'push',
    version: targetVersion,
    pid: process.pid,
    command: 'bfs push',
    started_at: new Date().toISOString(),
    scheme: { ...config.scheme },
    uploaded: [],
    failed: [],
    blob_pending_path: cachePath,
  };
  if (fromCache) {
    await acquireCachePushLock(rootDir, lock);
  } else {
    await acquirePushLock(rootDir, lock);
  }
  return lock;
}

// --- Error classification + health ------------------------------------------

/**
 * Classifies an upload failure into a PushLockFailedReason + human detail.
 * @internal
 */
export function _classifyUploadError(e: unknown): { reason: PushLockFailedReason; detail: string } {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof ProviderError && /auth|530|login|password/i.test(detail)) {
    return { reason: 'auth_failed', detail };
  }
  const code = (e as Nullable<NodeJS.ErrnoException>)?.code;
  switch (code) {
    case 'ENOENT':
      return { reason: 'not_found', detail };
    case 'ECONNREFUSED':
    case 'ETIMEDOUT':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return { reason: 'network_error', detail };
    case 'EDQUOT':
    case 'ENOSPC':
      return { reason: 'quota_exceeded', detail };
    default:
      return { reason: 'unknown', detail };
  }
}

/**
 * Maps the uploaded shard count to a VersionHealth value.
 * Throws BfsError when zero - caller must NOT write a manifest in that case.
 */
function _computeHealth(uploaded: number, N: number, K: number): VersionHealth {
  if (uploaded === N + K) return VersionHealth.Healthy;
  if (uploaded >= N) return VersionHealth.Degraded;
  if (uploaded >= 1) return VersionHealth.Damaged;
  throw new BfsError(fmt('push_damaged_zero', String(N), String(N + K)));
}

// --- Push helpers -------------------------------------------------------------

interface LoadOrPackBlobOptions {
  rootDir: string;
  cachePath: string;
  cacheDir: string;
  vaultIdBuf: Buffer;
  fromCache: boolean | undefined;
  shouldCompress: boolean;
  maxRamMb: Nullable<number> | undefined;
  N: number;
  K: number;
  io: ProviderIO;
}

interface BlobPackResult {
  blobSource: Buffer | string;
  blobSize: number;
  file_count: number;
  total_size: number;
  skipped: SkippedFile[];
  /**
   * Content hash, when this path already had to compute it. A resume verifies
   * the cache against its own seal, and that digest is exactly `blob_hash`, so
   * carrying it forward saves a second full pass over a file that is large by
   * definition. Null on the packing paths, which have nothing to reuse.
   */
  blob_hash: Nullable<string>;
}

interface PackFreshBlobOptions {
  rootDir: string;
  cachePath: string;
  cacheDir: string;
  vaultIdBuf: Buffer;
  shouldCompress: boolean;
  maxRamMb: Nullable<number> | undefined;
  N: number;
  K: number;
  io: ProviderIO;
}

/**
 * Freshly packs the source directory to a blob.
 * Routes to one of two paths:
 *  - compress: packBlobToFileZipped (always disk, one-pass ZIP)
 *  - no compress: packBlob (RAM) or packBlobToFile (disk, RAM threshold exceeded)
 *
 * @param options - all pack parameters; does NOT handle cache path
 * @returns BlobPackResult with the packed blob source, size, and file metadata
 */
async function _packFreshBlob(options: PackFreshBlobOptions): Promise<BlobPackResult> {
  const { rootDir, cachePath, cacheDir, vaultIdBuf, shouldCompress, maxRamMb, N, K, io } = options;
  const filter = createIgnoreFilter(rootDir);
  await fs.unlink(cachePath).catch(() => {});
  io.info(t('init_scanning'));
  if (shouldCompress) {
    io.info(t('vault_compressing'));
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    trackFile(cachePath);
    const r = await packBlobToFileZipped(rootDir, cachePath, filter, vaultIdBuf);
    return { blobSource: cachePath, blobSize: r.blobSize, file_count: r.fileCount, total_size: r.totalSize, skipped: r.skipped, blob_hash: null };
  }
  const estimated = await estimateBlobSize(rootDir, filter);
  const ramThreshold = computeRamThreshold(maxRamMb, N, K);
  let useRamPath = estimated < ramThreshold;
  if (useRamPath) {
    try {
      Buffer.alloc(estimated);
    } catch {
      useRamPath = false;
    }
  }
  if (useRamPath) {
    const r = await packBlob(rootDir, filter, vaultIdBuf);
    const entries = parseBlobFileTable(r.blob);
    return { blobSource: r.blob, blobSize: r.blob.length, file_count: entries.length, total_size: entries.reduce((s, e) => s + Number(e.size), 0), skipped: r.skipped, blob_hash: null };
  }
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  trackFile(cachePath);
  const r = await packBlobToFile(rootDir, cachePath, filter, vaultIdBuf);
  return { blobSource: cachePath, blobSize: r.blobSize, file_count: r.fileCount, total_size: r.totalSize, skipped: r.skipped, blob_hash: null };
}

/**
 * Loads the blob from cache or freshly packs the source directory.
 * Routes to one of three internal paths:
 *  - cache hit: reads cachePath blob from disk
 *  - compress: packBlobToFileZipped (always disk path)
 *  - no compress: packBlob (RAM) or packBlobToFile (disk, when blob exceeds RAM threshold)
 *
 * @param options - rootDir, cachePath, cacheDir, vaultIdBuf, fromCache, shouldCompress, maxRamMb, N, K, io
 * @returns BlobPackResult with blobSource, blobSize, file_count, total_size, skipped
 */
async function _loadOrPackBlob(options: LoadOrPackBlobOptions): Promise<BlobPackResult> {
  const { rootDir, cachePath, cacheDir, vaultIdBuf, shouldCompress, maxRamMb, N, K, io } = options;
  if (options.fromCache) {
    try {
      // Read the cache by offsets and hand the rest of the pipeline a PATH. This
      // branch exists for a blob that was already too big to push in one go, so
      // slurping it whole is worst exactly where it is needed most - and past
      // Node's 2 GiB single-read ceiling it does not merely strain memory, it
      // throws. The catch below would then swallow that, report "no cached blob"
      // and re-pack the directory from scratch, unlinking the very cache that
      // BFS told the operator to resume from. Everything needed here is a
      // prefix: the file table, which a V2 blob carries per user file whether or
      // not the data section is compressed. Reading it is what lets the version
      // report how many files it holds and how much they weigh - figures that
      // describe the CACHED blob, not the directory as it stands now, which a
      // resume deliberately no longer looks at.
      const stat = await fs.stat(cachePath);
      const blob_hash = await _verifyCachedBlobSeal(cachePath, stat.size, io);
      const { file_count, total_size } = await _readCachedBlobFigures(cachePath);
      io.info(t('vault_using_cached_blob'));
      return { blobSource: cachePath, blobSize: stat.size, file_count, total_size, skipped: [], blob_hash };
    } catch (err) {
      // A cache that fails its own seal is not "this is not usable backup data"
      // - it IS backup data, whose bytes stopped agreeing with it. Falling
      // through would unlink the evidence and silently re-pack, turning a signal
      // that the disk is misbehaving into a longer push nobody asked for.
      if (err instanceof PushCacheCorruptedError) throw err;
      // Past the seal check, only a missing cache may fall through to a fresh
      // pack, because the fallback starts by unlinking it. A read that broke for
      // another reason - the file briefly locked by a scanner, a descriptor
      // limit - says nothing about the bytes, and swallowing it would destroy
      // the work an interrupted push already did, on the very path the operator
      // was told to resume from.
      const code = (err as NodeJS.ErrnoException)?.code;
      if (!(err instanceof BfsError) && code !== 'ENOENT') throw err;
      io.info(t('vault_no_cached_blob_push'));
    }
  }
  return _packFreshBlob({ rootDir, cachePath, cacheDir, vaultIdBuf, shouldCompress, maxRamMb, N, K, io });
}

interface WritePushResultsOptions {
  rootDir: string;
  config: VaultConfig;
  state: VaultState;
  targetVersion: number;
  file_count: number;
  total_size: number;
  blob_hash: string;
  stripeSize: number;
  shouldEncrypt: boolean;
  shouldCompress: boolean;
  manifestShards: ManifestShard[];
  health: VersionHealth;
  lock: PushLock;
  cachePath: string;
  N: number;
  K: number;
}

/**
 * Builds and writes the VersionManifest, updates state.json, and cleans up
 * blob cache + push.lock on full success (all N+K shards uploaded).
 * On partial success (some shards failed) the cache and lock are kept so the
 * user can retry with `bfs push --cache`.
 *
 * @param options - all data needed to build the manifest and decide cleanup
 */
async function _writePushResults(options: WritePushResultsOptions): Promise<void> {
  const { rootDir, config, state, targetVersion, file_count, total_size, blob_hash, stripeSize, shouldEncrypt, shouldCompress, manifestShards, health, lock, cachePath, N, K } = options;
  const manifest: VersionManifest = {
    version: targetVersion,
    pushed_at: new Date().toISOString(),
    file_count,
    total_size,
    blob_hash,
    scheme: config.scheme,
    encrypted: shouldEncrypt,
    rs_striped: true,
    rs_stripe_size: stripeSize,
    encrypted_per_shard: shouldEncrypt,
    ...(shouldCompress ? { compressed: true as const, blob_size_uncompressed: total_size } : {}),
    shards: manifestShards,
    health,
  };
  await writeManifest(rootDir, manifest);
  if (manifestShards.length >= 1) {
    // A completed push confirms the provider locations are trusted - clear the
    // post-recovery "unconfirmed" gate so later pushes run unprompted.
    await writeState(rootDir, { latest_version: Math.max(state.latest_version, targetVersion), working_version: targetVersion, locations_confirmed: true });
  }
  const fullSuccess = lock.failed.length === 0 && lock.uploaded.length === N + K;
  if (fullSuccess) {
    untrackFile(cachePath);
    await fs.unlink(cachePath).catch(() => {});
    await removeLock(pushLockPath(rootDir));
  }
}

interface TargetVersionOptions {
  mode: PushMode | undefined;
  config: VaultConfig;
  state: VaultState;
  io: ProviderIO;
  /** Pre-consents to the version-switch confirmation, skipping it entirely. */
  yes?: boolean;
}

/**
 * Determines the target push version based on the effective PushMode.
 * May prompt the user interactively (Ask mode) and confirms when working_version
 * lags behind latest_version to prevent accidental overwrites. `yes` pre-consents
 * to that confirmation.
 *
 * @param options - mode, config, state, io, yes
 * @returns Target version number for this push
 * @throws BfsError when the user cancels, or when a run with no operator cannot confirm
 */
async function _resolveTargetVersion(options: TargetVersionOptions): Promise<number> {
  const { config, state, io } = options;
  const effectiveMode = options.mode ?? config.push_mode;
  let targetVersion: number;
  switch (effectiveMode) {
    case PushMode.Overwrite:
      targetVersion = state.working_version > 0 ? state.working_version : state.latest_version + 1;
      break;
    case PushMode.Ask: {
      const choice = await io.choose(`Create new version v${state.latest_version + 1} or overwrite v${state.working_version}?`, [`New version (v${state.latest_version + 1})`, `Overwrite (v${state.working_version})`]);
      targetVersion = choice.startsWith('Overwrite') ? state.working_version : state.latest_version + 1;
      break;
    }
    default:
      targetVersion = state.latest_version + 1;
      break;
  }
  if (options.yes !== true && state.working_version > 0 && state.working_version < state.latest_version) {
    // `--yes` carries this consent up front. Without it, a run with nobody in it
    // names that flag and stops, rather than borrowing the wording of a
    // cancellation nobody made - and it points at `push --yes`, never `bfs pull`,
    // whose confirmation would overwrite the working directory (the single source
    // of truth) instead of waiving a prompt.
    if (io.interactive === false) {
      throw new BfsError(fmt('push_version_switch_no_operator', String(state.working_version), String(state.latest_version), String(targetVersion)));
    }
    const cont = await io.confirm(fmt('vault_push_version_confirm', String(state.working_version), String(state.latest_version), String(targetVersion)));
    if (!cont) throw new BfsError(t('push_cancelled'));
  }
  return targetVersion;
}

interface PushPathsOptions {
  rootDir: string;
  cacheDir?: string | undefined;
  tempDir?: string | undefined;
  config: VaultConfig;
}

interface ResolvedPushPaths {
  readonly cacheDir: string;
  readonly tempDir: string;
  readonly cachePath: string;
}

/**
 * Resolves and validates the cache and temp directories for a push operation.
 * Falls back to config values and project defaults and creates cacheDir. The
 * temp dir is validated and created only when configured explicitly; the
 * default is os.tmpdir(), which always exists.
 *
 * @param options - rootDir, optional cacheDir/tempDir overrides, config
 * @returns Resolved absolute paths and the blob cachePath
 * @throws BfsError when a directory path is invalid
 */
async function _resolvePushPaths(options: PushPathsOptions): Promise<ResolvedPushPaths> {
  const { rootDir, config } = options;
  const cacheDir = options.cacheDir ?? config.cache_dir ?? path.join(rootDir, '.bfs', 'cache');
  await _validateConfigDir(cacheDir, 'cache-dir');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  // Only an explicitly configured temp dir is validated - os.tmpdir() always
  // exists, and the hint attached to the error would point back at it anyway.
  const explicitTempDir = options.tempDir ?? config.temp_dir ?? null;
  if (explicitTempDir !== null) {
    await _validateConfigDir(explicitTempDir, 'temp-dir');
    // The validation accepts a not-yet-existing leaf (only the parent must
    // exist) and mkdtemp does not create parents - so create it here.
    await fs.mkdir(explicitTempDir, { recursive: true, mode: 0o700 });
  }
  const tempDir = explicitTempDir ?? os.tmpdir();
  const cachePath = path.join(cacheDir, 'push.blob.pending');
  return { cacheDir, tempDir, cachePath };
}

interface DeriveEncryptionKeyOptions {
  config: VaultConfig;
  password: string | undefined;
  io: ProviderIO;
}

interface EncryptionSetup {
  shouldEncrypt: boolean;
  kdf_salt: Nullable<Buffer>;
  encKey: Buffer | undefined;
}

/**
 * Determines whether to encrypt, prompts for password if needed, and derives the key.
 * Returns shouldEncrypt=false with null/undefined when encryption is disabled and
 * no --password flag was provided.
 *
 * @param options - config, password (from CLI flag), io
 * @returns EncryptionSetup with shouldEncrypt, kdf_salt, encKey
 * @throws BfsError when password is required but not provided or confirmation mismatches
 */
async function _deriveEncryptionKey(options: DeriveEncryptionKeyOptions): Promise<EncryptionSetup> {
  const { config, io } = options;
  const shouldEncrypt = config.encryption.enabled || !!options.password;
  if (!shouldEncrypt) {
    io.warn(t('vault_unencrypted_warning'));
    return { shouldEncrypt: false, kdf_salt: null, encKey: undefined };
  }
  if (!config.encryption.enabled && options.password) {
    io.warn(t('vault_password_overrides_config'));
  }
  let password: Nullable<string> = options.password ?? null;
  if (!password) {
    password = await io.askSecret(t('vault_ask_encrypt_password'));
    if (!password) throw new BfsError(t('vault_password_required'));
    const confirm = await io.askSecret(t('vault_ask_confirm_password'));
    if (confirm !== password) throw new BfsError(t('vault_passwords_mismatch'));
  }
  const kdf_salt = generateSalt();
  const encKey = await deriveKey(password, kdf_salt);
  io.info(t('vault_encrypting'));
  return { shouldEncrypt: true, kdf_salt, encKey };
}

interface RsEncodeBlobOptions {
  blobSource: Buffer | string;
  targetVersion: number;
  tempDir: string;
  N: number;
  K: number;
  stripeSize: number;
}

interface RsEncodeResult {
  /** Private scratch directory holding the parity files - removed by the caller. */
  scratchDir: string;
  parityPaths: string[];
  shardHashes: string[];
}

/**
 * Reed-Solomon striped encode of the blob.
 * Writes K parity shard files into a fresh `bfs-push-*` scratch directory
 * under tempDir and returns data+parity hashes.
 *
 * The scratch directory comes from fs.mkdtemp: tempDir defaults to the shared
 * system temp, where a predictable name would be open to link planting and the
 * default file mode would expose backup data - mkdtemp gives a random suffix,
 * mode 0700 and refuses an existing target.
 *
 * @param options - blobSource, targetVersion, tempDir, N, K, stripeSize
 * @returns scratchDir, parityPaths (K files inside it) and shardHashes (N+K)
 */
async function _rsEncodeBlob(options: RsEncodeBlobOptions): Promise<RsEncodeResult> {
  const { blobSource, targetVersion, tempDir, N, K, stripeSize } = options;
  const scratchDir = await fs.mkdtemp(path.join(tempDir, 'bfs-push-'));
  await fs.chmod(scratchDir, 0o700).catch(() => {});
  const parityPaths: string[] = Array.from({ length: K }, (_, j) => path.join(scratchDir, `parity-${targetVersion}-${j}.tmp`));
  const rsSourceStream: Readable = Buffer.isBuffer(blobSource) ? Readable.from(blobSource) : createReadStream(blobSource);
  try {
    const { dataShardHashes, parityShardHashes } = await rsEncodeStriped(rsSourceStream, parityPaths, N, K, stripeSize);
    return { scratchDir, parityPaths, shardHashes: [...dataShardHashes, ...parityShardHashes] };
  } catch (e: unknown) {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
    throw e;
  }
}

interface BuildShardStreamsOptions {
  config: VaultConfig;
  blobSource: Buffer | string;
  parityPaths: string[];
  locationMap: ShardLocation[];
  shardIndex: number;
  targetVersion: number;
  N: number;
  K: number;
  stripeSize: number;
  encKey: Buffer | undefined;
  kdf_salt: Nullable<Buffer>;
  shouldEncrypt: boolean;
  blob_hash: string;
  blobSize: number;
  encPayloadSize: number;
}

interface BuildShardStreamsResult {
  shardStream: Readable;
  shardFileSize: number;
}

/**
 * Builds the shard header, encrypts or passes through the payload, and assembles
 * the final shard Readable stream (header + payload + checksum placeholder).
 * Pure computation - no I/O.
 *
 * @param options - all fields needed to construct one shard's binary stream
 * @returns { shardStream, shardFileSize }
 */
function _buildShardStreams(options: BuildShardStreamsOptions): BuildShardStreamsResult {
  const { config, blobSource, parityPaths, locationMap, shardIndex: i, targetVersion, N, K, stripeSize, encKey, kdf_salt, shouldEncrypt, blob_hash, blobSize, encPayloadSize } = options;
  const header: ShardHeader = {
    magic: 'BFSS',
    format_version: 2,
    vault_id: config.vault_id,
    vault_name: config.vault_name,
    blob_size: BigInt(blobSize),
    blob_hash,
    data_shards: N,
    parity_shards: K,
    shard_index: i,
    version: targetVersion,
    encrypted: shouldEncrypt,
    kdf_salt,
    rs_stripe_size: stripeSize,
    map_length: 0,
    location_map: locationMap,
  };
  const serializedHeader = serializeShardHeader(header, encKey);
  const parityPath = parityPaths[i - N];
  const rawPayload: Readable = i < N ? _stripedShardStream(blobSource, blobSize, i, N, stripeSize) : createReadStream(parityPath ?? '');
  const payloadStream = encKey ? encryptStream(rawPayload, encKey, deriveShardNonce(encKey, targetVersion, i)) : rawPayload;
  return { shardStream: buildShardStream(serializedHeader, payloadStream), shardFileSize: serializedHeader.length + encPayloadSize + SHA256_BYTES };
}

interface UploadOneShardOptions {
  shardIndex: number;
  pc: ProviderConfig;
  provider: StorageProvider | undefined;
  rootDir: string;
  blobSource: Buffer | string;
  cacheDir: string;
  cachePath: string;
  shardStream: Readable;
  shardFileSize: number;
  shardHashes: string[];
  lock: PushLock;
  config: VaultConfig;
  targetVersion: number;
  N: number;
  K: number;
  cacheDumpAttempted: boolean;
  io: ProviderIO;
}

interface UploadOneShardResult {
  manifestShard: Nullable<ManifestShard>;
  cacheDumpAttempted: boolean;
}

/**
 * Uploads a single shard stream to its provider and updates push.lock.
 * On failure captures the error in lock.failed and performs an emergency
 * RAM->disk blob dump when the blob is still in-memory.
 * Mutates `lock` in-place (object reference shared with the caller).
 *
 * @param options - all shard-specific data plus shared lock reference
 * @returns ManifestShard on success (null on failure) and updated cacheDumpAttempted
 */
async function _uploadOneShard(options: UploadOneShardOptions): Promise<UploadOneShardResult> {
  const { shardIndex: i, pc, provider, rootDir, blobSource, cacheDir, cachePath, shardStream, shardFileSize, shardHashes, lock, config, targetVersion, N, K, io } = options;
  let { cacheDumpAttempted } = options;
  try {
    await provider?.upload(`shard_${i}.bfs.${targetVersion}`, shardStream, shardFileSize);
    io.progress(fmt('vault_upload_shard_progress', String(i + 1), String(N + K)), ((i + 1) / (N + K)) * 100);
    const manifestShard: ManifestShard = { shard_index: i, provider_id: pc.id, provider_type: pc.type, remote_path: buildRemotePath(pc, config.vault_name, `shard_${i}.bfs.${targetVersion}`), shard_hash: shardHashes[i] ?? '' };
    lock.uploaded.push({ shard_index: i, provider_id: pc.id });
    await writeLockAtomic(pushLockPath(rootDir), lock);
    return { manifestShard, cacheDumpAttempted };
  } catch (e: unknown) {
    // Release the shard stream so its file-backed payload source (parity temp)
    // is torn down now, before the scratch directory is removed after the
    // loop - otherwise an orphaned read stream races the removal and throws.
    shardStream.destroy();
    const { reason, detail } = _classifyUploadError(e);
    lock.failed.push({ shard_index: i, provider_id: pc.id, reason, detail, attempted_at: new Date().toISOString() });
    if (Buffer.isBuffer(blobSource) && !cacheDumpAttempted) {
      cacheDumpAttempted = true;
      try {
        await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
        await fs.writeFile(cachePath, blobSource, { mode: 0o600 });
        await fs.chmod(cachePath, 0o600).catch(() => {});
        trackFile(cachePath);
      } catch (writeErr: unknown) {
        lock.blob_pending_path = null;
        io.warn(fmt('push_cache_write_failed', writeErr instanceof Error ? writeErr.message : String(writeErr)));
      }
    }
    await writeLockAtomic(pushLockPath(rootDir), lock);
    io.warn(fmt('vault_upload_shard_failed', String(i + 1), String(N + K), detail));
    return { manifestShard: null, cacheDumpAttempted };
  }
}

interface UploadAllShardsOptions {
  rootDir: string;
  config: VaultConfig;
  providers: StorageProvider[];
  blobSource: Buffer | string;
  parityPaths: string[];
  locationMap: ShardLocation[];
  shardHashes: string[];
  lock: PushLock;
  cachePath: string;
  cacheDir: string;
  targetVersion: number;
  N: number;
  K: number;
  stripeSize: number;
  encKey: Buffer | undefined;
  kdf_salt: Nullable<Buffer>;
  shouldEncrypt: boolean;
  blob_hash: string;
  blobSize: number;
  io: ProviderIO;
}

interface UploadAllShardsResult {
  manifestShards: ManifestShard[];
}

/**
 * Runs the upload loop over all N+K shards with partial-commit semantics.
 * Each shard is built and uploaded independently; failures are recorded in
 * `lock` (mutated in-place) without aborting remaining shards.
 * An emergency RAM->disk blob dump is attempted on the first failure when
 * blobSource is a Buffer (so `bfs push --cache` can resume later).
 *
 * @param options - all data needed for the upload loop
 * @returns { manifestShards } - only successfully uploaded shards
 */
async function _uploadAllShards(options: UploadAllShardsOptions): Promise<UploadAllShardsResult> {
  const { config, providers, blobSource, parityPaths, locationMap, shardHashes, lock, cachePath, cacheDir, rootDir, targetVersion, N, K, stripeSize, encKey, kdf_salt, shouldEncrypt, blob_hash, blobSize, io } = options;
  const rawPayloadSize = rawShardPayloadSize(blobSize, N, stripeSize);
  const encPayloadSize = encKey ? rawPayloadSize + 16 : rawPayloadSize;
  const manifestShards: ManifestShard[] = [];
  let cacheDumpAttempted = false;
  for (let i = 0; i < N + K; i++) {
    const pc = config.providers[i];
    if (!pc) throw new BfsError(`Internal: provider config missing for index ${i}`);
    const { shardStream, shardFileSize } = _buildShardStreams({ config, blobSource, parityPaths, locationMap, shardIndex: i, targetVersion, N, K, stripeSize, encKey, kdf_salt, shouldEncrypt, blob_hash, blobSize, encPayloadSize });
    const result = await _uploadOneShard({ shardIndex: i, pc, provider: providers[i], rootDir, blobSource, cacheDir, cachePath, shardStream, shardFileSize, shardHashes, lock, config, targetVersion, N, K, cacheDumpAttempted, io });
    if (result.manifestShard) manifestShards.push(result.manifestShard);
    cacheDumpAttempted = result.cacheDumpAttempted;
  }
  return { manifestShards };
}

interface HandleSkippedFilesOptions {
  skipped: SkippedFile[];
  cachePath: string;
  cacheDir: string;
  blobSource: Buffer | string;
  interactive?: boolean | undefined;
  io: ProviderIO;
}

/**
 * Handles the skipped-files situation after blob packing.
 * Ensures the blob is on disk (so the user can retry with --cache), then either
 * prompts interactively or throws PushSkippedError in non-interactive mode.
 * No-op when skipped is empty.
 *
 * @param options - skipped, cachePath, cacheDir, blobSource, interactive, io
 * @throws BfsError when the user cancels the interactive prompt
 * @throws PushSkippedError in non-interactive mode when files were skipped
 */
async function _handleSkippedFiles(options: HandleSkippedFilesOptions): Promise<void> {
  const { skipped, cachePath, cacheDir, blobSource, io } = options;
  if (skipped.length === 0) return;
  if (Buffer.isBuffer(blobSource)) {
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    trackFile(cachePath);
    await fs.writeFile(cachePath, blobSource, { mode: 0o600 });
    await fs.chmod(cachePath, 0o600).catch(() => {});
  }
  if (options.interactive) {
    const shown = skipped.slice(0, 10);
    const rest = skipped.length - shown.length;
    const fileList = shown.map((s) => `  - ${s.path}: ${s.reason}`).join('\n') + (rest > 0 ? `\n  ... and ${rest} more` : '');
    const cont = await io.confirm(fmt('vault_push_skipped_confirm', String(skipped.length), fileList));
    if (!cont) {
      untrackFile(cachePath);
      await fs.unlink(cachePath).catch(() => {});
      throw new BfsError(t('push_cancelled'));
    }
    untrackFile(cachePath);
  } else {
    untrackFile(cachePath);
    throw new PushSkippedError(skipped, cachePath);
  }
}

/** Max drift entries shown in a list before collapsing the rest into a counter. */
const DRIFT_LIST_LIMIT = 10;

/**
 * Renders a drift breakdown as an indented, labelled file list for prompts and
 * warnings. Truncates to DRIFT_LIST_LIMIT lines with a "... and N more" tail.
 *
 * @param drift - Drift buckets to render
 * @returns Multi-line string; each line is `  - <label>: <path>`
 */
export function _formatDriftList(drift: CatalogDrift): string {
  const lines: string[] = [];
  const buckets: Array<[string, readonly string[]]> = [
    [t('push_drift_label_changed'), drift.changed],
    [t('push_drift_label_vanished'), drift.vanished],
    [t('push_drift_label_appeared'), drift.appeared],
  ];
  for (const [label, paths] of buckets) {
    for (const p of paths) {
      if (lines.length >= DRIFT_LIST_LIMIT) break;
      lines.push(`  - ${label}: ${p}`);
    }
  }
  const total = drift.changed.length + drift.vanished.length + drift.appeared.length;
  if (total > lines.length) lines.push(`  ... and ${total - lines.length} more`);
  return lines.join('\n');
}

interface HandleCatalogDriftOptions {
  drift: CatalogDrift;
  allowDrift?: boolean | undefined;
  interactive?: boolean | undefined;
  io: ProviderIO;
}

/**
 * Decision gate for a detected blob<->directory drift. No-op when there is no
 * drift. With allowDrift it warns and proceeds (any mode). Interactive mode
 * prompts to accept or retry; declining throws BfsError. Non-interactive without
 * allowDrift throws PushDriftError. Every outcome keeps the blob restorable -
 * the gate governs currency, never recoverability.
 *
 * @param options - drift, allowDrift, interactive, io
 * @throws BfsError when the user declines the interactive prompt
 * @throws PushDriftError in non-interactive mode when drift is not allowed
 */
export async function _handleCatalogDrift(options: HandleCatalogDriftOptions): Promise<void> {
  const { drift, io } = options;
  if (!catalogHasDrift(drift)) return;
  const count = drift.changed.length + drift.vanished.length + drift.appeared.length;
  const fileList = _formatDriftList(drift);
  if (options.allowDrift) {
    io.warn(fmt('push_drift_accepted', String(count), fileList));
    return;
  }
  if (options.interactive) {
    const cont = await io.confirm(fmt('push_drift_confirm', String(count), fileList));
    if (!cont) throw new BfsError(t('push_cancelled'));
    return;
  }
  throw new PushDriftError(drift);
}

/** Max excluded entries shown in a list before collapsing the rest into a counter. */
const EXCLUDED_LIST_LIMIT = 10;

/**
 * Renders excluded entries as an indented, labelled file list for prompts and
 * warnings. Truncates to EXCLUDED_LIST_LIMIT lines with a "... and N more" tail.
 *
 * @param excluded - Entries excluded by type (symlinks/special files)
 * @returns Multi-line string; each line is `  - <label>: <path>`
 */
export function _formatExcludedList(excluded: readonly ExcludedEntry[]): string {
  const label = (reason: ExcludedEntry['reason']): string => (reason === 'symlink' ? t('push_excluded_label_symlink') : t('push_excluded_label_special'));
  const shown = excluded.slice(0, EXCLUDED_LIST_LIMIT);
  const lines = shown.map((e) => `  - ${label(e.reason)}: ${e.path}`);
  if (excluded.length > shown.length) lines.push(`  ... and ${excluded.length - shown.length} more`);
  return lines.join('\n');
}

interface HandleExcludedEntriesOptions {
  rootDir: string;
  allowExcluded?: boolean | undefined;
  interactive?: boolean | undefined;
  io: ProviderIO;
}

/**
 * Gate for entries that cannot be backed up (symlinks / special files), detected
 * before packing. No-op when there are none. With allowExcluded it warns and
 * returns them (packing then drops them). Interactive mode lists them and offers
 * to append them to .bfsignore and retry, looping until the scan is clean or the
 * user declines. Non-interactive without allowExcluded throws PushExcludedError
 * (CLI exit code 3). Symlinks/special files are a permanent, by-design exclusion,
 * distinct from unreadable files (which keep the cache/`--cache` flow).
 *
 * @param options - rootDir, allowExcluded, interactive, io
 * @returns Entries excluded from the backup (allowExcluded path); [] when added to
 *          .bfsignore or none existed
 * @throws PushExcludedError in non-interactive mode when entries cannot be backed up
 * @throws BfsError when the user declines the interactive prompt
 */
export async function _handleExcludedEntries(options: HandleExcludedEntriesOptions): Promise<ExcludedEntry[]> {
  const { rootDir, io } = options;
  let excluded = (await scanDirClassified(rootDir, createIgnoreFilter(rootDir))).excluded;
  while (excluded.length > 0) {
    if (options.allowExcluded) {
      io.warn(fmt('push_excluded_allowed', String(excluded.length), _formatExcludedList(excluded)));
      return excluded;
    }
    if (!options.interactive) {
      throw new PushExcludedError(excluded);
    }
    const cont = await io.confirm(fmt('push_excluded_confirm', String(excluded.length), _formatExcludedList(excluded)));
    if (!cont) throw new BfsError(t('push_cancelled'));
    const beforePaths = new Set(excluded.map((e) => e.path));
    await appendToBfsignore(
      rootDir,
      excluded.map((e) => e.path),
    );
    io.info(fmt('push_excluded_added', String(excluded.length)));
    excluded = (await scanDirClassified(rootDir, createIgnoreFilter(rootDir))).excluded;
    // Progress guard: an entry still present after being appended to .bfsignore
    // has a name that cannot be encoded as a matching ignore pattern (trailing
    // whitespace, an embedded newline, ...). Stop with a clear error instead of
    // re-appending it forever.
    const stuck = excluded.filter((e) => beforePaths.has(e.path));
    if (stuck.length > 0) throw new BfsError(fmt('push_excluded_unignorable', _formatExcludedList(stuck)));
  }
  return [];
}

interface BuildLocationMapOptions {
  config: VaultConfig;
  targetVersion: number;
  shardHashes: string[];
  io: ProviderIO;
}

/**
 * Builds the ShardLocation[] map embedded in each shard header. Each provider's
 * adapter-declared secret values are stripped from connection_config and their
 * names recorded in required_inputs - secrets must never travel inside shard
 * headers. No disk or network I/O; the input config is not mutated.
 *
 * @param options - config, targetVersion, shardHashes, io
 * @returns Array of ShardLocation entries, one per provider
 */
function _buildLocationMap(options: BuildLocationMapOptions): ShardLocation[] {
  const { config, targetVersion, shardHashes, io } = options;
  return config.providers.map((pc, i) => {
    const { connection_config, required_inputs } = splitLocationSecrets(pc.type, pc.config, io);
    return {
      shard_index: i,
      provider_id: pc.id,
      provider_type: pc.type,
      adapterPackage: pc.adapterPackage,
      connection_config,
      required_inputs,
      remote_path: buildRemotePath(pc, config.vault_name, `shard_${i}.bfs.${targetVersion}`),
      shard_hash: shardHashes[i] ?? '',
    };
  });
}

// --- push() - main export ----------------------------------------------------

/**
 * Full push pipeline: pack -> [encrypt] -> RS-encode -> upload -> manifest -> state.
 *
 * Partial-commit semantics: shard upload failures are captured per shard in
 * .bfs/push.lock and the manifest is written with whichever shards succeeded
 * (health: Degraded when uploaded >= N, Damaged when 1 <= uploaded < N,
 * throws when 0 uploaded). State.json is updated whenever at least one shard
 * uploaded; lock + cached blob are removed only on full success.
 *
 * @returns PushResult with version, file_count, total_size, skipped, excluded, uploaded_count, failed, health
 * @throws BfsError if config missing, password missing for encrypted vault, or zero shards uploaded
 * @throws VaultCollisionError if a provider's location holds a different backup
 * @throws LockConcurrentActiveError if another push or repair operation is in progress
 * @throws LockPartialStatePushError if a leftover push.lock from a crashed/dead run is detected
 * @throws PushCacheNoLockError when fromCache=true but push.lock or cached blob is missing
 * @throws PushCacheUnavailableError when fromCache=true and the lock records no cache to resume from
 * @throws PushCacheCorruptedError when fromCache=true and the cached blob contradicts its own checksum
 * @throws PushExcludedError (non-interactive) if entries cannot be backed up (symlinks / special files)
 * @throws PushDriftError (non-interactive) if the directory changed while packing
 * @throws PushSkippedError (non-interactive) if any source files could not be read
 */
export async function push(rootDir: string, options: PushOptions): Promise<PushResult> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('push_no_config'));
  assertSchemeValid(config);
  const state = await readState(rootDir);
  // First write after recovery: the config came from an untrusted location map,
  // so show the operator where shards will go and require confirmation before
  // uploading anything (defends against a recovered config pointing at an
  // attacker host). Cleared on the first confirmed push (see _writePushResults).
  if (state.locations_confirmed === false) {
    await confirmRecoveredLocations(config, options.io);
  }
  // Refuse to overwrite a DIFFERENT backup occupying our target location (foreign
  // vault_id) - before packing, so a colliding push wastes no pack/encode work.
  await _assertNoForeignVaults(config, options.io);
  // Entries that cannot be backed up (symlinks / special files) are handled
  // before packing: abort with exit code 3 non-interactively, or offer to add
  // them to .bfsignore and retry interactively. Skipped for --cache (the blob
  // was packed by an earlier run, so there is no fresh scan to gate).
  const excluded = options.fromCache === true ? [] : await _handleExcludedEntries({ rootDir, allowExcluded: options.allowExcluded, interactive: options.interactive, io: options.io });
  const { data_shards: N, parity_shards: K } = config.scheme;
  const { cacheDir, tempDir, cachePath } = await _resolvePushPaths({ rootDir, cacheDir: options.cacheDir, tempDir: options.tempDir, config });
  const targetVersion = await _resolveTargetVersion({ mode: options.mode, config, state, io: options.io, ...(options.yes === true ? { yes: true } : {}) });
  const lock = await _initPushLock(rootDir, options.fromCache === true, cachePath, targetVersion, config);
  const maxRamMb = options.maxRamMb ?? config.max_ram_mb;
  const shouldCompress = options.compressOverride !== undefined ? options.compressOverride : (config.compression?.enabled ?? true);
  // Bracket the pack window with two stat snapshots to detect files that change
  // on disk while packing (currency). Skipped for --cache: the blob comes from an
  // earlier pack, so there is no fresh window to bracket.
  const driftFilter = options.fromCache !== true ? createIgnoreFilter(rootDir) : null;
  const snapshotBefore = driftFilter ? await snapshotCatalog(rootDir, driftFilter) : null;
  const {
    blobSource,
    blobSize,
    file_count,
    total_size,
    skipped,
    blob_hash: verifiedBlobHash,
  } = await _loadOrPackBlob({ rootDir, cachePath, cacheDir, vaultIdBuf: uuidToBuffer(config.vault_id), fromCache: options.fromCache, shouldCompress, maxRamMb, N, K, io: options.io });
  await _handleSkippedFiles({ skipped, cachePath, cacheDir, blobSource, interactive: options.interactive, io: options.io });
  if (driftFilter && snapshotBefore) {
    const snapshotAfter = await snapshotCatalog(rootDir, driftFilter);
    const drift = diffCatalog(snapshotBefore, snapshotAfter, new Set(skipped.map((s) => s.path)));
    await _handleCatalogDrift({ drift, allowDrift: options.allowDrift, interactive: options.interactive, io: options.io });
  }
  const { shouldEncrypt, kdf_salt, encKey } = await _deriveEncryptionKey({ config, password: options.password, io: options.io });
  // A resume already hashed these bytes to check them against the blob's own
  // seal, and that digest IS blob_hash - hashing the file again would double the
  // read on exactly the backups that were too large to push in one go.
  const blob_hash = verifiedBlobHash ?? (await _hashBlobWithoutChecksum(blobSource, blobSize));
  const stripeSize = computeStripeSize({ maxRamMb, N, K, blobSize });
  if (encKey && exceedsGcmPlaintextLimit(rawShardPayloadSize(blobSize, N, stripeSize))) {
    throw new BfsError(fmt('gcm_payload_too_large', String(GCM_MAX_PLAINTEXT_BYTES / 1024 ** 3)));
  }
  options.io.info(t('vault_encoding_rs'));
  const { scratchDir, parityPaths, shardHashes } = await _rsEncodeBlob({ blobSource, targetVersion, tempDir, N, K, stripeSize });
  let manifestShards: ManifestShard[];
  try {
    const locationMap = _buildLocationMap({ config, targetVersion, shardHashes, io: options.io });
    options.io.info(t('vault_uploading_shards'));
    const providers = await openProviders(config, options.io);
    ({ manifestShards } = await _uploadAllShards({
      rootDir,
      config,
      providers,
      blobSource,
      parityPaths,
      locationMap,
      shardHashes,
      lock,
      cachePath,
      cacheDir,
      targetVersion,
      N,
      K,
      stripeSize,
      encKey,
      kdf_salt,
      shouldEncrypt,
      blob_hash,
      blobSize,
      io: options.io,
    }));
  } finally {
    await fs.rm(scratchDir, { recursive: true, force: true }).catch(() => {});
  }
  const health = _computeHealth(manifestShards.length, N, K);
  await _writePushResults({ rootDir, config, state, targetVersion, file_count, total_size, blob_hash, stripeSize, shouldEncrypt, shouldCompress, manifestShards, health, lock, cachePath, N, K });
  return { version: targetVersion, file_count, total_size, skipped, excluded, uploaded_count: manifestShards.length, failed: lock.failed, health };
}
