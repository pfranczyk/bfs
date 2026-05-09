import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  estimateBlobSize,
  packBlob,
  packBlobToFile,
  packBlobToFileZipped,
} from '../core/blob-pack.js';
import {
  parseBlobFileTable,
  parseBlobFileTableFromFile,
  unpackBlob,
  unpackBlobFromFile,
} from '../core/blob-unpack.js';
import { trackFile, untrackFile } from '../core/cleanup.js';
import {
  decryptBlob,
  decryptStream,
  deriveKey,
  deriveShardNonce,
  encryptStream,
  generateSalt,
} from '../core/crypto.js';
import type { SkippedFile } from '../core/errors.js';
import {
  BfsError,
  PullSkippedError,
  PushSkippedError,
} from '../core/errors.js';
import {
  hashBuffer,
  hashFileExcludingTail,
  hashStream,
  streamToBuffer,
} from '../core/hash.js';
import { createIgnoreFilter } from '../core/ignore.js';
import { DEFAULT_BFSIGNORE_CONTENT } from '../core/ignore-defaults.js';
import {
  calcShardPayloadSize,
  rsDecode,
  rsDecodeStriped,
  rsEncodeStriped,
  rsRepair,
} from '../core/reed-solomon.js';
import {
  buildShardStream,
  computeShardHeaderSize,
  parseShardHeaderFromStream,
  serializeShardHeader,
  uuidToBuffer,
} from '../core/shard-io.js';
import { debugEnabled } from '../debug.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type {
  ManifestShard,
  ProviderConfig,
  ProviderIO,
  PullResult,
  PushResult,
  ShardHeader,
  ShardLocation,
  StorageProvider,
  VaultConfig,
  VersionManifest,
} from '../types/index.js';
import { BLOB_FLAGS, PushMode, VersionHealth } from '../types/index.js';
import {
  checkVersionMismatch,
  detectMissingAdapters,
  formatMissingAdaptersMessage,
} from './adapter-preflight.js';
import { assertSchemeValid, readConfig, writeConfig } from './config.js';
import {
  deleteManifest,
  listManifests,
  readManifest,
  writeManifest,
} from './manifest.js';
import { DEFAULT_STATE, readState, writeState } from './state.js';

// ─── V2 pipeline constants ────────────────────────────────────────────────────

/** Legacy stripe size — used as fallback in pull/recovery for manifests without rs_stripe_size. */
const V2_STRIPE_SIZE = 64 * 1024 * 1024;
/** Minimum stripe size floor (16 MiB). */
const V2_MIN_STRIPE_SIZE = 16 * 1024 * 1024;
/** Maximum stripe size cap — keeps pull portable to 4 GB RAM systems (256 MiB). */
const V2_MAX_STRIPE_SIZE = 256 * 1024 * 1024;
/** packBlob() uses Buffer.concat — cap to avoid excessive RAM from double-buffering. */
const V2_MAX_BLOB_IN_RAM = 4 * 1024 * 1024 * 1024;

/** Resolves the RAM budget in bytes from user config or system auto-detect. */
function resolveRamBudget(maxRamMb: Nullable<number> | undefined): number {
  return maxRamMb != null
    ? maxRamMb * 1024 * 1024
    : Math.floor(os.totalmem() * 0.25);
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
  // Clamp RAM-based stripe to [MIN, MAX], but always cap at fromBlob.
  // For small blobs fromBlob < MIN is OK — stripe must equal payload size
  // so rsDecodeStriped computes numStripes=1.
  return Math.min(
    Math.max(V2_MIN_STRIPE_SIZE, Math.min(fromRam, V2_MAX_STRIPE_SIZE)),
    fromBlob,
  );
}

/**
 * Computes the RAM threshold for keeping the blob in memory vs writing to disk.
 * Reserves only the actual RS encoding overhead: (N+K) × V2_MAX_STRIPE_SIZE.
 */
function computeRamThreshold(
  maxRamMb: Nullable<number> | undefined,
  N: number,
  K: number,
): number {
  const ramBytes = resolveRamBudget(maxRamMb);
  const rsOverhead = (N + K) * V2_MAX_STRIPE_SIZE;
  return Math.min(Math.max(0, ramBytes - rsOverhead), V2_MAX_BLOB_IN_RAM);
}

// ─── Option types ─────────────────────────────────────────────────────────────

export interface InitOptions {
  vault_name: string;
  scheme: { data_shards: number; parity_shards: number };
  encryption: { enabled: boolean; algorithm: 'aes-256-gcm'; kdf: 'argon2id' };
  /** Defaults to `{ enabled: true, algorithm: 'deflate' }` when omitted. */
  compression?: { enabled: boolean; algorithm: 'deflate' };
  providers: ProviderConfig[];
  push_mode: PushMode;
  /** RAM limit for RS encoding (MB). null = auto (25% os.totalmem()). */
  max_ram_mb?: Nullable<number>;
  io: ProviderIO;
}

export interface PushOptions {
  /** Overrides config.push_mode. If absent, config.push_mode is used. */
  mode?: PushMode.NewVersion | PushMode.Overwrite;
  /**
   * Override compression for this push only.
   * true  = force compress (even if config.compression.enabled=false)
   * false = force skip compression (even if config.compression.enabled=true)
   * undefined = use config.compression.enabled
   */
  compressOverride?: boolean;
  /** Pre-provided encryption password (skips interactive prompt). */
  password?: string;
  /**
   * When true, loads the blob from `.bfs/cache/push.blob.pending` instead of re-packing.
   * Falls back to a fresh pack if the cache file does not exist.
   */
  fromCache?: boolean;
  /**
   * When true (REPL mode), prompts the user on skipped files instead of aborting.
   * Defaults to false (standalone CLI: abort with PushSkippedError).
   */
  interactive?: boolean;
  /** Directory for temporary parity files during push. Defaults to cacheDir. */
  tempDir?: string;
  /** Overrides cache directory for push.blob.pending. Defaults to {rootDir}/.bfs/cache. */
  cacheDir?: string;
  /** Overrides config.max_ram_mb for this push operation. */
  maxRamMb?: number;
  io: ProviderIO;
}

export interface PullOptions {
  /** Target version to restore; defaults to latest_version. */
  version?: number;
  /** If true, skip confirmation prompts. */
  force?: boolean;
  /** If true, auto-confirm the overwrite prompt without clearing the directory (unlike force). */
  yes?: boolean;
  /** Pre-provided decryption password (skips interactive prompt). */
  password?: string;
  /**
   * When true, loads the blob from `.bfs/cache/pull.blob.pending` instead of downloading shards.
   * Falls back to a fresh pull if the cache file does not exist.
   */
  fromCache?: boolean;
  /**
   * When true (REPL mode), prompts the user on skipped files and allows retry instead of aborting.
   * Defaults to false (standalone CLI: abort with PullSkippedError).
   */
  interactive?: boolean;
  /** Directory for temporary files during pull. Defaults to output dir. */
  tempDir?: string;
  /** Overrides cache directory for pull.blob.pending. Defaults to {rootDir}/.bfs/cache. */
  cacheDir?: string;
  /**
   * When true, pull continues even if some external adapters are missing
   * and Reed-Solomon redundancy can decode from whatever providers remain
   * reachable. Missing built-in providers (local, ftp) always abort —
   * their absence indicates a broken BFS installation, not a plugin gap.
   */
  allowMissingAdapters?: boolean;
  io: ProviderIO;
}

export interface PruneOptions {
  /** Version numbers to remove from providers and disk. */
  versions: number[];
}

export interface RemoveProviderOptions {
  strategy: 'relocate' | 'rebuild' | 'remove';
  /** 'relocate': new connection config for the existing provider. */
  newConnectionConfig?: Record<string, unknown>;
  /** 'relocate': new provider type (when existing type is invalid/unknown). */
  newType?: string;
  /** 'rebuild': target provider id that will receive repaired shards. */
  targetProviderId?: string;
  /** 'rebuild': which versions to rebuild. Defaults to 'all'. */
  rebuildScope?: number[] | 'all' | 'latest';
  /** Password for encrypted vaults (heal / relocate). */
  password?: string;
  io: ProviderIO;
}

export interface StatusInfo {
  vault_name: string;
  latest_version: number;
  working_version: number;
  provider_count: number;
  scheme: { data_shards: number; parity_shards: number };
  encryption_enabled: boolean;
}

// ─── V2 streaming helpers ─────────────────────────────────────────────────────

/**
 * Async generator that yields striped shard chunks for shard `shardIndex`.
 * For each stripe s, emits `stripeSize` bytes from position `s*N*stripeSize + shardIndex*stripeSize`
 * in the source. The last stripe is zero-padded if the source is shorter.
 *
 * @param source     - Packed blob as Buffer (RAM path) or file path (disk path)
 * @param blobSize   - Total blob byte count
 * @param shardIndex - Which data shard (0..N-1)
 * @param N          - Number of data shards
 * @param stripeSize - Bytes per shard per stripe
 */
async function* _stripedShardChunks(
  source: Buffer | string,
  blobSize: number,
  shardIndex: number,
  N: number,
  stripeSize: number,
): AsyncGenerator<Buffer> {
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
          await fh.read(
            chunk,
            0,
            Math.min(stripeSize, blobSize - shardStart),
            shardStart,
          );
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
function _stripedShardStream(
  source: Buffer | string,
  blobSize: number,
  shardIndex: number,
  N: number,
  stripeSize: number,
): Readable {
  return Readable.from(
    _stripedShardChunks(source, blobSize, shardIndex, N, stripeSize),
  );
}

/** Validates that a configured directory (or its parent) exists before use. */
async function _validateConfigDir(
  dir: string,
  configFlag: string,
): Promise<void> {
  const target = path.dirname(dir) === dir ? dir : path.dirname(dir);
  try {
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      throw new BfsError(
        `${t('path_not_dir')}: ${dir}\n  ${fmt('config_dir_hint', configFlag, configFlag)}`,
      );
    }
  } catch (e: unknown) {
    if (e instanceof BfsError) throw e;
    throw new BfsError(
      `${fmt('dir_not_exist', dir)}\n  ${fmt('config_dir_hint', configFlag, configFlag)}`,
    );
  }
}

/**
 * Hashes the plain blob content (all bytes except the trailing 32-byte SHA-256 checksum).
 *
 * @param source - Packed blob as Buffer (RAM) or file path (disk)
 * @param size   - Total blob byte count (including the 32-byte checksum)
 * @returns SHA-256 hex string of blob[0..size-32]
 */
async function _hashBlobWithoutChecksum(
  source: Buffer | string,
  size: number,
): Promise<string> {
  if (Buffer.isBuffer(source)) {
    return hashBuffer(source.subarray(0, size - 32));
  }
  // createReadStream `end` is inclusive (0-indexed) → size-33 reads exactly size-32 bytes
  return hashStream(createReadStream(source, { start: 0, end: size - 33 }));
}

// ─── Shard failure diagnostics ───────────────────────────────────────────────

type ShardFailureReason = 'provider_unreachable' | 'file_missing';

/**
 * Emits appropriate degradation warnings based on shard failure reasons.
 */
function _emitDegradedWarnings(
  failures: Map<number, ShardFailureReason>,
  io: ProviderIO,
): void {
  const reasons = [...failures.values()];
  if (reasons.some((r) => r === 'provider_unreachable')) {
    io.warn(t('vault_degraded_provider_unreachable'));
  }
  if (reasons.some((r) => r === 'file_missing')) {
    io.warn(t('vault_degraded_file_missing'));
  }
}

/**
 * Phase 1 of V2 pull: downloads all available shards to temp files.
 * Parses each shard header to extract `blobSize` and `kdf_salt`.
 * Populates `tmpPaths` map with shard_index → tmpPath for successfully downloaded shards.
 *
 * @returns blobSize, kdf_salt, and failures map with reasons for each failed shard
 */
async function _downloadShardsToTempFiles(
  config: VaultConfig,
  manifest: VersionManifest,
  options: PullOptions,
  tmpDir: string,
  tmpPaths: Map<number, string>,
): Promise<{
  blobSize: number;
  kdf_salt: Nullable<Buffer>;
  failures: Map<number, ShardFailureReason>;
}> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const targetVersion = manifest.version;
  let blobSize = 0;
  let kdf_salt: Nullable<Buffer> = null;
  const failures = new Map<number, ShardFailureReason>();
  options.io.info(fmt('vault_download_shards', String(targetVersion)));
  for (const ms of manifest.shards) {
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) {
      options.io.warn(
        fmt('vault_provider_not_found', ms.provider_id, String(ms.shard_index)),
      );
      continue;
    }
    // Check provider health BEFORE authenticate to avoid interactive prompts
    // (e.g. LocalFS asking to create a missing directory during pull)
    const probe = providerRegistry.create(pc, options.io);
    if (!(await probe.healthCheck())) {
      failures.set(ms.shard_index, 'provider_unreachable');
      options.io.warn(fmt('vault_provider_unreachable', pc.id));
      continue;
    }
    try {
      const provider = providerRegistry.create(pc, options.io);
      await provider.authenticate();
      provider.setVaultName(config.vault_name);
      const stream = await provider.download({
        provider_id: ms.provider_id,
        path: `shard_${ms.shard_index}.bfs.${targetVersion}`,
      });
      const tmpPath = path.join(tmpDir, `shard_${ms.shard_index}`);
      await pipeline(stream, createWriteStream(tmpPath));
      if (debugEnabled) {
        const stat = await fs.stat(tmpPath);
        process.stderr.write(
          `[bfs:debug] shard ${ms.shard_index} downloaded: ${stat.size} bytes\n`,
        );
      }
      // Parse header from stable temp file — destroy both payload stream and the
      // underlying file stream to stop the orphaned background SHA-256 task from
      // holding the file handle open (prevents cleanup failure on Windows).
      const fs1 = createReadStream(tmpPath);
      const { header, payloadStream } = await parseShardHeaderFromStream(fs1);
      payloadStream.on('error', () => {}).destroy();
      fs1.destroy();
      if (blobSize === 0) {
        blobSize = Number(header.blob_size);
        kdf_salt = header.kdf_salt;
      }
      tmpPaths.set(ms.shard_index, tmpPath);
      options.io.progress(
        fmt(
          'vault_download_shard_progress',
          String(ms.shard_index + 1),
          String(N + K),
        ),
        ((ms.shard_index + 1) / (N + K)) * 100,
      );
    } catch {
      failures.set(ms.shard_index, 'file_missing');
      options.io.warn(fmt('vault_file_missing_on_provider', pc.id));
    }
  }
  if (debugEnabled) {
    const indices = [...tmpPaths.keys()].sort((a, b) => a - b);
    process.stderr.write(
      `[bfs:debug] download done: shards=[${indices.join(',')}] blobSize=${blobSize} kdf_salt=${kdf_salt !== null ? 'yes' : 'null'}\n`,
    );
  }
  return { blobSize, kdf_salt, failures };
}

/**
 * Phase 2 of V2 pull: opens fresh streams from temp files, RS-decodes, writes blob.
 * Each shard stream is opened independently — no cross-stream race conditions.
 *
 * @param tmpPaths      - Map of shard_index → temp file path (only present shards)
 * @param N             - Number of data shards
 * @param K             - Number of parity shards
 * @param stripeSize    - Bytes per shard per stripe (from manifest or V2_STRIPE_SIZE)
 * @param blobSize      - Total blob byte count (from shard header)
 * @param targetVersion - Version being decoded (used to derive per-shard nonce)
 * @param encKey        - AES-256-GCM key for per-shard decryption; undefined if not encrypted
 * @param outputPath    - Destination file for the decoded blob
 * @param io            - ProviderIO for progress messages
 */
async function _decodeFromTempFiles(
  tmpPaths: Map<number, string>,
  N: number,
  K: number,
  stripeSize: number,
  blobSize: number,
  targetVersion: number,
  encKey: Buffer | undefined,
  outputPath: string,
  io: ProviderIO,
): Promise<void> {
  const payloadStreams: Nullable<Readable>[] = new Array(N + K).fill(null);
  for (const [shardIdx, tmpPath] of tmpPaths) {
    const fileStream = createReadStream(tmpPath);
    const { payloadStream } = await parseShardHeaderFromStream(fileStream);
    payloadStreams[shardIdx] = encKey
      ? decryptStream(
          payloadStream,
          encKey,
          deriveShardNonce(encKey, targetVersion, shardIdx),
        )
      : payloadStream;
  }
  if (debugEnabled) {
    const active = payloadStreams
      .map((s, i) => (s !== null ? String(i) : null))
      .filter((x): x is string => x !== null);
    const nulls = payloadStreams
      .map((s, i) => (s === null ? String(i) : null))
      .filter((x): x is string => x !== null);
    process.stderr.write(
      `[bfs:debug] _decodeFromTempFiles: active=[${active.join(',')}] null=[${nulls.join(',')}]\n`,
    );
  }
  io.info(t('vault_decoding_rs'));
  const debugLog = debugEnabled
    ? (msg: string) => {
        process.stderr.write(`[bfs:debug] ${msg}\n`);
      }
    : undefined;
  const blobStream = rsDecodeStriped(
    payloadStreams,
    N,
    K,
    stripeSize,
    blobSize,
    debugLog,
  );
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await pipeline(blobStream, createWriteStream(outputPath));
}

/**
 * V2 pull path: two-phase approach — first downloads all shards to temp files,
 * then opens fresh file streams for RS decode. Eliminates race conditions between
 * background SHA-256 verification and rsDecodeStriped that caused `got=0` on last stripe.
 *
 * @param config     - Vault configuration with provider list
 * @param manifest   - Version manifest describing the shards to download
 * @param options    - Pull options including io, password, and tempDir
 * @param outputPath - Destination file for the decoded blob
 * @returns { isDegraded } — true if fewer than N+K shards were available
 * @throws BfsError if fewer than N shards available, password missing, or kdf_salt not found
 */
async function _pullV2(
  config: VaultConfig,
  manifest: VersionManifest,
  options: PullOptions,
  outputPath: string,
): Promise<{
  isDegraded: boolean;
  failures: Map<number, ShardFailureReason>;
}> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const targetVersion = manifest.version;
  const stripeSize = manifest.rs_stripe_size ?? V2_STRIPE_SIZE;
  // tmpDir inside cache dir (or user-specified tempDir) — cleaned up in finally
  const tmpBase =
    options.tempDir ?? config.temp_dir ?? path.dirname(outputPath);
  await _validateConfigDir(tmpBase, 'temp-dir');
  const tmpDir = path.join(tmpBase, `pull-v2-${targetVersion}-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPaths = new Map<number, string>();
  try {
    const { blobSize, kdf_salt, failures } = await _downloadShardsToTempFiles(
      config,
      manifest,
      options,
      tmpDir,
      tmpPaths,
    );
    if (tmpPaths.size < N)
      throw new BfsError(
        `Not enough shards: need ${N}, got ${tmpPaths.size}. Some providers may be offline.`,
      );
    if (blobSize === 0)
      throw new BfsError('Could not read blob size from any shard header.');
    const shardSize = calcShardPayloadSize(blobSize, N);
    const numStripes = Math.ceil(shardSize / stripeSize);
    if (debugEnabled) {
      process.stderr.write(
        `[bfs:debug] _pullV2: blobSize=${blobSize} stripeSize=${stripeSize}` +
          ` shardSize=${shardSize} numStripes=${numStripes}` +
          ` encrypted=${manifest.encrypted} N=${N} K=${K}\n`,
      );
    }
    let encKey: Buffer | undefined;
    if (manifest.encrypted) {
      let password: Nullable<string> = options.password ?? null;
      if (!password)
        password = await options.io.askSecret(t('vault_ask_decrypt_password'));
      if (!password)
        throw new BfsError('Password required for encrypted vault.');
      if (!kdf_salt)
        throw new BfsError('kdf_salt not found in any shard header.');
      options.io.info(t('vault_decrypting'));
      encKey = await deriveKey(password, kdf_salt);
    }
    await _decodeFromTempFiles(
      tmpPaths,
      N,
      K,
      stripeSize,
      blobSize,
      targetVersion,
      encKey,
      outputPath,
      options.io,
    );
    return { isDegraded: tmpPaths.size < N + K, failures };
  } finally {
    for (const [, p] of tmpPaths) await fs.unlink(p).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Builds the remote_path for a shard on a given provider.
 * Uses forward slashes: {config.path}/{vault_name}/{filename}.
 */
export function buildRemotePath(
  providerConfig: ProviderConfig,
  vaultName: string,
  filename: string,
): string {
  const base = String(providerConfig.config.path ?? '');
  return [base, vaultName, filename].join('/').replace(/\\/g, '/');
}

/** Creates, authenticates, and sets vault name on all providers in config. */
async function openProviders(
  config: VaultConfig,
  io: ProviderIO,
): Promise<StorageProvider[]> {
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
 * Extracts the RS payload bytes from a raw shard buffer without decrypting.
 * Returns the bytes between the header and the trailing 32-byte checksum.
 */
export function extractShardPayload(data: Buffer): Buffer {
  const headerSize = computeShardHeaderSize(data);
  return data.subarray(headerSize, data.length - 32);
}

/**
 * Downloads available shard payloads for a given manifest version.
 * Checks the local cache first; falls back to provider download.
 * Validates each shard's hash and header metadata before accepting it.
 *
 * @returns shardSlots (null where unavailable), blobSize, and kdf_salt from the first valid shard
 */
async function downloadShardSlots(
  config: VaultConfig,
  manifest: VersionManifest,
  rootDir: string,
  io: ProviderIO,
): Promise<{
  shardSlots: Nullable<Buffer>[];
  blobSize: number;
  kdf_salt: Nullable<Buffer>;
  failures: Map<number, ShardFailureReason>;
}> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const targetVersion = manifest.version;
  const cacheDir = path.join(rootDir, '.bfs', 'cache');
  const shardSlots: Nullable<Buffer>[] = new Array(N + K).fill(null);
  let blobSize = 0;
  let kdf_salt: Nullable<Buffer> = null;
  const failures = new Map<number, ShardFailureReason>();

  for (const ms of manifest.shards) {
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) {
      io.warn(
        `Provider "${ms.provider_id}" not found in config — skipping shard ${ms.shard_index}`,
      );
      continue;
    }
    const probe = providerRegistry.create(pc, io);
    if (!(await probe.healthCheck())) {
      failures.set(ms.shard_index, 'provider_unreachable');
      io.warn(fmt('vault_provider_unreachable', pc.id));
      continue;
    }
    try {
      const shardData = await fetchShard(
        pc,
        ms,
        config,
        cacheDir,
        targetVersion,
        io,
      );
      if (!shardData) continue;
      const { header: meta } = await parseShardHeaderFromStream(
        Readable.from(shardData),
      );
      if (
        meta.shard_index !== ms.shard_index ||
        meta.version !== targetVersion ||
        meta.vault_id !== config.vault_id
      ) {
        io.warn(`Shard ${ms.shard_index} header validation failed — skipping`);
        continue;
      }
      shardSlots[ms.shard_index] = extractShardPayload(shardData);
      if (blobSize === 0) blobSize = Number(meta.blob_size);
      if (!kdf_salt && meta.kdf_salt) kdf_salt = meta.kdf_salt;
      io.progress(
        `Downloading shard ${ms.shard_index + 1}/${N + K}`,
        ((ms.shard_index + 1) / (N + K)) * 100,
      );
    } catch {
      failures.set(ms.shard_index, 'file_missing');
      io.warn(fmt('vault_file_missing_on_provider', pc.id));
    }
  }
  return { shardSlots, blobSize, kdf_salt, failures };
}

/**
 * Fetches a single shard: tries the local cache first, then downloads from the provider.
 * Validates the payload hash. Returns null if the shard should be skipped.
 */
async function fetchShard(
  pc: ProviderConfig,
  ms: ManifestShard,
  config: VaultConfig,
  cacheDir: string,
  targetVersion: number,
  io: ProviderIO,
): Promise<Nullable<Buffer>> {
  const filename = `shard_${ms.shard_index}.bfs.${targetVersion}`;
  const cacheFile = path.join(cacheDir, filename);

  // Try cache first — avoid network round-trip if payload hash matches
  try {
    const cached = await fs.readFile(cacheFile);
    if (hashBuffer(extractShardPayload(cached)) === ms.shard_hash)
      return cached;
    await fs.unlink(cacheFile).catch(() => {});
  } catch {
    // cache miss — proceed to provider download
  }

  const provider = providerRegistry.create(pc, io);
  await provider.authenticate();
  provider.setVaultName(config.vault_name);
  const shardStream = await provider.download({
    provider_id: ms.provider_id,
    path: filename,
  });
  const shardData = await streamToBuffer(shardStream);
  if (hashBuffer(extractShardPayload(shardData)) !== ms.shard_hash) {
    io.warn(`Shard ${ms.shard_index} hash mismatch on download — skipping`);
    return null;
  }
  return shardData;
}

/**
 * RS-decodes the shard slots into a single blob and optionally decrypts it.
 * In degraded mode (some slots null), runs RS repair and caches the repaired shards.
 * If the vault is encrypted, prompts for the password (unless already provided in options).
 *
 * @throws BfsError if fewer than N shards are available, password is missing, or kdf_salt not found
 */
async function decodeAndDecrypt(
  shardSlots: Nullable<Buffer>[],
  manifest: VersionManifest,
  kdf_salt: Nullable<Buffer>,
  blobSize: number,
  targetVersion: number,
  cacheDir: string,
  options: PullOptions,
): Promise<{ plainBlob: Buffer; isDegraded: boolean }> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const isDegraded = shardSlots.some((s) => s === null);
  let rsOutput: Buffer;

  if (isDegraded) {
    options.io.info('Pool degraded — performing RS repair…');
    const repaired = rsRepair(shardSlots, N, K);
    await fs.mkdir(cacheDir, { recursive: true });
    for (let i = 0; i < N + K; i++) {
      if (shardSlots[i] === null) {
        const repairedShard = repaired[i];
        if (!repairedShard) continue;
        await fs
          .writeFile(
            path.join(cacheDir, `shard_${i}.bfs.${targetVersion}.repaired`),
            repairedShard,
          )
          .catch(() => {});
      }
    }
    rsOutput = rsDecode(
      repaired.map((b) => b as Nullable<Buffer>),
      N,
      K,
      blobSize,
    );
  } else {
    rsOutput = rsDecode(shardSlots, N, K, blobSize);
  }

  if (!manifest.encrypted) return { plainBlob: rsOutput, isDegraded };

  let password: Nullable<string> = options.password ?? null;
  if (!password)
    password = await options.io.askSecret('Enter decryption password:');
  if (!password) throw new BfsError('Password required for encrypted vault.');
  if (!kdf_salt) throw new BfsError('kdf_salt not found in any shard header.');
  options.io.info('Decrypting…');
  return {
    plainBlob: await decryptBlob(rsOutput, password, kdf_salt),
    isDegraded,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Initialises a new vault in rootDir.
 * Creates .bfs/, .bfs/manifests/, config.json, state.json.
 * Writes default .bfsignore if missing.
 * Authenticates each provider to surface configuration errors early.
 *
 * @throws BfsError if providers.length !== data_shards + parity_shards.
 */
export async function init(
  rootDir: string,
  options: InitOptions,
): Promise<void> {
  const { data_shards: N, parity_shards: K } = options.scheme;
  if (options.providers.length !== N + K) {
    throw new BfsError(
      `Scheme requires ${N + K} providers, got ${options.providers.length}.`,
    );
  }

  await fs.mkdir(path.join(rootDir, '.bfs', 'manifests'), { recursive: true });

  const bfsignorePath = path.join(rootDir, '.bfsignore');
  const bfsignoreExists = await fs
    .access(bfsignorePath)
    .then(() => true)
    .catch(() => false);
  if (!bfsignoreExists) {
    await fs.writeFile(bfsignorePath, DEFAULT_BFSIGNORE_CONTENT, 'utf-8');
  }

  // Validate and authenticate all providers BEFORE writing config.
  // This ensures we never leave a corrupted config on disk if a provider
  // type is unknown or authentication fails.
  for (const pc of options.providers) {
    const p = providerRegistry.create(pc, options.io);
    await p.authenticate();
    p.setVaultName(options.vault_name);
  }

  const config: VaultConfig = {
    vault_id: randomUUID(),
    vault_name: options.vault_name,
    version: 1,
    scheme: options.scheme,
    encryption: options.encryption,
    compression: options.compression ?? { enabled: true, algorithm: 'deflate' },
    push_mode: options.push_mode,
    providers: options.providers,
    max_ram_mb: options.max_ram_mb ?? null,
  };

  await writeConfig(rootDir, config);
  await writeState(rootDir, { ...DEFAULT_STATE });
}

/**
 * Full push pipeline: pack → [encrypt] → RS-encode → upload → write manifest → update state.
 * If any files could not be read, the blob is cached and PushSkippedError is thrown (non-interactive),
 * or the user is prompted to continue (interactive/REPL mode).
 * With `fromCache: true`, loads the cached blob instead of re-packing.
 *
 * @returns PushResult with version, file_count, total_size, and any skipped files accepted by user
 * @throws BfsError if config missing, provider count invalid, or password missing for encrypted vault
 * @throws PushSkippedError (non-interactive) if any files could not be read
 */
export async function push(
  rootDir: string,
  options: PushOptions,
): Promise<PushResult> {
  const config = await readConfig(rootDir);
  if (!config)
    throw new BfsError('No vault config found. Run `bfs init` first.');

  assertSchemeValid(config);
  const state = await readState(rootDir);
  const { data_shards: N, parity_shards: K } = config.scheme;

  // ── Validate configured directories early (before any prompts) ────────────
  const cacheDir =
    options.cacheDir ?? config.cache_dir ?? path.join(rootDir, '.bfs', 'cache');
  await _validateConfigDir(cacheDir, 'cache-dir');
  await fs.mkdir(cacheDir, { recursive: true });
  const tempDir = options.tempDir ?? config.temp_dir ?? cacheDir;
  if (tempDir !== cacheDir) await _validateConfigDir(tempDir, 'temp-dir');

  // ── Decide target version ──────────────────────────────────────────────────
  const effectiveMode = options.mode ?? config.push_mode;
  let targetVersion: number;

  if (effectiveMode === PushMode.Overwrite && state.working_version > 0) {
    targetVersion = state.working_version;
  } else if (effectiveMode === PushMode.Ask) {
    const choice = await options.io.choose(
      `Create new version v${state.latest_version + 1} or overwrite v${state.working_version}?`,
      [
        `New version (v${state.latest_version + 1})`,
        `Overwrite (v${state.working_version})`,
      ],
    );
    targetVersion = choice.startsWith('Overwrite')
      ? state.working_version
      : state.latest_version + 1;
  } else {
    targetVersion = state.latest_version + 1;
  }

  if (
    state.working_version > 0 &&
    state.working_version < state.latest_version
  ) {
    const cont = await options.io.confirm(
      fmt(
        'vault_push_version_confirm',
        String(state.working_version),
        String(state.latest_version),
        String(targetVersion),
      ),
    );
    if (!cont) throw new BfsError('Push cancelled.');
  }

  // ── Pack blob ──────────────────────────────────────────────────────────────
  const cachePath = path.join(cacheDir, 'push.blob.pending');
  const filter = createIgnoreFilter(rootDir);
  const vaultIdBuf = uuidToBuffer(config.vault_id);

  // source: in-memory Buffer (RAM path) or file path string (disk path)
  let blobSource: Buffer | string = Buffer.alloc(0);
  let blobSize = 0;
  let file_count = 0;
  let total_size = 0;
  let skipped: SkippedFile[] = [];
  let cacheLoaded = false;

  if (options.fromCache) {
    try {
      const stat = await fs.stat(cachePath);
      const cacheBlob = await fs.readFile(cachePath);
      const cacheFlags = cacheBlob.readUInt32LE(0x16);
      const isCacheCompressed = (cacheFlags & BLOB_FLAGS.COMPRESSED) !== 0;
      if (isCacheCompressed) {
        // Compressed blob: actual file_count/total_size not recoverable without extracting ZIP
        file_count = 0;
        total_size = 0;
      } else {
        const cacheEntries = parseBlobFileTable(cacheBlob);
        file_count = cacheEntries.length;
        total_size = cacheEntries.reduce((s, e) => s + Number(e.size), 0);
      }
      blobSource = cacheBlob;
      blobSize = stat.size;
      cacheLoaded = true;
      options.io.info(t('vault_using_cached_blob'));
    } catch {
      options.io.info(t('vault_no_cached_blob_push'));
    }
  }

  const maxRamMb = options.maxRamMb ?? config.max_ram_mb;

  const shouldCompress =
    options.compressOverride !== undefined
      ? options.compressOverride
      : (config.compression?.enabled ?? true);

  if (!cacheLoaded) {
    await fs.unlink(cachePath).catch(() => {});
    options.io.info(t('init_scanning'));

    if (shouldCompress) {
      // Compression always uses disk path (ZIP is built in one pass)
      options.io.info(t('vault_compressing'));
      await fs.mkdir(cacheDir, { recursive: true });
      trackFile(cachePath);
      const result = await packBlobToFileZipped(
        rootDir,
        cachePath,
        filter,
        vaultIdBuf,
      );
      blobSource = cachePath;
      blobSize = result.blobSize;
      file_count = result.fileCount;
      total_size = result.totalSize;
      skipped = result.skipped;
    } else {
      const estimated = await estimateBlobSize(rootDir, filter);
      const ramThreshold = computeRamThreshold(maxRamMb, N, K);
      let useRamPath = estimated < ramThreshold;

      // Pre-allocate to verify RAM availability; fall back to disk on OOM
      if (useRamPath) {
        try {
          Buffer.alloc(estimated);
        } catch {
          useRamPath = false;
        }
      }

      if (useRamPath) {
        const result = await packBlob(rootDir, filter, vaultIdBuf);
        const ramEntries = parseBlobFileTable(result.blob);
        blobSource = result.blob;
        blobSize = result.blob.length;
        file_count = ramEntries.length;
        total_size = ramEntries.reduce((s, e) => s + Number(e.size), 0);
        skipped = result.skipped;
      } else {
        await fs.mkdir(cacheDir, { recursive: true });
        trackFile(cachePath);
        const result = await packBlobToFile(
          rootDir,
          cachePath,
          filter,
          vaultIdBuf,
        );
        blobSource = cachePath;
        blobSize = result.blobSize;
        file_count = result.fileCount;
        total_size = result.totalSize;
        skipped = result.skipped;
      }
    }
  }

  // ── Handle skipped files ───────────────────────────────────────────────────
  if (skipped.length > 0) {
    // Ensure blob is on disk so the user can resume with --cache
    if (Buffer.isBuffer(blobSource)) {
      await fs.mkdir(cacheDir, { recursive: true });
      trackFile(cachePath);
      await fs.writeFile(cachePath, blobSource);
    }

    if (options.interactive) {
      const shown = skipped.slice(0, 10);
      const rest = skipped.length - shown.length;
      const fileList =
        shown.map((s) => `  - ${s.path}: ${s.reason}`).join('\n') +
        (rest > 0 ? `\n  ... and ${rest} more` : '');
      const cont = await options.io.confirm(
        fmt('vault_push_skipped_confirm', String(skipped.length), fileList),
      );
      if (!cont) {
        untrackFile(cachePath);
        await fs.unlink(cachePath).catch(() => {});
        throw new BfsError('Push cancelled.');
      }
      // User confirmed skipped files: keep cache, continue push
      untrackFile(cachePath);
    } else {
      // Non-interactive: keep cache for --cache retry — untrack so SIGINT won't delete it
      untrackFile(cachePath);
      throw new PushSkippedError(skipped, cachePath);
    }
  }

  // ── Derive encryption key (per-shard) ─────────────────────────────────────
  const shouldEncrypt = config.encryption.enabled || !!options.password;
  let kdf_salt: Nullable<Buffer> = null;
  let encKey: Buffer | undefined;
  if (shouldEncrypt) {
    if (!config.encryption.enabled && options.password) {
      options.io.warn(t('vault_password_overrides_config'));
    }
    let password: Nullable<string> = options.password ?? null;
    if (!password) {
      password = await options.io.askSecret(t('vault_ask_encrypt_password'));
      if (!password)
        throw new BfsError('Password required for encrypted vault.');
      const confirm = await options.io.askSecret(
        t('vault_ask_confirm_password'),
      );
      if (confirm !== password) throw new BfsError('Passwords do not match.');
    }
    kdf_salt = generateSalt();
    encKey = await deriveKey(password, kdf_salt);
    options.io.info(t('vault_encrypting'));
  }

  // ── Compute blob_hash ──────────────────────────────────────────────────────
  const blob_hash = await _hashBlobWithoutChecksum(blobSource, blobSize);

  // Dynamic stripe size: based on RAM budget, capped for portability (256 MiB max).
  // Still scales down for small blobs so rsDecodeStriped computes numStripes=1.
  const stripeSize = computeStripeSize({ maxRamMb, N, K, blobSize });

  // ── Reed-Solomon encode (striped) ──────────────────────────────────────────
  options.io.info(t('vault_encoding_rs'));
  const parityPaths: string[] = Array.from({ length: K }, (_, j) =>
    path.join(tempDir, `bfs-parity-${targetVersion}-${j}-${Date.now()}.tmp`),
  );
  const rsSourceStream: Readable = Buffer.isBuffer(blobSource)
    ? Readable.from(blobSource)
    : createReadStream(blobSource);
  const { dataShardHashes, parityShardHashes } = await rsEncodeStriped(
    rsSourceStream,
    parityPaths,
    N,
    K,
    stripeSize,
  );
  const shardHashes = [...dataShardHashes, ...parityShardHashes];

  // ── Build location map ─────────────────────────────────────────────────────
  const locationMap: ShardLocation[] = config.providers.map((pc, i) => ({
    shard_index: i,
    provider_id: pc.id,
    provider_type: pc.type,
    adapterPackage: pc.adapterPackage,
    connection_config: pc.config,
    remote_path: buildRemotePath(
      pc,
      config.vault_name,
      `shard_${i}.bfs.${targetVersion}`,
    ),
    shard_hash: shardHashes[i] ?? '',
  }));

  // ── Upload shards ──────────────────────────────────────────────────────────
  options.io.info(t('vault_uploading_shards'));
  const providers = await openProviders(config, options.io);
  const manifestShards: ManifestShard[] = [];
  // Raw striped payload size per shard (before encryption)
  const numStripes = Math.ceil(blobSize / (N * stripeSize));
  const rawPayloadSize = numStripes * stripeSize;
  // AES-GCM adds a 16-byte authentication tag at end of stream
  const encPayloadSize = encKey ? rawPayloadSize + 16 : rawPayloadSize;

  for (let i = 0; i < N + K; i++) {
    const pc = config.providers[i];
    if (!pc)
      throw new BfsError(`Internal: provider config missing for index ${i}`);

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
    const rawPayload: Readable =
      i < N
        ? _stripedShardStream(blobSource, blobSize, i, N, stripeSize)
        : createReadStream(parityPath ?? '');

    const payloadStream = encKey
      ? encryptStream(
          rawPayload,
          encKey,
          deriveShardNonce(encKey, targetVersion, i),
        )
      : rawPayload;
    const shardStream = buildShardStream(serializedHeader, payloadStream);
    const shardFileSize = serializedHeader.length + encPayloadSize + 32;

    await providers[i]?.upload(
      `shard_${i}.bfs.${targetVersion}`,
      shardStream,
      shardFileSize,
    );
    options.io.progress(
      fmt('vault_upload_shard_progress', String(i + 1), String(N + K)),
      ((i + 1) / (N + K)) * 100,
    );
    manifestShards.push({
      shard_index: i,
      provider_id: pc.id,
      provider_type: pc.type,
      remote_path: buildRemotePath(
        pc,
        config.vault_name,
        `shard_${i}.bfs.${targetVersion}`,
      ),
      shard_hash: shardHashes[i] ?? '',
    });
  }

  // ── Clean up temp parity files ─────────────────────────────────────────────
  for (const pPath of parityPaths) {
    await fs.unlink(pPath).catch(() => {});
  }

  // ── Write manifest ─────────────────────────────────────────────────────────
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
    ...(shouldCompress
      ? { compressed: true as const, blob_size_uncompressed: total_size }
      : {}),
    shards: manifestShards,
    health: VersionHealth.Healthy,
  };
  await writeManifest(rootDir, manifest);

  // ── Update state ───────────────────────────────────────────────────────────
  await writeState(rootDir, {
    latest_version: Math.max(state.latest_version, targetVersion),
    working_version: targetVersion,
  });

  // ── Clean up blob cache on success ─────────────────────────────────────────
  untrackFile(cachePath);
  await fs.unlink(cachePath).catch(() => {});

  return { version: targetVersion, file_count, total_size, skipped };
}

/**
 * Pull Mode A: restores a specific version to rootDir using the current config.
 * Reads shards from providers listed in the version manifest.
 * Tolerates up to K missing/unreachable providers (RS repair).
 * If files cannot be written, the decoded blob is cached and PullSkippedError is thrown
 * (non-interactive), or the user is prompted to retry (interactive/REPL mode).
 * With `fromCache: true`, loads the cached blob instead of downloading shards.
 *
 * @param rootDir - Absolute path to the vault working directory
 * @param options - Pull options: version, force/yes flags, password, fromCache, interactive, io
 * @returns PullResult with version, extracted count, and any skipped files
 * @throws BfsError if config is missing, target version manifest is missing,
 *   or fewer than N shards can be downloaded
 * @throws PullSkippedError (non-interactive) if any files could not be written
 */
export async function pull(
  rootDir: string,
  options: PullOptions,
): Promise<PullResult> {
  const config = await readConfig(rootDir);
  if (!config)
    throw new BfsError(
      'No vault config found. Run `bfs init` or `bfs recovery` first.',
    );

  assertSchemeValid(config);

  // Adapter preflight: the vault config lists every provider type the backup
  // uses. Refuse to proceed when an adapter is missing unless the caller
  // explicitly opts into best-effort mode via allowMissingAdapters.
  const missing = detectMissingAdapters(config.providers);
  const missingBuiltIn = missing.filter((m) => m.adapterPackage === null);
  if (missingBuiltIn.length > 0) {
    const names = missingBuiltIn.map((m) => `"${m.type}"`).join(', ');
    throw new BfsError(fmt('adapter_preflight_builtin_broken_many', names));
  }
  const missingExternal = missing.filter((m) => m.adapterPackage !== null);
  if (missingExternal.length > 0 && options.allowMissingAdapters !== true) {
    throw new BfsError(`${formatMissingAdaptersMessage(missingExternal)}\n`);
  }
  if (missingExternal.length > 0) {
    options.io.warn(formatMissingAdaptersMessage(missingExternal));
  }
  for (const vm of checkVersionMismatch(config.providers)) {
    options.io.warn(
      vm.severity === 'strong'
        ? fmt(
            'adapter_version_mismatch_strong',
            vm.type,
            vm.recordedPackage,
            vm.installedPackage,
            vm.recordedPackage,
          )
        : fmt(
            'adapter_version_mismatch_soft',
            vm.type,
            vm.recordedPackage,
            vm.installedPackage,
          ),
    );
  }

  const state = await readState(rootDir);
  const targetVersion = options.version ?? state.latest_version;
  if (targetVersion === 0)
    throw new BfsError('No versions available. Run `bfs push` first.');

  // Priority: CLI flag → config.json → default
  const cacheDir =
    options.cacheDir ?? config.cache_dir ?? path.join(rootDir, '.bfs', 'cache');
  const blobCachePath = path.join(cacheDir, 'pull.blob.pending');
  await _validateConfigDir(cacheDir, 'cache-dir');

  let shardFailures = new Map<number, ShardFailureReason>();
  let manifest = await readManifest(rootDir, targetVersion);
  // V2 (rs_striped) uses file-based blob at blobCachePath; V1 uses a Buffer.
  const isV2 = manifest?.rs_striped === true;
  let plainBlob: Buffer = Buffer.alloc(0); // used only for V1 path

  // ── Obtain blob (from cache or by downloading+decoding) ───────────────────
  let loadedFromCache = false;
  if (options.fromCache) {
    if (isV2) {
      // V2: blob cache is already a file at blobCachePath
      try {
        await fs.access(blobCachePath);
        options.io.info(t('vault_using_cached_blob'));
        loadedFromCache = true;
      } catch {
        options.io.info(t('vault_no_cached_blob_pull'));
      }
    } else {
      // V1: blob cache is a Buffer written to a file
      try {
        plainBlob = await fs.readFile(blobCachePath);
        options.io.info(t('vault_using_cached_blob'));
        loadedFromCache = true;
      } catch {
        options.io.info(t('vault_no_cached_blob_pull'));
      }
    }
  }

  if (!loadedFromCache) {
    if (!manifest)
      throw new BfsError(`Manifest for version ${targetVersion} not found.`);

    // Confirm overwrite
    if (!options.force && !options.yes && state.working_version !== 0) {
      const cont = await options.io.confirm(
        fmt(
          'vault_pull_overwrite_confirm',
          String(state.working_version),
          String(targetVersion),
        ),
      );
      if (!cont) throw new BfsError('Pull cancelled.');
    }

    if (isV2) {
      // ── V2 path: streaming RS + per-shard decrypt, writes blob to file ──
      await fs.mkdir(cacheDir, { recursive: true });
      trackFile(blobCachePath);
      const decoded = await _pullV2(config, manifest, options, blobCachePath);
      shardFailures = decoded.failures;
    } else {
      // ── V1 path: legacy RS + whole-blob decrypt ──────────────────────────
      const { data_shards: N } = manifest.scheme;
      options.io.info(fmt('vault_download_shards', String(targetVersion)));
      const downloaded = await downloadShardSlots(
        config,
        manifest,
        rootDir,
        options.io,
      );
      const { shardSlots, blobSize, kdf_salt } = downloaded;
      shardFailures = downloaded.failures;
      const available = shardSlots.filter((s) => s !== null).length;
      if (available < N) {
        throw new BfsError(
          `Not enough shards: need ${N}, got ${available}. Some providers may be offline.`,
        );
      }
      options.io.info(t('vault_decoding_rs'));
      const decoded = await decodeAndDecrypt(
        shardSlots,
        manifest,
        kdf_salt,
        blobSize,
        targetVersion,
        cacheDir,
        options,
      );
      plainBlob = decoded.plainBlob;
    }

    // ── Verify blob hash ─────────────────────────────────────────────────────
    const computedHash = isV2
      ? await hashFileExcludingTail(blobCachePath, 32)
      : hashBuffer(plainBlob.subarray(0, plainBlob.length - 32));
    if (computedHash !== manifest.blob_hash) {
      if (isV2) await fs.unlink(blobCachePath).catch(() => {});
      throw new BfsError(
        'Blob hash mismatch — data corrupted or wrong password.',
      );
    }
  }

  // ── Unpack files ───────────────────────────────────────────────────────────
  options.io.info(t('vault_unpacking_files'));

  // Spec (pipeline.md step 11): --force → delete EVERYTHING in the directory except .bfs/
  if (options.force) {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.bfs' || entry.name === '.bfsignore') continue;
      await fs.rm(path.join(rootDir, entry.name), {
        recursive: true,
        force: true,
      });
    }
  }

  // ── Unpack files ───────────────────────────────────────────────────────────
  if (manifest?.compressed) {
    options.io.info(t('vault_decompressing'));
  }
  // V2: unpack from file (no full-blob Buffer); V1: unpack from Buffer
  let { extracted, skipped } = isV2
    ? await unpackBlobFromFile(blobCachePath, rootDir)
    : await unpackBlob(plainBlob, rootDir);

  if (skipped.length > 0) {
    if (!isV2) {
      // V1: cache the decoded blob so the user can resume with --cache
      await fs.mkdir(path.dirname(blobCachePath), { recursive: true });
      trackFile(blobCachePath);
      await fs.writeFile(blobCachePath, plainBlob);
    }
    // V2: blob is already at blobCachePath (tracked above before _pullV2)

    if (options.interactive) {
      // REPL: retry loop — user can fix permissions and press Y to retry
      while (skipped.length > 0) {
        const shown = skipped.slice(0, 10);
        const rest = skipped.length - shown.length;
        const fileList =
          shown.map((s) => `  - ${s.path}: ${s.reason}`).join('\n') +
          (rest > 0 ? `\n  ... and ${rest} more` : '');
        const retry = await options.io.confirm(
          fmt(
            'vault_pull_write_error_confirm',
            String(skipped.length),
            fileList,
          ),
        );
        if (!retry) {
          untrackFile(blobCachePath);
          await fs.unlink(blobCachePath).catch(() => {});
          throw new BfsError('Pull cancelled.');
        }
        const result = isV2
          ? await unpackBlobFromFile(blobCachePath, rootDir)
          : await unpackBlob(plainBlob, rootDir);
        extracted = result.extracted;
        skipped = result.skipped;
      }
      untrackFile(blobCachePath);
      await fs.unlink(blobCachePath).catch(() => {});
    } else {
      // Standalone mode: abort, keep cache for --cache retry — untrack so SIGINT won't delete it
      untrackFile(blobCachePath);
      throw new PullSkippedError(skipped, blobCachePath);
    }
  }

  // ── Update manifest metadata if incomplete (recovery case) ─────────────────
  manifest = manifest ?? (await readManifest(rootDir, targetVersion));
  if (
    manifest &&
    (manifest.file_count === null || manifest.total_size === null)
  ) {
    const fileEntries = isV2
      ? await parseBlobFileTableFromFile(blobCachePath)
      : parseBlobFileTable(plainBlob);
    manifest.file_count = fileEntries.length;
    manifest.total_size = fileEntries.reduce((s, e) => s + Number(e.size), 0);
    await writeManifest(rootDir, manifest);
  }

  // ── Update state ───────────────────────────────────────────────────────────
  await writeState(rootDir, {
    latest_version: Math.max(state.latest_version, targetVersion),
    working_version: targetVersion,
  });

  // ── Cache management (shard cache for degraded pool) ───────────────────────
  if (shardFailures.size === 0) {
    try {
      const cacheEntries = await fs.readdir(cacheDir);
      for (const entry of cacheEntries) {
        // Preserve pull.blob.pending if it exists (already cleaned up above on success)
        if (entry === 'pull.blob.pending') continue;
        await fs.unlink(path.join(cacheDir, entry)).catch(() => {});
      }
    } catch {
      // cache dir may not exist — fine
    }
  } else {
    _emitDegradedWarnings(shardFailures, options.io);
  }

  // ── Clean up blob cache on success ─────────────────────────────────────────
  untrackFile(blobCachePath);
  await fs.unlink(blobCachePath).catch(() => {});

  return { version: targetVersion, extracted: extracted.length, skipped };
}

/**
 * Deletes specified versions: removes shards from all providers and manifests from disk.
 * Updates state.json if the latest version was pruned.
 *
 * @param rootDir - Absolute path to the vault working directory
 * @param options - Versions to delete and associated ProviderIO
 * @throws BfsError if config is missing.
 */
export async function prune(
  rootDir: string,
  options: PruneOptions,
): Promise<void> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  assertSchemeValid(config);

  const state = await readState(rootDir);

  const silentIO: ProviderIO = {
    lang: 'en',
    workDir: rootDir,
    ask: async () => '',
    askSecret: async () => '',
    confirm: async () => false,
    choose: async (_m, opts) => opts[0] ?? '',
    info: () => {},
    debug: () => {},
    warn: () => {},
    progress: () => {},
  };

  for (const version of options.versions) {
    const manifest = await readManifest(rootDir, version);
    if (!manifest) continue;

    for (const ms of manifest.shards) {
      const pc = config.providers.find((p) => p.id === ms.provider_id);
      if (!pc) continue;
      try {
        const provider = providerRegistry.create(pc, silentIO);
        await provider.authenticate();
        provider.setVaultName(config.vault_name);
        await provider.delete({
          provider_id: ms.provider_id,
          path: `shard_${ms.shard_index}.bfs.${version}`,
        });
      } catch {
        // best-effort; shard may already be gone
      }
    }
    await deleteManifest(rootDir, version).catch(() => {});
  }

  // Update state if latest was pruned
  const remaining = await listManifests(rootDir);
  const newLatest =
    remaining.length > 0 ? remaining[remaining.length - 1]?.version : 0;
  if (newLatest !== state.latest_version) {
    const newWorking =
      state.working_version > newLatest ? 0 : state.working_version;
    await writeState(rootDir, {
      latest_version: newLatest,
      working_version: newWorking,
    });
  }
}

/**
 * Removes a provider from config, with three strategies:
 * - 'remove': marks affected manifests as degraded, updates config.
 * - 'relocate': updates shard headers with new connection info.
 * - 'rebuild': downloads remaining shards, RS-repairs, uploads to target provider.
 *
 * @throws BfsError on validation failure or missing required options.
 */
export async function removeProvider(
  rootDir: string,
  providerId: string,
  options: RemoveProviderOptions,
): Promise<void> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  // No assertSchemeValid — rebuild flow needs providers.length > N+K transiently.

  if (!config.providers.find((p) => p.id === providerId)) {
    throw new BfsError(`Provider "${providerId}" not found in config.`);
  }

  if (options.strategy === 'remove') {
    if (config.providers.length <= 3) {
      throw new BfsError(
        'Cannot remove — minimum 3 providers (scheme 2/1) required. Use relocate or rebuild instead.',
      );
    }
    const updatedProviders = config.providers.filter(
      (p) => p.id !== providerId,
    );
    await writeConfig(rootDir, { ...config, providers: updatedProviders });

    const manifests = await listManifests(rootDir);
    for (const manifest of manifests) {
      if (
        manifest.shards.some((s) => s.provider_id === providerId) &&
        manifest.health === VersionHealth.Healthy
      ) {
        manifest.health = VersionHealth.Degraded;
        await writeManifest(rootDir, manifest);
      }
    }
    return;
  }

  if (options.strategy === 'relocate') {
    if (!options.newConnectionConfig) {
      throw new BfsError('newConnectionConfig required for relocate strategy.');
    }
    const { relocateProvider } = await import('./heal.js');
    await relocateProvider(
      rootDir,
      providerId,
      options.newConnectionConfig,
      options.io,
      options.password,
      options.newType,
    );
    return;
  }

  if (options.strategy === 'rebuild') {
    if (!options.targetProviderId) {
      throw new BfsError('targetProviderId required for rebuild strategy.');
    }
    const { rebuildAllVersions } = await import('./heal.js');
    await rebuildAllVersions(
      rootDir,
      providerId,
      options.targetProviderId,
      options.rebuildScope ?? 'all',
      options.io,
      options.password,
    );
    // Remove old provider from config (target provider is already in config)
    const updatedProviders = config.providers.filter(
      (p) => p.id !== providerId,
    );
    await writeConfig(rootDir, { ...config, providers: updatedProviders });
  }
}

/**
 * Returns a summary of the current vault state.
 * @throws BfsError if config is missing.
 */
export async function status(rootDir: string): Promise<StatusInfo> {
  const config = await readConfig(rootDir);
  if (!config)
    throw new BfsError('No vault config found. Run `bfs init` first.');
  const state = await readState(rootDir);
  return {
    vault_name: config.vault_name,
    latest_version: state.latest_version,
    working_version: state.working_version,
    provider_count: config.providers.length,
    scheme: config.scheme,
    encryption_enabled: config.encryption.enabled,
  };
}

/**
 * Returns all version manifests sorted by version ascending.
 * @throws BfsError if config is missing.
 */
export async function listVersions(
  rootDir: string,
): Promise<VersionManifest[]> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');
  return listManifests(rootDir);
}
