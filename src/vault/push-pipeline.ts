/**
 * Push pipeline — full implementation of `bfs push`.
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
import { estimateBlobSize, packBlob, packBlobToFile, packBlobToFileZipped } from '../core/blob-pack.js';
import { parseBlobFileTable } from '../core/blob-unpack.js';
import { trackFile, untrackFile } from '../core/cleanup.js';
import { deriveKey, deriveShardNonce, encryptStream, exceedsGcmPlaintextLimit, GCM_MAX_PLAINTEXT_BYTES, generateSalt } from '../core/crypto.js';
import type { SkippedFile } from '../core/errors.js';
import { BfsError, ProviderError, PushCacheNoLockError, PushCacheUnavailableError, PushDriftError, PushSkippedError } from '../core/errors.js';
import { hashBuffer, hashStream, SHA256_BYTES } from '../core/hash.js';
import { createIgnoreFilter } from '../core/ignore.js';
import { calcShardPayloadSize, rsEncodeStriped } from '../core/reed-solomon.js';
import { buildShardStream, serializeShardHeader, uuidToBuffer, V2_MAX_STRIPE_SIZE } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { CatalogDrift, ManifestShard, ProviderConfig, ProviderIO, PushOptions, PushResult, ShardHeader, ShardLocation, StorageProvider, VaultConfig, VaultState, VersionManifest } from '../types/index.js';
import { BLOB_FLAGS, PushMode, VersionHealth } from '../types/index.js';
import { catalogHasDrift, diffCatalog, snapshotCatalog } from './catalog-verify.js';
import { assertSchemeValid, readConfig } from './config.js';
import { splitLocationSecrets } from './location-map.js';
import type { PushLock, PushLockFailedReason } from './lockfile.js';
import { assertNoActiveLock, pushLockPath, readLock, removeLock, writeLockAtomic } from './lockfile.js';
import { writeManifest } from './manifest.js';
import { confirmRecoveredLocations } from './recovered-locations.js';
import { readState, writeState } from './state.js';

// ─── Push-only V2 constants ──────────────────────────────────────────────────
// V2_STRIPE_SIZE is intentionally kept in vault-manager.ts because pull needs it too.

/** Minimum stripe size floor (16 MiB). */
const V2_MIN_STRIPE_SIZE = 16 * 1024 * 1024;
/** packBlob() uses Buffer.concat — cap to avoid excessive RAM from double-buffering. */
const V2_MAX_BLOB_IN_RAM = 4 * 1024 * 1024 * 1024;

// ─── RAM budget utilities ────────────────────────────────────────────────────

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
 * Computes the optimal stripe size given a RAM budget.
 * Peak RS encoding RAM = (N + K) × stripeSize bytes.
 */
function computeStripeSize(params: StripeSizeParams): number {
  const ramBytes = resolveRamBudget(params.maxRamMb);
  const fromRam = Math.floor(ramBytes / (params.N + params.K));
  const fromBlob = calcShardPayloadSize(params.blobSize, params.N);
  return Math.min(Math.max(V2_MIN_STRIPE_SIZE, Math.min(fromRam, V2_MAX_STRIPE_SIZE)), fromBlob);
}

/**
 * Per-shard plaintext payload size (bytes) for striped encoding — identical for
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
 * Reserves only the actual RS encoding overhead: (N+K) × V2_MAX_STRIPE_SIZE.
 */
function computeRamThreshold(maxRamMb: Nullable<number> | undefined, N: number, K: number): number {
  const ramBytes = resolveRamBudget(maxRamMb);
  const rsOverhead = (N + K) * V2_MAX_STRIPE_SIZE;
  return Math.min(Math.max(0, ramBytes - rsOverhead), V2_MAX_BLOB_IN_RAM);
}

// ─── V2 streaming helpers (push-only) ───────────────────────────────────────

/**
 * Async generator that yields fixed-size stripe chunks for one data shard.
 * Each yield covers one stripe — the shard's slice of each RS stripe row.
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

// ─── Shared utilities (local copy — push must not import vault-manager) ──

/**
 * Validates that a configured directory (or its parent) exists before use.
 * A local copy — the no-import-from-vault-manager rule forbids sharing it
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
  // is size - SHA256_BYTES - 1 — exactly the bytes before the trailing checksum.
  return hashStream(createReadStream(source, { start: 0, end: size - SHA256_BYTES - 1 }));
}

// ─── buildRemotePath ─────────────────────────────────────────────────────────

/**
 * Builds the remote_path for a shard on a given provider.
 * Uses forward slashes: {config.path}/{vault_name}/{filename}.
 */
export function buildRemotePath(providerConfig: ProviderConfig, vaultName: string, filename: string): string {
  const base = String(providerConfig.config.path ?? '');
  return [base, vaultName, filename].join('/').replace(/\\/g, '/');
}

// ─── openProviders ───────────────────────────────────────────────────────────

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

// ─── Push lock ───────────────────────────────────────────────────────────────

/**
 * Creates or refreshes .bfs/push.lock for the current push attempt.
 * For fromCache=true: validates that both the lock and cached blob exist
 * (throws PushCacheNoLockError otherwise), then resets uploaded/failed
 * arrays for a fresh retry. For fromCache=false: writes a brand-new lock.
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
  await writeLockAtomic(lockPath, lock);
  return lock;
}

// ─── Error classification + health ──────────────────────────────────────────

/**
 * Classifies an upload failure into a PushLockFailedReason + human detail.
 * @internal
 */
export function _classifyUploadError(e: unknown): { reason: PushLockFailedReason; detail: string } {
  const detail = e instanceof Error ? e.message : String(e);
  if (e instanceof ProviderError && /auth|530|login|password/i.test(detail)) {
    return { reason: 'auth_failed', detail };
  }
  const code = (e as NodeJS.ErrnoException | null)?.code;
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
 * Throws BfsError when zero — caller must NOT write a manifest in that case.
 */
function _computeHealth(uploaded: number, N: number, K: number): VersionHealth {
  if (uploaded === N + K) return VersionHealth.Healthy;
  if (uploaded >= N) return VersionHealth.Degraded;
  if (uploaded >= 1) return VersionHealth.Damaged;
  throw new BfsError(fmt('push_damaged_zero', String(N), String(N + K)));
}

// ─── Push helpers ─────────────────────────────────────────────────────────────

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
    return { blobSource: cachePath, blobSize: r.blobSize, file_count: r.fileCount, total_size: r.totalSize, skipped: r.skipped };
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
    return { blobSource: r.blob, blobSize: r.blob.length, file_count: entries.length, total_size: entries.reduce((s, e) => s + Number(e.size), 0), skipped: r.skipped };
  }
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  trackFile(cachePath);
  const r = await packBlobToFile(rootDir, cachePath, filter, vaultIdBuf);
  return { blobSource: cachePath, blobSize: r.blobSize, file_count: r.fileCount, total_size: r.totalSize, skipped: r.skipped };
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
      const stat = await fs.stat(cachePath);
      const cacheBlob = await fs.readFile(cachePath);
      const cacheFlags = cacheBlob.readUInt32LE(0x16);
      const isCacheCompressed = (cacheFlags & BLOB_FLAGS.COMPRESSED) !== 0;
      let file_count = 0;
      let total_size = 0;
      if (!isCacheCompressed) {
        const entries = parseBlobFileTable(cacheBlob);
        file_count = entries.length;
        total_size = entries.reduce((s, e) => s + Number(e.size), 0);
      }
      io.info(t('vault_using_cached_blob'));
      return { blobSource: cacheBlob, blobSize: stat.size, file_count, total_size, skipped: [] };
    } catch {
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
    // A completed push confirms the provider locations are trusted — clear the
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
}

/**
 * Determines the target push version based on the effective PushMode.
 * May prompt the user interactively (Ask mode) and confirms when working_version
 * lags behind latest_version to prevent accidental overwrites.
 *
 * @param options - mode, config, state, io
 * @returns Target version number for this push
 * @throws BfsError when the user cancels the confirmation dialog
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
  if (state.working_version > 0 && state.working_version < state.latest_version) {
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
 * Falls back to config values and project defaults, creates cacheDir, and
 * validates both directories via _validateConfigDir.
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
  const tempDir = options.tempDir ?? config.temp_dir ?? cacheDir;
  if (tempDir !== cacheDir) await _validateConfigDir(tempDir, 'temp-dir');
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
  parityPaths: string[];
  shardHashes: string[];
}

/**
 * Reed-Solomon striped encode of the blob.
 * Writes K parity shard files to tempDir and returns data+parity hashes.
 *
 * @param options - blobSource, targetVersion, tempDir, N, K, stripeSize
 * @returns parityPaths (K temp files) and shardHashes (N+K)
 */
async function _rsEncodeBlob(options: RsEncodeBlobOptions): Promise<RsEncodeResult> {
  const { blobSource, targetVersion, tempDir, N, K, stripeSize } = options;
  const parityPaths: string[] = Array.from({ length: K }, (_, j) => path.join(tempDir, `bfs-parity-${targetVersion}-${j}-${Date.now()}.tmp`));
  const rsSourceStream: Readable = Buffer.isBuffer(blobSource) ? Readable.from(blobSource) : createReadStream(blobSource);
  const { dataShardHashes, parityShardHashes } = await rsEncodeStriped(rsSourceStream, parityPaths, N, K, stripeSize);
  return { parityPaths, shardHashes: [...dataShardHashes, ...parityShardHashes] };
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
 * Pure computation — no I/O.
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
  manifestShard: ManifestShard | null;
  cacheDumpAttempted: boolean;
}

/**
 * Uploads a single shard stream to its provider and updates push.lock.
 * On failure captures the error in lock.failed and performs an emergency
 * RAM→disk blob dump when the blob is still in-memory.
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
 * An emergency RAM→disk blob dump is attempted on the first failure when
 * blobSource is a Buffer (so `bfs push --cache` can resume later).
 *
 * @param options - all data needed for the upload loop
 * @returns { manifestShards } — only successfully uploaded shards
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
 * warnings. Truncates to DRIFT_LIST_LIMIT lines with a "… and N more" tail.
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
 * Decision gate for a detected blob↔directory drift. No-op when there is no
 * drift. With allowDrift it warns and proceeds (any mode). Interactive mode
 * prompts to accept or retry; declining throws BfsError. Non-interactive without
 * allowDrift throws PushDriftError. Every outcome keeps the blob restorable —
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

interface BuildLocationMapOptions {
  config: VaultConfig;
  targetVersion: number;
  shardHashes: string[];
  io: ProviderIO;
}

/**
 * Builds the ShardLocation[] map embedded in each shard header. Each provider's
 * adapter-declared secret values are stripped from connection_config and their
 * names recorded in required_inputs — secrets must never travel inside shard
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

// ─── push() — main export ────────────────────────────────────────────────────

/**
 * Full push pipeline: pack → [encrypt] → RS-encode → upload → manifest → state.
 *
 * Partial-commit semantics: shard upload failures are captured per shard in
 * .bfs/push.lock and the manifest is written with whichever shards succeeded
 * (health: Degraded when uploaded >= N, Damaged when 1 <= uploaded < N,
 * throws when 0 uploaded). State.json is updated whenever at least one shard
 * uploaded; lock + cached blob are removed only on full success.
 *
 * @returns PushResult with version, file_count, total_size, skipped, uploaded_count, failed, health
 * @throws BfsError if config missing, password missing for encrypted vault, or zero shards uploaded
 * @throws LockConcurrentActiveError if another push or repair operation is in progress
 * @throws LockPartialStatePushError if a leftover push.lock from a crashed/dead run is detected
 * @throws PushCacheNoLockError when fromCache=true but push.lock or cached blob is missing
 * @throws PushSkippedError (non-interactive) if any source files could not be read
 */
export async function push(rootDir: string, options: PushOptions): Promise<PushResult> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('push_no_config'));
  assertSchemeValid(config);
  if (options.fromCache !== true) await assertNoActiveLock(rootDir, 'push');
  const state = await readState(rootDir);
  // First write after recovery: the config came from an untrusted location map,
  // so show the operator where shards will go and require confirmation before
  // uploading anything (defends against a recovered config pointing at an
  // attacker host). Cleared on the first confirmed push (see _writePushResults).
  if (state.locations_confirmed === false) {
    await confirmRecoveredLocations(config, options.io);
  }
  const { data_shards: N, parity_shards: K } = config.scheme;
  const { cacheDir, tempDir, cachePath } = await _resolvePushPaths({ rootDir, cacheDir: options.cacheDir, tempDir: options.tempDir, config });
  const targetVersion = await _resolveTargetVersion({ mode: options.mode, config, state, io: options.io });
  const lock = await _initPushLock(rootDir, options.fromCache === true, cachePath, targetVersion, config);
  const maxRamMb = options.maxRamMb ?? config.max_ram_mb;
  const shouldCompress = options.compressOverride !== undefined ? options.compressOverride : (config.compression?.enabled ?? true);
  // Bracket the pack window with two stat snapshots to detect files that change
  // on disk while packing (currency). Skipped for --cache: the blob comes from an
  // earlier pack, so there is no fresh window to bracket.
  const driftFilter = options.fromCache !== true ? createIgnoreFilter(rootDir) : null;
  const snapshotBefore = driftFilter ? await snapshotCatalog(rootDir, driftFilter) : null;
  const { blobSource, blobSize, file_count, total_size, skipped } = await _loadOrPackBlob({
    rootDir,
    cachePath,
    cacheDir,
    vaultIdBuf: uuidToBuffer(config.vault_id),
    fromCache: options.fromCache,
    shouldCompress,
    maxRamMb,
    N,
    K,
    io: options.io,
  });
  await _handleSkippedFiles({ skipped, cachePath, cacheDir, blobSource, interactive: options.interactive, io: options.io });
  if (driftFilter && snapshotBefore) {
    const snapshotAfter = await snapshotCatalog(rootDir, driftFilter);
    const drift = diffCatalog(snapshotBefore, snapshotAfter, new Set(skipped.map((s) => s.path)));
    await _handleCatalogDrift({ drift, allowDrift: options.allowDrift, interactive: options.interactive, io: options.io });
  }
  const { shouldEncrypt, kdf_salt, encKey } = await _deriveEncryptionKey({ config, password: options.password, io: options.io });
  const blob_hash = await _hashBlobWithoutChecksum(blobSource, blobSize);
  const stripeSize = computeStripeSize({ maxRamMb, N, K, blobSize });
  if (encKey && exceedsGcmPlaintextLimit(rawShardPayloadSize(blobSize, N, stripeSize))) {
    throw new BfsError(fmt('gcm_payload_too_large', String(GCM_MAX_PLAINTEXT_BYTES / 1024 ** 3)));
  }
  options.io.info(t('vault_encoding_rs'));
  const { parityPaths, shardHashes } = await _rsEncodeBlob({ blobSource, targetVersion, tempDir, N, K, stripeSize });
  const locationMap = _buildLocationMap({ config, targetVersion, shardHashes, io: options.io });
  options.io.info(t('vault_uploading_shards'));
  const providers = await openProviders(config, options.io);
  const { manifestShards } = await _uploadAllShards({
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
  });
  for (const pPath of parityPaths) await fs.unlink(pPath).catch(() => {});
  const health = _computeHealth(manifestShards.length, N, K);
  await _writePushResults({ rootDir, config, state, targetVersion, file_count, total_size, blob_hash, stripeSize, shouldEncrypt, shouldCompress, manifestShards, health, lock, cachePath, N, K });
  return { version: targetVersion, file_count, total_size, skipped, uploaded_count: manifestShards.length, failed: lock.failed, health };
}
