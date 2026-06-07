import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseBlobFileTable, parseBlobFileTableFromFile, unpackBlob, unpackBlobFromFile } from '../core/blob-unpack.js';
import { trackFile, untrackFile } from '../core/cleanup.js';
import { decryptBlob, decryptStream, deriveKey, deriveShardNonce } from '../core/crypto.js';
import { BfsError, PullSkippedError } from '../core/errors.js';
import { hashBuffer, hashFileExcludingTail, SHA256_BYTES, streamToBuffer } from '../core/hash.js';
import { DEFAULT_BFSIGNORE_CONTENT } from '../core/ignore-defaults.js';
import { calcShardPayloadSize, rsDecode, rsDecodeStriped, rsRepair } from '../core/reed-solomon.js';
import { computeShardHeaderSize, parseShardHeaderFromStream } from '../core/shard-io.js';
import { debugEnabled } from '../debug.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { FileEntry, ManifestShard, ProviderConfig, ProviderIO, PullResult, SkippedFile, VaultConfig, VaultState, VersionManifest } from '../types/index.js';
import { type PushMode, VersionHealth } from '../types/index.js';
import { checkVersionMismatch, detectMissingAdapters, formatMissingAdaptersMessage } from './adapter-preflight.js';
import { assertSchemeValid, readConfig, writeConfig } from './config.js';
import { deleteManifest, listManifests, readManifest, writeManifest } from './manifest.js';
import { DEFAULT_STATE, readState, writeState } from './state.js';

// Re-export push pipeline — public API stays on vault-manager.ts
export {
  _classifyUploadError,
  buildRemotePath,
  push,
} from './push-pipeline.js';

// ─── V2 pipeline constants ────────────────────────────────────────────────────

/** Legacy stripe size — used as fallback in pull/recovery for manifests without rs_stripe_size. */
const V2_STRIPE_SIZE = 64 * 1024 * 1024;

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

// PushOptions moved to src/types/index.ts

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

/** Validates that a configured directory (or its parent) exists before use. */
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

// ─── Shard failure diagnostics ───────────────────────────────────────────────

type ShardFailureReason = 'provider_unreachable' | 'file_missing';

/**
 * Emits appropriate degradation warnings based on shard failure reasons.
 */
function _emitDegradedWarnings(failures: Map<number, ShardFailureReason>, io: ProviderIO): void {
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
): Promise<{ blobSize: number; kdf_salt: Nullable<Buffer>; failures: Map<number, ShardFailureReason> }> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const targetVersion = manifest.version;
  let blobSize = 0;
  let kdf_salt: Nullable<Buffer> = null;
  const failures = new Map<number, ShardFailureReason>();
  options.io.info(fmt('vault_download_shards', String(targetVersion)));
  for (const ms of manifest.shards) {
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) {
      options.io.warn(fmt('vault_provider_not_found', ms.provider_id, String(ms.shard_index)));
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
      const stream = await provider.download({ provider_id: ms.provider_id, path: `shard_${ms.shard_index}.bfs.${targetVersion}` });
      const tmpPath = path.join(tmpDir, `shard_${ms.shard_index}`);
      await pipeline(stream, createWriteStream(tmpPath));
      if (debugEnabled) {
        const stat = await fs.stat(tmpPath);
        process.stderr.write(`[bfs:debug] shard ${ms.shard_index} downloaded: ${stat.size} bytes\n`);
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
      options.io.progress(fmt('vault_download_shard_progress', String(ms.shard_index + 1), String(N + K)), ((ms.shard_index + 1) / (N + K)) * 100);
    } catch {
      failures.set(ms.shard_index, 'file_missing');
      options.io.warn(fmt('vault_file_missing_on_provider', pc.id));
    }
  }
  if (debugEnabled) {
    const indices = [...tmpPaths.keys()].sort((a, b) => a - b);
    process.stderr.write(`[bfs:debug] download done: shards=[${indices.join(',')}] blobSize=${blobSize} kdf_salt=${kdf_salt !== null ? 'yes' : 'null'}\n`);
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
async function _decodeFromTempFiles(tmpPaths: Map<number, string>, N: number, K: number, stripeSize: number, blobSize: number, targetVersion: number, encKey: Buffer | undefined, outputPath: string, io: ProviderIO): Promise<void> {
  const payloadStreams: Nullable<Readable>[] = new Array(N + K).fill(null);
  for (const [shardIdx, tmpPath] of tmpPaths) {
    // Belt-and-suspenders error sinks for the per-shard decode fan-out, each
    // attached the instant its stream is created (no gap before the eager
    // pipe inside decryptStream). On a wrong key every shard's decrypt flush
    // throws; only the shard the RS decoder is actively reading surfaces the
    // error to the caller (async-iterator rejection → output.destroy →
    // pipeline reject). These sinks keep the sibling streams from emitting
    // 'error' to no listener and aborting the process. Silent unless --debug,
    // where they aid diagnosis. (decryptStream also self-sinks its transform.)
    const sinkErr = (label: string) => (err: Error) => {
      if (debugEnabled) {
        process.stderr.write(`[bfs:debug] _decodeFromTempFiles shard ${shardIdx} ${label}: ${err.message}\n`);
      }
    };
    const fileStream = createReadStream(tmpPath);
    fileStream.on('error', sinkErr('fileStream'));
    const { payloadStream } = await parseShardHeaderFromStream(fileStream);
    payloadStream.on('error', sinkErr('payloadStream'));
    const stream = encKey ? decryptStream(payloadStream, encKey, deriveShardNonce(encKey, targetVersion, shardIdx)) : payloadStream;
    stream.on('error', sinkErr('decryptStream'));
    payloadStreams[shardIdx] = stream;
  }
  if (debugEnabled) {
    const active = payloadStreams.map((s, i) => (s !== null ? String(i) : null)).filter((x): x is string => x !== null);
    const nulls = payloadStreams.map((s, i) => (s === null ? String(i) : null)).filter((x): x is string => x !== null);
    process.stderr.write(`[bfs:debug] _decodeFromTempFiles: active=[${active.join(',')}] null=[${nulls.join(',')}]\n`);
  }
  io.info(t('vault_decoding_rs'));
  const debugLog = debugEnabled
    ? (msg: string) => {
        process.stderr.write(`[bfs:debug] ${msg}\n`);
      }
    : undefined;
  // Create the output directory BEFORE starting the background decode, so there
  // is no `await` between rsDecodeStriped() (which begins decoding on a future
  // microtask) and pipeline() attaching its error handler. Otherwise a decode
  // error (e.g. a wrong-key DecryptionError on the actively-read shard) could
  // destroy blobStream during the mkdir await → 'error' emitted with no
  // listener → unhandled exception crashing the process.
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const blobStream = rsDecodeStriped(payloadStreams, N, K, stripeSize, blobSize, debugLog);
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
async function _pullV2(config: VaultConfig, manifest: VersionManifest, options: PullOptions, outputPath: string): Promise<{ isDegraded: boolean; failures: Map<number, ShardFailureReason> }> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const targetVersion = manifest.version;
  const stripeSize = manifest.rs_stripe_size ?? V2_STRIPE_SIZE;
  // tmpDir inside cache dir (or user-specified tempDir) — cleaned up in finally
  const tmpBase = options.tempDir ?? config.temp_dir ?? path.dirname(outputPath);
  await _validateConfigDir(tmpBase, 'temp-dir');
  const tmpDir = path.join(tmpBase, `pull-v2-${targetVersion}-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpPaths = new Map<number, string>();
  try {
    const { blobSize, kdf_salt, failures } = await _downloadShardsToTempFiles(config, manifest, options, tmpDir, tmpPaths);
    if (tmpPaths.size < N) throw new BfsError(`Not enough shards: need ${N}, got ${tmpPaths.size}. Some providers may be offline.`);
    if (blobSize === 0) throw new BfsError('Could not read blob size from any shard header.');
    const shardSize = calcShardPayloadSize(blobSize, N);
    const numStripes = Math.ceil(shardSize / stripeSize);
    if (debugEnabled) {
      process.stderr.write(`[bfs:debug] _pullV2: blobSize=${blobSize} stripeSize=${stripeSize}` + ` shardSize=${shardSize} numStripes=${numStripes}` + ` encrypted=${manifest.encrypted} N=${N} K=${K}\n`);
    }
    let encKey: Buffer | undefined;
    if (manifest.encrypted) {
      let password: Nullable<string> = options.password ?? null;
      if (!password) password = await options.io.askSecret(t('vault_ask_decrypt_password'));
      if (!password) throw new BfsError('Password required for encrypted vault.');
      if (!kdf_salt) throw new BfsError('kdf_salt not found in any shard header.');
      options.io.info(t('vault_decrypting'));
      encKey = await deriveKey(password, kdf_salt);
    }
    await _decodeFromTempFiles(tmpPaths, N, K, stripeSize, blobSize, targetVersion, encKey, outputPath, options.io);
    return { isDegraded: tmpPaths.size < N + K, failures };
  } finally {
    for (const [, p] of tmpPaths) await fs.unlink(p).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Extracts the RS payload bytes from a raw shard buffer without decrypting.
 * Returns the bytes between the header and the trailing 32-byte checksum.
 */
export function extractShardPayload(data: Buffer): Buffer {
  const headerSize = computeShardHeaderSize(data);
  return data.subarray(headerSize, data.length - SHA256_BYTES);
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
): Promise<{ shardSlots: Nullable<Buffer>[]; blobSize: number; kdf_salt: Nullable<Buffer>; failures: Map<number, ShardFailureReason> }> {
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
      io.warn(`Provider "${ms.provider_id}" not found in config — skipping shard ${ms.shard_index}`);
      continue;
    }
    const probe = providerRegistry.create(pc, io);
    if (!(await probe.healthCheck())) {
      failures.set(ms.shard_index, 'provider_unreachable');
      io.warn(fmt('vault_provider_unreachable', pc.id));
      continue;
    }
    try {
      const shardData = await fetchShard(pc, ms, config, cacheDir, targetVersion, io);
      if (!shardData) continue;
      const { header: meta } = await parseShardHeaderFromStream(Readable.from(shardData));
      if (meta.shard_index !== ms.shard_index || meta.version !== targetVersion || meta.vault_id !== config.vault_id) {
        io.warn(`Shard ${ms.shard_index} header validation failed — skipping`);
        continue;
      }
      shardSlots[ms.shard_index] = extractShardPayload(shardData);
      if (blobSize === 0) blobSize = Number(meta.blob_size);
      if (!kdf_salt && meta.kdf_salt) kdf_salt = meta.kdf_salt;
      io.progress(`Downloading shard ${ms.shard_index + 1}/${N + K}`, ((ms.shard_index + 1) / (N + K)) * 100);
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
async function fetchShard(pc: ProviderConfig, ms: ManifestShard, config: VaultConfig, cacheDir: string, targetVersion: number, io: ProviderIO): Promise<Nullable<Buffer>> {
  const filename = `shard_${ms.shard_index}.bfs.${targetVersion}`;
  const cacheFile = path.join(cacheDir, filename);

  // Try cache first — avoid network round-trip if payload hash matches
  try {
    const cached = await fs.readFile(cacheFile);
    if (hashBuffer(extractShardPayload(cached)) === ms.shard_hash) return cached;
    await fs.unlink(cacheFile).catch(() => {});
  } catch {
    // cache miss — proceed to provider download
  }

  const provider = providerRegistry.create(pc, io);
  await provider.authenticate();
  provider.setVaultName(config.vault_name);
  const shardStream = await provider.download({ provider_id: ms.provider_id, path: filename });
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
        await fs.writeFile(path.join(cacheDir, `shard_${i}.bfs.${targetVersion}.repaired`), repairedShard).catch(() => {});
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
  if (!password) password = await options.io.askSecret('Enter decryption password:');
  if (!password) throw new BfsError('Password required for encrypted vault.');
  if (!kdf_salt) throw new BfsError('kdf_salt not found in any shard header.');
  options.io.info('Decrypting…');
  return { plainBlob: await decryptBlob(rsOutput, password, kdf_salt), isDegraded };
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
export async function init(rootDir: string, options: InitOptions): Promise<void> {
  const { data_shards: N, parity_shards: K } = options.scheme;
  if (options.providers.length !== N + K) {
    throw new BfsError(`Scheme requires ${N + K} providers, got ${options.providers.length}.`);
  }

  // 0700: .bfs/ holds config.json (provider secrets) and cached plaintext
  // blobs, so keep the whole tree owner-only on POSIX (no-op on Windows NTFS).
  await fs.mkdir(path.join(rootDir, '.bfs', 'manifests'), { recursive: true, mode: 0o700 });

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

// ─── pull() private helpers ───────────────────────────────────────────────────

async function _runPullPreflight(config: VaultConfig, options: PullOptions): Promise<void> {
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
  if (missingExternal.length > 0) options.io.warn(formatMissingAdaptersMessage(missingExternal));
  for (const vm of checkVersionMismatch(config.providers)) {
    options.io.warn(
      vm.severity === 'strong' ? fmt('adapter_version_mismatch_strong', vm.type, vm.recordedPackage, vm.installedPackage, vm.recordedPackage) : fmt('adapter_version_mismatch_soft', vm.type, vm.recordedPackage, vm.installedPackage),
    );
  }
}

async function _loadBlobFromCache(isV2: boolean, blobCachePath: string, io: ProviderIO, fromCache?: boolean): Promise<{ loadedFromCache: boolean; plainBlob: Buffer }> {
  if (!fromCache) return { loadedFromCache: false, plainBlob: Buffer.alloc(0) };
  if (isV2) {
    try {
      await fs.access(blobCachePath);
      io.info(t('vault_using_cached_blob'));
      return { loadedFromCache: true, plainBlob: Buffer.alloc(0) };
    } catch {
      io.info(t('vault_no_cached_blob_pull'));
      return { loadedFromCache: false, plainBlob: Buffer.alloc(0) };
    }
  }
  try {
    const plainBlob = await fs.readFile(blobCachePath);
    io.info(t('vault_using_cached_blob'));
    return { loadedFromCache: true, plainBlob };
  } catch {
    io.info(t('vault_no_cached_blob_pull'));
    return { loadedFromCache: false, plainBlob: Buffer.alloc(0) };
  }
}

interface DownloadVerifyBlobOptions {
  config: VaultConfig;
  manifest: VersionManifest;
  rootDir: string;
  cacheDir: string;
  blobCachePath: string;
  isV2: boolean;
  targetVersion: number;
  workingVersion: number;
  options: PullOptions;
}

async function _downloadAndVerifyBlob({
  config,
  manifest,
  rootDir,
  cacheDir,
  blobCachePath,
  isV2,
  targetVersion,
  workingVersion,
  options,
}: DownloadVerifyBlobOptions): Promise<{ plainBlob: Buffer; shardFailures: Map<number, ShardFailureReason> }> {
  if (!options.force && !options.yes && workingVersion !== 0) {
    const cont = await options.io.confirm(fmt('vault_pull_overwrite_confirm', String(workingVersion), String(targetVersion)));
    if (!cont) throw new BfsError('Pull cancelled.');
  }
  let plainBlob: Buffer = Buffer.alloc(0);
  let shardFailures = new Map<number, ShardFailureReason>();
  if (isV2) {
    await fs.mkdir(cacheDir, { recursive: true });
    trackFile(blobCachePath);
    const decoded = await _pullV2(config, manifest, options, blobCachePath);
    shardFailures = decoded.failures;
  } else {
    const { data_shards: N } = manifest.scheme;
    options.io.info(fmt('vault_download_shards', String(targetVersion)));
    const downloaded = await downloadShardSlots(config, manifest, rootDir, options.io);
    shardFailures = downloaded.failures;
    const available = downloaded.shardSlots.filter((s) => s !== null).length;
    if (available < N) throw new BfsError(`Not enough shards: need ${N}, got ${available}. Some providers may be offline.`);
    options.io.info(t('vault_decoding_rs'));
    const decoded = await decodeAndDecrypt(downloaded.shardSlots, manifest, downloaded.kdf_salt, downloaded.blobSize, targetVersion, cacheDir, options);
    plainBlob = decoded.plainBlob;
  }
  const computedHash = isV2 ? await hashFileExcludingTail(blobCachePath, SHA256_BYTES) : hashBuffer(plainBlob.subarray(0, plainBlob.length - SHA256_BYTES));
  if (computedHash !== manifest.blob_hash) {
    if (isV2) await fs.unlink(blobCachePath).catch(() => {});
    throw new BfsError('Blob hash mismatch — data corrupted or wrong password.');
  }
  return { plainBlob, shardFailures };
}

interface InteractiveRetryOptions {
  isV2: boolean;
  plainBlob: Buffer;
  blobCachePath: string;
  initialSkipped: SkippedFile[];
  rootDir: string;
  io: ProviderIO;
}

async function _interactiveUnpackRetry({ isV2, plainBlob, blobCachePath, initialSkipped, rootDir, io }: InteractiveRetryOptions): Promise<FileEntry[]> {
  let skipped = initialSkipped;
  let extracted: FileEntry[] = [];
  while (skipped.length > 0) {
    const shown = skipped.slice(0, 10);
    const rest = skipped.length - shown.length;
    const fileList = shown.map((s) => `  - ${s.path}: ${s.reason}`).join('\n') + (rest > 0 ? `\n  ... and ${rest} more` : '');
    const retry = await io.confirm(fmt('vault_pull_write_error_confirm', String(skipped.length), fileList));
    if (!retry) {
      untrackFile(blobCachePath);
      await fs.unlink(blobCachePath).catch(() => {});
      throw new BfsError('Pull cancelled.');
    }
    const result = isV2 ? await unpackBlobFromFile(blobCachePath, rootDir) : await unpackBlob(plainBlob, rootDir);
    extracted = result.extracted;
    skipped = result.skipped;
  }
  // Cleanup delegated to _finalizePullState, which reads the file table before deleting.
  return extracted;
}

interface UnpackFilesOptions {
  rootDir: string;
  manifest: Nullable<VersionManifest>;
  isV2: boolean;
  plainBlob: Buffer;
  blobCachePath: string;
  options: PullOptions;
}

async function _unpackFiles({ rootDir, manifest, isV2, plainBlob, blobCachePath, options }: UnpackFilesOptions): Promise<{ extracted: FileEntry[]; skipped: SkippedFile[] }> {
  options.io.info(t('vault_unpacking_files'));
  if (options.force) {
    const entries = await fs.readdir(rootDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.bfs' || entry.name === '.bfsignore') continue;
      await fs.rm(path.join(rootDir, entry.name), { recursive: true, force: true });
    }
  }
  if (manifest?.compressed) options.io.info(t('vault_decompressing'));
  let { extracted, skipped } = isV2 ? await unpackBlobFromFile(blobCachePath, rootDir) : await unpackBlob(plainBlob, rootDir);
  if (skipped.length > 0) {
    if (!isV2) {
      await fs.mkdir(path.dirname(blobCachePath), { recursive: true });
      trackFile(blobCachePath);
      await fs.writeFile(blobCachePath, plainBlob);
    }
    if (options.interactive) {
      extracted = await _interactiveUnpackRetry({ isV2, plainBlob, blobCachePath, initialSkipped: skipped, rootDir, io: options.io });
      skipped = [];
    } else {
      untrackFile(blobCachePath);
      throw new PullSkippedError(skipped, blobCachePath);
    }
  }
  return { extracted, skipped };
}

interface FinalizePullStateOptions {
  rootDir: string;
  cacheDir: string;
  state: VaultState;
  targetVersion: number;
  manifest: Nullable<VersionManifest>;
  isV2: boolean;
  plainBlob: Buffer;
  blobCachePath: string;
  shardFailures: Map<number, ShardFailureReason>;
  io: ProviderIO;
}

async function _finalizePullState({ rootDir, cacheDir, state, targetVersion, manifest: passedManifest, isV2, plainBlob, blobCachePath, shardFailures, io }: FinalizePullStateOptions): Promise<void> {
  const manifest = passedManifest ?? (await readManifest(rootDir, targetVersion));
  if (manifest && (manifest.file_count === null || manifest.total_size === null)) {
    const fileEntries = isV2 ? await parseBlobFileTableFromFile(blobCachePath) : parseBlobFileTable(plainBlob);
    manifest.file_count = fileEntries.length;
    manifest.total_size = fileEntries.reduce((s, e) => s + Number(e.size), 0);
    await writeManifest(rootDir, manifest);
  }
  await writeState(rootDir, { latest_version: Math.max(state.latest_version, targetVersion), working_version: targetVersion });
  if (shardFailures.size === 0) {
    try {
      const cacheEntries = await fs.readdir(cacheDir);
      for (const entry of cacheEntries) {
        if (entry === 'pull.blob.pending') continue;
        await fs.unlink(path.join(cacheDir, entry)).catch(() => {});
      }
    } catch {
      // cache dir may not exist — fine
    }
  } else {
    _emitDegradedWarnings(shardFailures, io);
  }
  untrackFile(blobCachePath);
  await fs.unlink(blobCachePath).catch(() => {});
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
export async function pull(rootDir: string, options: PullOptions): Promise<PullResult> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found. Run `bfs init` or `bfs recovery` first.');
  assertSchemeValid(config);
  await _runPullPreflight(config, options);

  const state = await readState(rootDir);
  const targetVersion = options.version ?? state.latest_version;
  if (targetVersion === 0) throw new BfsError('No versions available. Run `bfs push` first.');

  // Priority: CLI flag → config.json → default
  const cacheDir = options.cacheDir ?? config.cache_dir ?? path.join(rootDir, '.bfs', 'cache');
  const blobCachePath = path.join(cacheDir, 'pull.blob.pending');
  await _validateConfigDir(cacheDir, 'cache-dir');

  const manifest = await readManifest(rootDir, targetVersion);
  const isV2 = manifest?.rs_striped === true;

  const { loadedFromCache, plainBlob: cachedBlob } = await _loadBlobFromCache(isV2, blobCachePath, options.io, options.fromCache);
  let shardFailures = new Map<number, ShardFailureReason>();
  let plainBlob = cachedBlob;
  if (!loadedFromCache) {
    if (!manifest) throw new BfsError(`Manifest for version ${targetVersion} not found.`);
    const result = await _downloadAndVerifyBlob({ config, manifest, rootDir, cacheDir, blobCachePath, isV2, targetVersion, workingVersion: state.working_version, options });
    plainBlob = result.plainBlob;
    shardFailures = result.shardFailures;
  }

  const { extracted, skipped } = await _unpackFiles({ rootDir, manifest, isV2, plainBlob, blobCachePath, options });
  await _finalizePullState({ rootDir, cacheDir, state, targetVersion, manifest, isV2, plainBlob, blobCachePath, shardFailures, io: options.io });

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
export async function prune(rootDir: string, options: PruneOptions): Promise<void> {
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
        await provider.delete({ provider_id: ms.provider_id, path: `shard_${ms.shard_index}.bfs.${version}` });
      } catch {
        // best-effort; shard may already be gone
      }
    }
    await deleteManifest(rootDir, version).catch(() => {});
  }

  // Update state if latest was pruned
  const remaining = await listManifests(rootDir);
  const newLatest = remaining.length > 0 ? remaining[remaining.length - 1]?.version : 0;
  if (newLatest !== state.latest_version) {
    const newWorking = state.working_version > newLatest ? 0 : state.working_version;
    await writeState(rootDir, { latest_version: newLatest, working_version: newWorking });
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
export async function removeProvider(rootDir: string, providerId: string, options: RemoveProviderOptions): Promise<void> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  // No assertSchemeValid — rebuild flow needs providers.length > N+K transiently.

  if (!config.providers.find((p) => p.id === providerId)) {
    throw new BfsError(`Provider "${providerId}" not found in config.`);
  }

  if (options.strategy === 'remove') {
    if (config.providers.length <= 3) {
      throw new BfsError('Cannot remove — minimum 3 providers (scheme 2/1) required. Use relocate or rebuild instead.');
    }
    const updatedProviders = config.providers.filter((p) => p.id !== providerId);
    await writeConfig(rootDir, { ...config, providers: updatedProviders });

    const manifests = await listManifests(rootDir);
    for (const manifest of manifests) {
      if (manifest.shards.some((s) => s.provider_id === providerId) && manifest.health === VersionHealth.Healthy) {
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
    await relocateProvider(rootDir, providerId, {
      newConnectionConfig: options.newConnectionConfig,
      io: options.io,
      ...(options.password !== undefined ? { password: options.password } : {}),
      ...(options.newType !== undefined ? { newType: options.newType } : {}),
    });
    return;
  }

  if (options.strategy === 'rebuild') {
    if (!options.targetProviderId) {
      throw new BfsError('targetProviderId required for rebuild strategy.');
    }
    const { rebuildAllVersions } = await import('./heal.js');
    await rebuildAllVersions(rootDir, {
      removedProviderId: providerId,
      targetProviderId: options.targetProviderId,
      scope: options.rebuildScope ?? 'all',
      io: options.io,
      ...(options.password !== undefined ? { password: options.password } : {}),
    });
    // Remove old provider from config (target provider is already in config)
    const updatedProviders = config.providers.filter((p) => p.id !== providerId);
    await writeConfig(rootDir, { ...config, providers: updatedProviders });
  }
}

/**
 * Returns a summary of the current vault state.
 * @throws BfsError if config is missing.
 */
export async function status(rootDir: string): Promise<StatusInfo> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found. Run `bfs init` first.');
  const state = await readState(rootDir);
  return { vault_name: config.vault_name, latest_version: state.latest_version, working_version: state.working_version, provider_count: config.providers.length, scheme: config.scheme, encryption_enabled: config.encryption.enabled };
}

/**
 * Returns all version manifests sorted by version ascending.
 * @throws BfsError if config is missing.
 */
export async function listVersions(rootDir: string): Promise<VersionManifest[]> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');
  return listManifests(rootDir);
}
