import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { packBlob } from '../core/blob-pack.js';
import { parseBlobFileTable, unpackBlob } from '../core/blob-unpack.js';
import { decryptBlob, encryptBlob } from '../core/crypto.js';
import type { SkippedFile } from '../core/errors.js';
import {
  BfsError,
  PullSkippedError,
  PushSkippedError,
} from '../core/errors.js';
import { hashBuffer } from '../core/hash.js';
import { createIgnoreFilter } from '../core/ignore.js';
import { DEFAULT_BFSIGNORE_CONTENT } from '../core/ignore-defaults.js';
import { rsDecode, rsEncode, rsRepair } from '../core/reed-solomon.js';
import {
  buildShard,
  computeShardHeaderSize,
  parseShardHeaderOnly,
  uuidToBuffer,
} from '../core/shard-io.js';
import { createProvider } from '../providers/provider.js';
import type {
  ManifestShard,
  ProviderConfig,
  ProviderIO,
  PullResult,
  PushResult,
  RemoteRef,
  ShardHeader,
  ShardLocation,
  StorageProvider,
  VaultConfig,
  VersionManifest,
} from '../types/index.js';
import { PushMode, VersionHealth } from '../types/index.js';
import { readConfig, writeConfig } from './config.js';
import {
  deleteManifest,
  listManifests,
  readManifest,
  writeManifest,
} from './manifest.js';
import { DEFAULT_STATE, readState, writeState } from './state.js';

// ─── Option types ─────────────────────────────────────────────────────────────

export interface InitOptions {
  vault_name: string;
  scheme: { data_shards: number; parity_shards: number };
  encryption: { enabled: boolean; algorithm: 'aes-256-gcm'; kdf: 'argon2id' };
  providers: ProviderConfig[];
  push_mode: PushMode;
  io: ProviderIO;
}

export interface PushOptions {
  /** Overrides config.push_mode. If absent, config.push_mode is used. */
  mode?: PushMode.NewVersion | PushMode.Overwrite;
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

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Context object shared by the two upload helpers (overwrite / new-version). */
interface UploadContext {
  readonly N: number;
  readonly K: number;
  readonly config: VaultConfig;
  readonly providers: StorageProvider[];
  readonly shardBuffers: Buffer[];
  readonly shardPayloads: Buffer[];
  readonly targetVersion: number;
  readonly io: ProviderIO;
}

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
    const p = createProvider(pc, io);
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
 * Packs rootDir into a BFS blob and optionally encrypts it.
 * Prompts for a password if the vault is encrypted and none was provided.
 * On first push (no existing manifests) also asks for a confirmation of the password.
 *
 * @returns rsInput, blob, blob_hash, file_count, total_size, kdf_salt, encKey, skipped
 * @throws BfsError if a password is required but not provided, or if passwords don't match
 */
async function packAndEncrypt(
  rootDir: string,
  config: VaultConfig,
  options: PushOptions,
): Promise<{
  rsInput: Buffer;
  blob: Buffer;
  blob_hash: string;
  file_count: number;
  total_size: number;
  kdf_salt: Nullable<Buffer>;
  encKey: Buffer | undefined;
  skipped: SkippedFile[];
}> {
  options.io.info('Scanning directory…');
  const filter = createIgnoreFilter(rootDir);
  const { blob, skipped } = await packBlob(
    rootDir,
    filter,
    uuidToBuffer(config.vault_id),
  );
  const entries = parseBlobFileTable(blob);
  const file_count = entries.length;
  const total_size = entries.reduce((s, e) => s + Number(e.size), 0);
  const blob_hash = hashBuffer(blob.subarray(0, blob.length - 32));

  if (!config.encryption.enabled) {
    return {
      rsInput: blob,
      blob,
      blob_hash,
      file_count,
      total_size,
      kdf_salt: null,
      encKey: undefined,
      skipped,
    };
  }

  let password: Nullable<string> = options.password ?? null;
  if (!password) {
    const existingManifests = await listManifests(rootDir);
    password = await options.io.askSecret('Enter encryption password:');
    if (!password) throw new BfsError('Password required for encrypted vault.');
    if (existingManifests.length === 0) {
      const confirm = await options.io.askSecret('Confirm password:');
      if (confirm !== password) throw new BfsError('Passwords do not match.');
    }
  }
  options.io.info('Encrypting…');
  const result = await encryptBlob(blob, password);
  return {
    rsInput: result.encrypted,
    blob,
    blob_hash,
    file_count,
    total_size,
    kdf_salt: result.salt,
    encKey: result.key,
    skipped,
  };
}

/**
 * Builds complete shard Buffers (header + payload + checksum) for every shard index.
 * The location map is embedded in every shard header so each shard is self-describing.
 *
 * @throws BfsError if a shard payload is missing (internal consistency guard)
 */
function buildShardBuffers(
  config: VaultConfig,
  shardPayloads: Buffer[],
  targetVersion: number,
  blobSize: bigint,
  blobHash: string,
  kdf_salt: Nullable<Buffer>,
  encKey: Buffer | undefined,
  locationMap: ShardLocation[],
): Buffer[] {
  const { data_shards: N, parity_shards: K } = config.scheme;
  return shardPayloads.map((payload, i) => {
    const header: ShardHeader = {
      magic: 'BFSS',
      format_version: 1,
      vault_id: config.vault_id,
      vault_name: config.vault_name,
      blob_size: blobSize,
      blob_hash: blobHash,
      data_shards: N,
      parity_shards: K,
      shard_index: i,
      version: targetVersion,
      encrypted: config.encryption.enabled,
      kdf_salt,
      map_length: 0,
      location_map: locationMap,
    };
    return buildShard(header, payload, encKey);
  });
}

/**
 * Uploads new-version shards to their respective providers (no overwrite).
 * Uploads sequentially; each provider receives exactly one shard file.
 *
 * @throws BfsError if internal shard data is missing for any index
 */
async function uploadShardsNew(ctx: UploadContext): Promise<ManifestShard[]> {
  const {
    N,
    K,
    config,
    providers,
    shardBuffers,
    shardPayloads,
    targetVersion,
    io,
  } = ctx;
  const manifestShards: ManifestShard[] = [];
  for (let i = 0; i < N + K; i++) {
    const shardBuf = shardBuffers[i];
    const payload = shardPayloads[i];
    const pc = config.providers[i];
    if (!shardBuf || !payload || !pc) {
      throw new BfsError(`Internal: shard data missing for index ${i}`);
    }
    await providers[i]?.upload(`shard_${i}.bfs.${targetVersion}`, shardBuf);
    io.progress(`Uploading shard ${i + 1}/${N + K}`, ((i + 1) / (N + K)) * 100);
    manifestShards.push({
      shard_index: i,
      provider_id: pc.id,
      provider_type: pc.type,
      remote_path: buildRemotePath(
        pc,
        config.vault_name,
        `shard_${i}.bfs.${targetVersion}`,
      ),
      shard_hash: hashBuffer(payload),
    });
  }
  return manifestShards;
}

/**
 * Uploads shards atomically in overwrite mode: .tmp → delete old → rename .tmp.
 * If any upload fails, already-uploaded .tmp files are cleaned up before rethrowing.
 *
 * @throws BfsError if any upload fails (old shards are left untouched on failure)
 */
async function uploadShardsOverwrite(
  ctx: UploadContext,
): Promise<ManifestShard[]> {
  const {
    N,
    K,
    config,
    providers,
    shardBuffers,
    shardPayloads,
    targetVersion,
    io,
  } = ctx;
  const tmpRefs: Nullable<RemoteRef>[] = new Array(N + K).fill(null);

  try {
    for (let i = 0; i < N + K; i++) {
      const shardBuf = shardBuffers[i];
      if (!shardBuf)
        throw new BfsError(`Internal: shard buffer missing for index ${i}`);
      tmpRefs[i] =
        (await providers[i]?.upload(
          `shard_${i}.bfs.${targetVersion}.tmp`,
          shardBuf,
        )) ?? null;
      io.progress(
        `Uploading shard ${i + 1}/${N + K}`,
        ((i + 1) / (N + K)) * 100,
      );
    }
  } catch (err) {
    for (let j = 0; j < tmpRefs.length; j++) {
      const ref = tmpRefs[j];
      if (ref) await providers[j]?.delete(ref).catch(() => {});
    }
    throw new BfsError(
      `Upload failed; old shards untouched. Retry with --overwrite. Cause: ${String(err)}`,
    );
  }

  const manifestShards: ManifestShard[] = [];
  for (let i = 0; i < N + K; i++) {
    const pc = config.providers[i];
    const payload = shardPayloads[i];
    const tmpRef = tmpRefs[i];
    if (!pc || !payload || !tmpRef)
      throw new BfsError(`Internal: shard data missing for index ${i}`);
    const oldRef: RemoteRef = {
      provider_id: pc.id,
      path: `shard_${i}.bfs.${targetVersion}`,
    };
    await providers[i]?.delete(oldRef).catch(() => {});
    await providers[i]?.rename(tmpRef, `shard_${i}.bfs.${targetVersion}`);
    manifestShards.push({
      shard_index: i,
      provider_id: pc.id,
      provider_type: pc.type,
      remote_path: buildRemotePath(
        pc,
        config.vault_name,
        `shard_${i}.bfs.${targetVersion}`,
      ),
      shard_hash: hashBuffer(payload),
    });
  }
  return manifestShards;
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
}> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const targetVersion = manifest.version;
  const cacheDir = path.join(rootDir, '.bfs', 'cache');
  const shardSlots: Nullable<Buffer>[] = new Array(N + K).fill(null);
  let blobSize = 0;
  let kdf_salt: Nullable<Buffer> = null;

  for (const ms of manifest.shards) {
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) {
      io.warn(
        `Provider "${ms.provider_id}" not found in config — skipping shard ${ms.shard_index}`,
      );
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
      const meta = parseShardHeaderOnly(shardData);
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
      io.warn(`Shard ${ms.shard_index} unavailable — skipping`);
    }
  }
  return { shardSlots, blobSize, kdf_salt };
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

  const provider = createProvider(pc, io);
  await provider.authenticate();
  provider.setVaultName(config.vault_name);
  const shardData = await provider.download({
    provider_id: ms.provider_id,
    path: filename,
  });
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
    const p = createProvider(pc, options.io);
    await p.authenticate();
    p.setVaultName(options.vault_name);
  }

  const config: VaultConfig = {
    vault_id: randomUUID(),
    vault_name: options.vault_name,
    version: 1,
    scheme: options.scheme,
    encryption: options.encryption,
    push_mode: options.push_mode,
    providers: options.providers,
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

  const state = await readState(rootDir);
  const { data_shards: N, parity_shards: K } = config.scheme;

  if (config.providers.length !== N + K) {
    throw new BfsError(
      `Scheme requires ${N + K} providers, configured: ${config.providers.length}.`,
    );
  }

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
      `On disk: version ${state.working_version}. Latest: ${state.latest_version}. ` +
        `Push will create version ${targetVersion}. Continue?`,
    );
    if (!cont) throw new BfsError('Push cancelled.');
  }

  // ── Pack blob (or load from cache) ────────────────────────────────────────
  const cachePath = path.join(rootDir, '.bfs', 'cache', 'push.blob.pending');

  type PackData = {
    blob: Buffer;
    rsInput: Buffer;
    blob_hash: string;
    file_count: number;
    total_size: number;
    kdf_salt: Nullable<Buffer>;
    encKey: Buffer | undefined;
    skipped: SkippedFile[];
  };

  let packData: PackData;

  if (options.fromCache) {
    let cachedBlob: Nullable<Buffer> = null;
    try {
      cachedBlob = await fs.readFile(cachePath);
      options.io.info('Using cached blob…');
    } catch {
      options.io.info('No cached blob found — running full pack…');
    }

    if (cachedBlob !== null) {
      // Derive metadata from cached blob and re-encrypt if needed
      const entries = parseBlobFileTable(cachedBlob);
      const cachedFileCount = entries.length;
      const cachedTotalSize = entries.reduce((s, e) => s + Number(e.size), 0);
      const cachedBlobHash = hashBuffer(
        cachedBlob.subarray(0, cachedBlob.length - 32),
      );
      let cachedRsInput: Buffer;
      let cachedKdfSalt: Nullable<Buffer>;
      let cachedEncKey: Buffer | undefined;
      if (config.encryption.enabled) {
        let password: Nullable<string> = options.password ?? null;
        if (!password) {
          password = await options.io.askSecret('Enter encryption password:');
          if (!password)
            throw new BfsError('Password required for encrypted vault.');
        }
        options.io.info('Encrypting…');
        const result = await encryptBlob(cachedBlob, password);
        cachedRsInput = result.encrypted;
        cachedKdfSalt = result.salt;
        cachedEncKey = result.key;
      } else {
        cachedRsInput = cachedBlob;
        cachedKdfSalt = null;
        cachedEncKey = undefined;
      }
      packData = {
        blob: cachedBlob,
        rsInput: cachedRsInput,
        blob_hash: cachedBlobHash,
        file_count: cachedFileCount,
        total_size: cachedTotalSize,
        kdf_salt: cachedKdfSalt,
        encKey: cachedEncKey,
        skipped: [],
      };
    } else {
      // Cache missing — fall back to fresh pack
      await fs.unlink(cachePath).catch(() => {});
      const packed = await packAndEncrypt(rootDir, config, options);
      packData = packed;
    }
  } else {
    // Fresh pack — delete any stale cache first
    await fs.unlink(cachePath).catch(() => {});
    const packed = await packAndEncrypt(rootDir, config, options);
    packData = packed;
  }

  const {
    blob,
    rsInput,
    blob_hash,
    file_count,
    total_size,
    kdf_salt,
    encKey,
    skipped,
  } = packData;

  // ── Handle skipped files ───────────────────────────────────────────────────
  if (skipped.length > 0) {
    // Always cache the blob so the user can resume with --cache
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, blob);

    if (options.interactive) {
      // REPL: show up to 10 files and ask to continue
      const shown = skipped.slice(0, 10);
      const rest = skipped.length - shown.length;
      const fileList =
        shown.map((s) => `  - ${s.path}: ${s.reason}`).join('\n') +
        (rest > 0 ? `\n  ... and ${rest} more` : '');
      const cont = await options.io.confirm(
        `${skipped.length} file(s) could not be read:\n${fileList}\nContinue without them?`,
      );
      if (!cont) {
        await fs.unlink(cachePath).catch(() => {});
        throw new BfsError('Push cancelled.');
      }
      // User accepted — continue with the blob as-is
    } else {
      // Standalone mode: abort before upload
      throw new PushSkippedError(skipped, cachePath);
    }
  }

  // ── Reed-Solomon encode ────────────────────────────────────────────────────
  options.io.info('Encoding with Reed-Solomon…');
  const blobSize = BigInt(rsInput.length);
  const shardPayloads = rsEncode(rsInput, N, K);

  // ── Build location map ─────────────────────────────────────────────────────
  const locationMap: ShardLocation[] = config.providers.map((pc, i) => {
    const payload = shardPayloads[i];
    if (!payload)
      throw new BfsError(`Internal: shard payload missing for index ${i}`);
    return {
      shard_index: i,
      provider_id: pc.id,
      provider_type: pc.type,
      connection_config: pc.config,
      remote_path: buildRemotePath(
        pc,
        config.vault_name,
        `shard_${i}.bfs.${targetVersion}`,
      ),
      shard_hash: hashBuffer(payload),
    };
  });

  // ── Build shard buffers ────────────────────────────────────────────────────
  const shardBuffers = buildShardBuffers(
    config,
    shardPayloads,
    targetVersion,
    blobSize,
    blob_hash,
    kdf_salt,
    encKey,
    locationMap,
  );

  // ── Upload ─────────────────────────────────────────────────────────────────
  options.io.info('Uploading shards…');
  const providers = await openProviders(config, options.io);
  const isOverwrite =
    effectiveMode === PushMode.Overwrite &&
    state.working_version > 0 &&
    targetVersion === state.working_version;
  const uploadCtx: UploadContext = {
    N,
    K,
    config,
    providers,
    shardBuffers,
    shardPayloads,
    targetVersion,
    io: options.io,
  };
  const manifestShards = isOverwrite
    ? await uploadShardsOverwrite(uploadCtx)
    : await uploadShardsNew(uploadCtx);

  // ── Write manifest ─────────────────────────────────────────────────────────
  const manifest: VersionManifest = {
    version: targetVersion,
    pushed_at: new Date().toISOString(),
    file_count,
    total_size,
    blob_hash,
    scheme: config.scheme,
    encrypted: config.encryption.enabled,
    shards: manifestShards,
    health: VersionHealth.Healthy,
  };
  await writeManifest(rootDir, manifest);

  // ── Update state ───────────────────────────────────────────────────────────
  await writeState(rootDir, {
    latest_version: Math.max(state.latest_version, targetVersion),
    working_version: targetVersion,
  });

  // ── Clean up cache on success ──────────────────────────────────────────────
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

  const state = await readState(rootDir);
  const targetVersion = options.version ?? state.latest_version;
  if (targetVersion === 0)
    throw new BfsError('No versions available. Run `bfs push` first.');

  const blobCachePath = path.join(
    rootDir,
    '.bfs',
    'cache',
    'pull.blob.pending',
  );
  const cacheDir = path.join(rootDir, '.bfs', 'cache');

  // Initialized to an empty sentinel; always overwritten before use in the branches below.
  let plainBlob: Buffer = Buffer.alloc(0);
  let isDegraded = false;
  let manifest = await readManifest(rootDir, targetVersion);

  // ── Obtain blob (from cache or by downloading+decoding) ───────────────────
  let loadedFromCache = false;
  if (options.fromCache) {
    try {
      plainBlob = await fs.readFile(blobCachePath);
      options.io.info('Using cached blob…');
      loadedFromCache = true;
    } catch {
      options.io.info('No cached blob found — running full pull…');
    }
  }

  if (!loadedFromCache) {
    if (!manifest)
      throw new BfsError(`Manifest for version ${targetVersion} not found.`);

    const { data_shards: N } = manifest.scheme;

    // Confirm overwrite
    if (!options.force && !options.yes && state.working_version !== 0) {
      const cont = await options.io.confirm(
        `On disk: version ${state.working_version}. ` +
          `Restoring version ${targetVersion} will overwrite directory. Continue?`,
      );
      if (!cont) throw new BfsError('Pull cancelled.');
    }

    // ── Download shards ──────────────────────────────────────────────────────
    options.io.info(`Downloading shards for version ${targetVersion}…`);
    const { shardSlots, blobSize, kdf_salt } = await downloadShardSlots(
      config,
      manifest,
      rootDir,
      options.io,
    );

    const available = shardSlots.filter((s) => s !== null).length;
    if (available < N) {
      throw new BfsError(
        `Not enough shards: need ${N}, got ${available}. Some providers may be offline.`,
      );
    }

    // ── RS decode + optional decrypt ────────────────────────────────────────
    options.io.info('Decoding Reed-Solomon…');
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
    isDegraded = decoded.isDegraded;

    // ── Verify blob hash ─────────────────────────────────────────────────────
    const computedHash = hashBuffer(
      plainBlob.subarray(0, plainBlob.length - 32),
    );
    if (computedHash !== manifest.blob_hash) {
      throw new BfsError(
        'Blob hash mismatch — data corrupted or wrong password.',
      );
    }
  }

  // plainBlob is definitely assigned at this point — both branches above assign it
  // (loadedFromCache path reads from file; !loadedFromCache path reads from decoded)

  // ── Unpack files ───────────────────────────────────────────────────────────
  options.io.info('Unpacking files…');

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

  // ── Handle skipped files ───────────────────────────────────────────────────
  let { extracted, skipped } = await unpackBlob(plainBlob, rootDir);

  if (skipped.length > 0) {
    // Always cache the decoded blob so the user can resume with --cache
    await fs.mkdir(path.dirname(blobCachePath), { recursive: true });
    await fs.writeFile(blobCachePath, plainBlob);

    if (options.interactive) {
      // REPL: retry loop — user can fix permissions and press Y to retry
      while (skipped.length > 0) {
        const shown = skipped.slice(0, 10);
        const rest = skipped.length - shown.length;
        const fileList =
          shown.map((s) => `  - ${s.path}: ${s.reason}`).join('\n') +
          (rest > 0 ? `\n  ... and ${rest} more` : '');
        const retry = await options.io.confirm(
          `${skipped.length} file(s) could not be written:\n${fileList}\n` +
            `Fix permissions, then press Y to retry or N to cancel.`,
        );
        if (!retry) {
          await fs.unlink(blobCachePath).catch(() => {});
          throw new BfsError('Pull cancelled.');
        }
        const result = await unpackBlob(plainBlob, rootDir);
        extracted = result.extracted;
        skipped = result.skipped;
      }
      await fs.unlink(blobCachePath).catch(() => {});
    } else {
      // Standalone mode: abort, keep cache for --cache retry
      throw new PullSkippedError(skipped, blobCachePath);
    }
  }

  // ── Update manifest metadata if incomplete (recovery case) ─────────────────
  manifest = manifest ?? (await readManifest(rootDir, targetVersion));
  if (
    manifest &&
    (manifest.file_count === null || manifest.total_size === null)
  ) {
    const fileEntries = parseBlobFileTable(plainBlob);
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
  if (!isDegraded) {
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
    options.io.warn(
      'Pool degraded — recovered shards kept in .bfs/cache/. ' +
        'Use `bfs provider add` + heal to restore redundancy.',
    );
  }

  // ── Clean up blob cache on success ─────────────────────────────────────────
  await fs.unlink(blobCachePath).catch(() => {});

  return { version: targetVersion, extracted: extracted.length, skipped };
}

/**
 * Deletes specified versions: removes shards from all providers and manifests from disk.
 * Updates state.json if the latest version was pruned.
 *
 * @throws BfsError if config is missing.
 */
export async function prune(
  rootDir: string,
  options: PruneOptions,
): Promise<void> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const state = await readState(rootDir);

  const silentIO: ProviderIO = {
    ask: async () => '',
    askSecret: async () => '',
    confirm: async () => false,
    choose: async (_m, opts) => opts[0] ?? '',
    info: () => {},
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
        const provider = createProvider(pc, silentIO);
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
