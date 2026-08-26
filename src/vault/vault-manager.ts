import { randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseBlobFileTable, parseBlobFileTableFromFile, unpackBlob, unpackBlobFromFile } from '../core/blob-unpack.js';
import { trackFile, untrackFile } from '../core/cleanup.js';
import { decryptBlob, decryptStream, deriveKey, deriveShardNonce } from '../core/crypto.js';
import { BfsError, ProviderError, PullSkippedError, ShardCorruptedError, TamperDetectedError } from '../core/errors.js';
import { hashBuffer, hashFileExcludingTail, SHA256_BYTES, streamToBuffer } from '../core/hash.js';
import { DEFAULT_BFSIGNORE_CONTENT } from '../core/ignore-defaults.js';
import { calcShardPayloadSize, rsDecode, rsDecodeStriped, rsRepair } from '../core/reed-solomon.js';
import { computeShardHeaderSize, parseShardHeaderFromStream } from '../core/shard-io.js';
import { debugEnabled } from '../debug.js';
import { fmt, type Strings, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { FileEntry, ManifestShard, ProviderConfig, ProviderIO, PullResult, ShardHeader, SkippedFile, StorageProvider, VaultConfig, VaultState, VersionManifest } from '../types/index.js';
import { type PushMode, VersionHealth } from '../types/index.js';
import { checkVersionMismatch, detectMissingAdapters, formatMissingAdaptersMessage } from './adapter-preflight.js';
import { parseVersionFromFilename } from './bootstrap.js';
import { assertNoExistingVault, assertSchemeValid, readConfig, writeConfig } from './config.js';
import { applyHealthChange, deleteManifest, listManifests, listUnrecoveredVersions, readManifest, writeManifest } from './manifest.js';
import { confirmRecoveredLocations } from './recovered-locations.js';
import { DEFAULT_STATE, readState, writeState } from './state.js';
import { assertNoForeignVault } from './vault-collision.js';
import { rebuildVersionManifest, type VersionShardEntry } from './version-rebuild.js';

// Public push entry points, re-exported from the push pipeline module.
export {
  _classifyUploadError,
  buildRemotePath,
  push,
} from './push-pipeline.js';

// --- V2 pipeline constants ----------------------------------------------------

/** Fallback stripe size for manifests that predate rs_stripe_size. */
const V2_STRIPE_SIZE = 64 * 1024 * 1024;

// --- Option types -------------------------------------------------------------

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
  /** Directory for the pull scratch dir (downloaded parts). Defaults to os.tmpdir(). */
  tempDir?: string;
  /** Overrides cache directory for pull.blob.pending. Defaults to {rootDir}/.bfs/cache. */
  cacheDir?: string;
  /**
   * When true, pull continues even if some external adapters are missing
   * and Reed-Solomon redundancy can decode from whatever providers remain
   * reachable. Missing built-in providers (local, ftp, ssh) always abort -
   * their absence indicates a broken BFS installation, not a plugin gap.
   */
  allowMissingAdapters?: boolean;
  io: ProviderIO;
}

export interface PruneOptions {
  /** Version numbers to remove from providers and disk. */
  versions: number[];
  /**
   * Deletes even when the operation would leave no restorable version behind.
   * Without it prune refuses that case, so routine housekeeping cannot destroy
   * the last copy that can still be restored; with it an operator can still wipe
   * a backup deliberately.
   */
  force?: boolean;
  /**
   * Optional IO for surfacing best-effort delete failures. Deleting a pruned
   * version's data is best-effort, but a genuine failure would otherwise orphan
   * it on the medium silently; when provided, such failures are warned through here.
   */
  io?: ProviderIO;
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

/**
 * Appends the way out to a refusal: the newest version this directory can restore
 * right now.
 *
 * A refusal that names only the version it cannot restore leaves an operator
 * whose newest version stayed sealed with nowhere to go - while an older one sits
 * right here, ready. The way out belongs in the same breath as the refusal, on
 * every path that turns a restore down.
 *
 * @returns `reason` with the pointer appended, or unchanged when nothing is restorable
 */
async function _withRestorableHint(rootDir: string, reason: string): Promise<string> {
  const restorable = (await listManifests(rootDir)).map((m) => m.version);
  if (restorable.length === 0) return reason;
  const newest = String(Math.max(...restorable));
  return `${reason} ${fmt('pull_restorable_hint', newest, newest)}`;
}

/**
 * Explains why a version has no manifest to restore from.
 *
 * Reached only for a version this directory has no record of at all - one that
 * carries a marker is rebuilt from the storage instead, and refuses in its own
 * words if that fails.
 */
async function _describeMissingVersion(rootDir: string, version: number): Promise<string> {
  return _withRestorableHint(rootDir, fmt('version_not_found', String(version)));
}

/** A manifest rebuilt on the spot, plus the password that opened its location map. */
interface LazyRebuiltVersion {
  manifest: VersionManifest;
  password: Nullable<string>;
}

/**
 * Rebuilds the manifest of a version this directory knows only as a marker -
 * recovery found it on the storage but no password it had opened its location
 * map. Lists the configured storages for that version's parts and reads the map
 * out of a header; nothing is written here, because a manifest is worth recording
 * only once the data it describes is actually out.
 *
 * The password that opens the map is the same one that decrypts the data, so it
 * comes back with the manifest and the caller reuses it - asking twice would read
 * as the first answer having been rejected. The pool holds at most the one
 * password given plus whatever the operator types: `bfs pull` names a single
 * version, so it takes a single password (see decisions.md -> "Pula haseł należy
 * do `recovery`, nie do `pull`").
 *
 * @returns the rebuilt version, or null when this directory has no record of it
 * @throws BfsError when the version is recorded but cannot be rebuilt
 */
async function _rebuildMarkedVersion(rootDir: string, config: VaultConfig, version: number, options: PullOptions): Promise<Nullable<LazyRebuiltVersion>> {
  if (!(await listUnrecoveredVersions(rootDir)).includes(version)) return null;

  const io = options.io;
  const entries: VersionShardEntry[] = [];
  for (const pc of config.providers) {
    try {
      const provider = providerRegistry.create(pc, io);
      await provider.authenticate();
      provider.setVaultName(config.vault_name);
      for (const ref of await provider.list('shard_')) {
        const parsed = parseVersionFromFilename(ref.path);
        if (parsed?.version === version) entries.push({ shardIndex: parsed.shardIndex, provider });
      }
    } catch (err: unknown) {
      // A medium presenting an identity we pinned against is a security signal,
      // not an absent medium: swallowing it here would report "no parts found"
      // for a storage that answered with someone else's certificate or host key.
      if (err instanceof TamperDetectedError) throw err;
      // Anything else - unreachable, refused, empty - is simply a medium that
      // cannot help. Every part of a version carries the same map, so a sibling
      // can still supply it.
    }
  }
  if (entries.length === 0) throw new BfsError(await _withRestorableHint(rootDir, fmt('pull_version_parts_missing', String(version))));

  const passwordPool = options.password !== undefined ? [options.password] : [];
  const passwordSupplied = passwordPool.length > 0;
  const result = await rebuildVersionManifest(version, entries, { vaultName: config.vault_name, vaultId: config.vault_id, passwordPool, caller: 'pull', io });
  switch (result.outcome) {
    case 'recovered':
      // Whatever opened the map is last in the pool: either the one password
      // supplied, or the one the operator typed, which is appended on acceptance.
      return { manifest: result.manifest, password: passwordPool[passwordPool.length - 1] ?? null };
    case 'map_unopened':
      throw new BfsError(await _withRestorableHint(rootDir, passwordSupplied ? fmt('pull_version_map_unopened', String(version)) : fmt('pull_version_password_required', String(version))));
    case 'unusable':
      throw new BfsError(await _withRestorableHint(rootDir, fmt('pull_version_parts_unreadable', String(version))));
  }
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

// --- Shard failure diagnostics -----------------------------------------------

type ShardFailureReason = 'provider_unreachable' | 'file_missing' | 'adapter_missing' | 'corrupt' | 'provider_not_configured';

/**
 * Classifies why a shard could not be read, from the error the attempt raised.
 *
 * The distinction is what the operator acts on: unreadable content calls for a
 * repair, an unreachable medium for reconnecting it. Anything unrecognised is
 * reported as absent - the conservative reading, since a part that could not be
 * obtained is, as far as the restore is concerned, not there.
 *
 * @param err - Error thrown while fetching or parsing the shard
 * @returns the failure reason to record for that shard
 */
function _failureReason(err: unknown): ShardFailureReason {
  if (err instanceof ShardCorruptedError) return 'corrupt';
  if (err instanceof ProviderError) return 'provider_unreachable';
  return 'file_missing';
}

/**
 * Classifies a failure from the download phase, where the medium has already
 * answered its health check: data that arrived but does not parse is damage,
 * anything else is read as absent. Calling damage "absent" would send the
 * operator hunting for a medium that never left, instead of at the repair.
 *
 * {@link _failureReason} does not stand in here - it maps every ProviderError to
 * an unreachable medium, which at this point would blame a medium that responded
 * moments earlier.
 *
 * @param err - Error thrown while fetching or parsing the shard
 * @returns the failure reason to record for that shard
 */
function _downloadFailureReason(err: unknown): ShardFailureReason {
  return err instanceof ShardCorruptedError ? 'corrupt' : 'file_missing';
}

/**
 * Builds the sentence naming which media failed and how, for a restore that
 * cannot go ahead.
 *
 * What the operator does next depends entirely on the cause - a medium that could
 * not be reached calls for reconnecting it, damaged data for a look at which
 * versions survived - so each cause names its own media instead of the whole set
 * being blamed on one guess. Rebuilding is deliberately not offered here: this
 * runs only below the reconstruction threshold, where a repair cannot succeed
 * either. Only the medium's name is disclosed: its address and credentials are
 * the provider's business, and BFS-core does not read them.
 *
 * @param manifest - Version manifest, to map shard indexes to medium names
 * @param failures - Shard index -> why that shard could not be used
 * @returns a sentence per cause, or an empty string when nothing was recorded
 */
function _describeShardFailures(manifest: VersionManifest, failures: Map<number, ShardFailureReason>): string {
  const naming: Array<{ reason: ShardFailureReason; key: keyof Strings }> = [
    { reason: 'corrupt', key: 'pull_failed_on_damaged' },
    { reason: 'file_missing', key: 'pull_failed_on_missing' },
    { reason: 'provider_unreachable', key: 'pull_failed_on_unreachable' },
    { reason: 'adapter_missing', key: 'pull_failed_on_adapter_missing' },
    { reason: 'provider_not_configured', key: 'pull_failed_on_not_configured' },
  ];

  const parts: string[] = [];
  for (const { reason, key } of naming) {
    const ids = _mediaFailingWith(manifest, failures, reason);
    if (ids.length > 0) parts.push(fmt(key, ids.join(', ')));
  }
  return parts.join(' ');
}

/**
 * Collects the media that failed for one cause, under the names the backup
 * records for them.
 *
 * @param manifest - Version manifest, to map shard indexes to medium names
 * @param failures - Shard index -> why that shard could not be used
 * @param reason - The cause to collect media for
 * @returns the medium names recorded for that cause
 */
function _mediaFailingWith(manifest: VersionManifest, failures: Map<number, ShardFailureReason>, reason: ShardFailureReason): string[] {
  return [...failures.entries()]
    .filter(([, r]) => r === reason)
    .map(([index]) => manifest.shards.find((s) => s.shard_index === index)?.provider_id)
    .filter((id): id is string => id !== undefined);
}

/** Inputs for {@link _notEnoughShards}. */
interface NotEnoughShardsOptions {
  /** Version manifest being restored - maps shard indexes to medium names. */
  manifest: VersionManifest;
  /** Parts required to reconstruct (N). */
  needed: number;
  /** Parts actually usable. */
  have: number;
  /** Shard index -> why that shard could not be used. */
  failures: Map<number, ShardFailureReason>;
}

/**
 * Reports that too few parts survived to rebuild the version, naming the media
 * behind each cause when the caller collected them.
 *
 * @param options - Manifest, counts and the per-shard failure map
 * @returns the error to throw at the caller's failure point
 */
function _notEnoughShards(options: NotEnoughShardsOptions): BfsError {
  const detail = _describeShardFailures(options.manifest, options.failures);
  const count = fmt('pull_not_enough_shards', String(options.needed), String(options.have));
  return new BfsError(detail ? `${count} ${detail}` : count);
}

/**
 * Emits appropriate degradation warnings based on shard failure reasons.
 *
 * @param failures - Shard index -> why that shard could not be used
 * @param manifest - Version manifest, to name the media the configuration lost;
 *   that one warning is withheld when it is unavailable, since a name the
 *   operator cannot act on is worse than silence
 * @param io - ProviderIO the warnings are written to
 */
function _emitDegradedWarnings(failures: Map<number, ShardFailureReason>, manifest: Nullable<VersionManifest>, io: ProviderIO): void {
  const reasons = [...failures.values()];
  if (reasons.some((r) => r === 'provider_unreachable')) {
    io.warn(t('vault_degraded_provider_unreachable'));
  }
  if (reasons.some((r) => r === 'file_missing')) {
    io.warn(t('vault_degraded_file_missing'));
  }
  if (reasons.some((r) => r === 'adapter_missing')) {
    io.warn(t('vault_degraded_adapter_missing'));
  }
  if (reasons.some((r) => r === 'corrupt')) {
    io.warn(t('vault_degraded_corrupt'));
  }
  // A medium the backup records but the configuration has lost reads two ways -
  // a name lost by accident, or one the operator deliberately removed - and this
  // code cannot tell them apart. Naming the medium and offering both routes lets
  // the operator pick; assuming the first would tell someone who just ran
  // `provider remove` to undo it.
  if (manifest !== null && reasons.some((r) => r === 'provider_not_configured')) {
    const ids = _mediaFailingWith(manifest, failures, 'provider_not_configured');
    if (ids.length > 0) io.warn(fmt('vault_degraded_provider_not_configured', ids.join(', ')));
  }
}

/**
 * Drains one shard's payload to finalize its trailing SHA-256, then returns the
 * per-version blob_size and kdf_salt from its header - or null if the checksum
 * fails. The salt is shared across a version's shards, so any checksum-clean
 * shard is an authoritative source; a bit-rotted kdf_salt also corrupts this
 * checksum, so a damaged shard is rejected here and a healthy sibling supplies
 * the salt instead. The stream is drained through a null sink, so peak RAM stays
 * O(chunk), not O(shard).
 *
 * @param payloadStream - checksum-verified payload stream from parseShardHeaderFromStream
 * @param header        - parsed shard header carrying blob_size and kdf_salt
 * @returns `meta` with the version's blob_size and kdf_salt, or null `meta` when
 *   the read did not complete; `corrupt` tells the two apart - true only for a
 *   failed checksum, false for a read that broke for any other reason and says
 *   nothing about the bytes
 */
async function _adoptSaltFromVerifiedShard(payloadStream: Readable, header: ShardHeader): Promise<{ meta: Nullable<{ blobSize: number; kdf_salt: Nullable<Buffer> }>; corrupt: boolean }> {
  try {
    await pipeline(
      payloadStream,
      new Writable({
        write(_chunk, _enc, cb) {
          cb();
        },
      }),
    );
    return { meta: { blobSize: Number(header.blob_size), kdf_salt: header.kdf_salt }, corrupt: false };
  } catch (err) {
    if (debugEnabled) {
      process.stderr.write(`[bfs:debug] salt-source shard failed checksum, deferring to a sibling: ${err instanceof Error ? err.message : String(err)}\n`);
    }
    payloadStream.destroy();
    // Only a failed checksum condemns the part. A read that broke for any other
    // reason - a file briefly locked by a scanner, an I/O hiccup - says nothing
    // about the bytes, so it must not be reported as damage; the part keeps its
    // place and is read again, independently, by _validateShardIntegrity.
    return { meta: null, corrupt: err instanceof ShardCorruptedError };
  }
}

/**
 * Phase 1 of V2 pull: downloads all available shards to temp files.
 * Parses each shard header to extract `blobSize` and `kdf_salt`.
 * Populates `tmpPaths` map with shard_index -> tmpPath for successfully downloaded shards.
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
      failures.set(ms.shard_index, 'provider_not_configured');
      options.io.warn(fmt('pull_provider_not_found_skip', ms.provider_id));
      continue;
    }
    // Adapter for pc.type may be unregistered (an external adapter left
    // uninstalled after passing preflight with --allow-missing-adapters).
    // create() throws for an unknown type - skip the shard so Reed-Solomon
    // decodes from the remaining providers, mirroring bootstrap's connectOne.
    let probe: StorageProvider;
    try {
      probe = providerRegistry.create(pc, options.io);
    } catch {
      failures.set(ms.shard_index, 'adapter_missing');
      options.io.warn(fmt('vault_provider_adapter_missing', pc.id));
      continue;
    }
    // Check provider health BEFORE authenticate to avoid interactive prompts
    // (e.g. LocalFS asking to create a missing directory during pull)
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
      await pipeline(stream, createWriteStream(tmpPath, { mode: 0o600 }));
      if (debugEnabled) {
        const stat = await fs.stat(tmpPath);
        process.stderr.write(`[bfs:debug] shard ${ms.shard_index} downloaded: ${stat.size} bytes\n`);
      }
      // Parse header from stable temp file. Adopt the per-version blob_size and
      // kdf_salt only from a shard whose trailing checksum verifies
      // (_adoptSaltFromVerifiedShard); one that fails there is dropped with its
      // cause recorded, while a shard read after the size is known is checked
      // later by _validateShardIntegrity instead. Destroying the streams stops
      // the orphaned background SHA-256 task from holding the file handle open
      // on Windows.
      const fs1 = createReadStream(tmpPath);
      const { header, payloadStream } = await parseShardHeaderFromStream(fs1);
      if (blobSize === 0) {
        const { meta, corrupt } = await _adoptSaltFromVerifiedShard(payloadStream, header);
        if (meta) {
          blobSize = meta.blobSize;
          kdf_salt = meta.kdf_salt;
        } else if (corrupt) {
          // The part read back but failed its own checksum. Recording that here
          // is what lets the restore name this medium as damaged instead of
          // dying on an unread size with nothing to act on.
          fs1.destroy();
          failures.set(ms.shard_index, 'corrupt');
          options.io.warn(fmt('vault_shard_damaged_on_provider', pc.id));
          continue;
        }
      } else {
        payloadStream.on('error', () => {}).destroy();
      }
      fs1.destroy();
      tmpPaths.set(ms.shard_index, tmpPath);
      options.io.progress(fmt('vault_download_shard_progress', String(ms.shard_index + 1), String(N + K)), ((ms.shard_index + 1) / (N + K)) * 100);
    } catch (err) {
      const reason = _downloadFailureReason(err);
      failures.set(ms.shard_index, reason);
      const notice = reason === 'corrupt' ? 'vault_shard_damaged_on_provider' : 'vault_file_missing_on_provider';
      options.io.warn(fmt(notice, pc.id));
    }
  }
  if (debugEnabled) {
    const indices = [...tmpPaths.keys()].sort((a, b) => a - b);
    process.stderr.write(`[bfs:debug] download done: shards=[${indices.join(',')}] blobSize=${blobSize} kdf_salt=${kdf_salt !== null ? 'yes' : 'null'}\n`);
  }
  return { blobSize, kdf_salt, failures };
}

/** Inputs for {@link _decodeFromTempFiles} - phase 2 of the V2 pull. */
interface DecodeFromTempFilesOptions {
  /** Map of shard_index -> temp file path (only present shards). */
  tmpPaths: Map<number, string>;
  /** Number of data shards. */
  N: number;
  /** Number of parity shards. */
  K: number;
  /** Bytes per shard per stripe (from manifest or V2_STRIPE_SIZE). */
  stripeSize: number;
  /** Total blob byte count (from shard header). */
  blobSize: number;
  /** Version being decoded (used to derive the per-shard nonce). */
  targetVersion: number;
  /** AES-256-GCM key for per-shard decryption; undefined if not encrypted. */
  encKey: Buffer | undefined;
  /** Destination file for the decoded blob. */
  outputPath: string;
  /** ProviderIO for progress messages. */
  io: ProviderIO;
}

/**
 * Phase 2 of V2 pull: opens fresh streams from temp files, RS-decodes, writes blob.
 * Each shard stream is opened independently - no cross-stream race conditions.
 */
async function _decodeFromTempFiles(options: DecodeFromTempFilesOptions): Promise<void> {
  const { tmpPaths, N, K, stripeSize, blobSize, targetVersion, encKey, outputPath, io } = options;
  const payloadStreams: Nullable<Readable>[] = new Array(N + K).fill(null);
  for (const [shardIdx, tmpPath] of tmpPaths) {
    // Belt-and-suspenders error sinks for the per-shard decode fan-out, each
    // attached the instant its stream is created (no gap before the eager
    // pipe inside decryptStream). On a wrong key every shard's decrypt flush
    // throws; only the shard the RS decoder is actively reading surfaces the
    // error to the caller (async-iterator rejection -> output.destroy ->
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
  // destroy blobStream during the mkdir await -> 'error' emitted with no
  // listener -> unhandled exception crashing the process.
  await fs.mkdir(path.dirname(outputPath), { recursive: true, mode: 0o700 });
  const blobStream = rsDecodeStriped(payloadStreams, { N, K, stripeSize, blobSize, debugLog });
  // outputPath is pull.blob.pending - a full plaintext copy of the restored
  // data; create it owner-only and tighten an already-existing inode (no-op on
  // Windows NTFS).
  await pipeline(blobStream, createWriteStream(outputPath, { mode: 0o600 }));
  await fs.chmod(outputPath, 0o600).catch(() => {});
}

/** Inputs for {@link _validateShardIntegrity} - phase 1.5 of the V2 pull. */
interface ValidateShardsOptions {
  /** shard_index -> temp path (present shards); corrupt entries are removed in place. */
  tmpPaths: Map<number, string>;
  /** AES-256-GCM key when the vault is encrypted; undefined otherwise. */
  encKey: Buffer | undefined;
  /** Version being decoded - derives the per-shard nonce. */
  targetVersion: number;
  /** Shard failure map; corrupt shards are added with reason 'corrupt'. */
  failures: Map<number, ShardFailureReason>;
  /** Version manifest, to name the medium a rejected part came from. */
  manifest: VersionManifest;
  /** ProviderIO the per-medium damage notice is written to. */
  io: ProviderIO;
}

/**
 * Phase 1.5 of V2 pull: reads each downloaded shard end-to-end through the SAME
 * integrity path the decoder uses - trailing-checksum verification plus, when
 * encrypted, per-shard GCM decryption. A shard that fails is dropped from
 * `tmpPaths` and recorded as 'corrupt', so Reed-Solomon reconstructs it from the
 * remaining healthy shards + parity, exactly as it does for a missing shard.
 * Without this, a present-but-corrupt shard would surface its error mid-decode
 * and abort the whole restore even when the redundancy to survive it is intact.
 * Streams are drained, never buffered - peak RAM stays O(chunk), not O(shard).
 * Each rejected part names its medium, so a restore that survives on redundancy
 * still tells the operator where the damage is.
 *
 * @param options - tmpPaths (mutated: corrupt removed), encKey, targetVersion, failures (mutated), manifest, io
 * @returns nothing; mutates `tmpPaths` and `failures` in place
 */
async function _validateShardIntegrity(options: ValidateShardsOptions): Promise<void> {
  const { tmpPaths, encKey, targetVersion, failures, manifest, io } = options;
  for (const [shardIdx, tmpPath] of [...tmpPaths]) {
    try {
      const fileStream = createReadStream(tmpPath);
      fileStream.on('error', () => {});
      const { payloadStream } = await parseShardHeaderFromStream(fileStream);
      payloadStream.on('error', () => {});
      // Same read-path as decode: checksum-verified payload, then per-shard GCM
      // when encrypted. Drain into a null sink - the trailing SHA-256 (and GCM
      // auth tag) are finalized at end-of-stream, so a clean drain proves the
      // shard decodes; any mismatch rejects the pipeline.
      const validated = encKey ? decryptStream(payloadStream, encKey, deriveShardNonce(encKey, targetVersion, shardIdx)) : payloadStream;
      await pipeline(
        validated,
        new Writable({
          write(_chunk, _enc, cb) {
            cb();
          },
        }),
      );
    } catch (err) {
      // Only a physically corrupt shard (bad trailing checksum / truncation) is
      // excluded and reconstructed from parity. A GCM DecryptionError with an
      // intact checksum means the bytes are sound but authentication failed - a
      // wrong password fails this way on every shard, so rethrow it to surface a
      // clear password error instead of a misleading "not enough shards".
      if (!(err instanceof ShardCorruptedError)) throw err;
      tmpPaths.delete(shardIdx);
      failures.set(shardIdx, 'corrupt');
      // Which medium holds the damage is the one thing the operator can act on,
      // and a restore that survives on redundancy is exactly where it would
      // otherwise go unsaid - the summary sentence only appears when the restore
      // fails outright.
      const damaged = manifest.shards.find((s) => s.shard_index === shardIdx)?.provider_id;
      if (damaged !== undefined) io.warn(fmt('vault_shard_damaged_on_provider', damaged));
      if (debugEnabled) {
        process.stderr.write(`[bfs:debug] shard ${shardIdx} failed integrity check: ${err.message}\n`);
      }
    }
  }
}

/**
 * V2 pull path: two-phase approach - every shard is first downloaded to a temp
 * file, then re-opened as a fresh stream for the RS decode, so verifying one
 * shard's trailing SHA-256 can never race the decoder reading another.
 *
 * @param config     - Vault configuration with provider list
 * @param manifest   - Version manifest describing the shards to download
 * @param options    - Pull options including io, password, and tempDir
 * @param outputPath - Destination file for the decoded blob
 * @returns { isDegraded, failures } - degradation flag (fewer than N+K shards
 *          usable) plus shard index -> why that shard could not be used
 * @throws BfsError if fewer than N shards available, password missing, or kdf_salt not found
 */
async function _pullV2(config: VaultConfig, manifest: VersionManifest, options: PullOptions, outputPath: string): Promise<{ isDegraded: boolean; failures: Map<number, ShardFailureReason> }> {
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const targetVersion = manifest.version;
  const stripeSize = manifest.rs_stripe_size ?? V2_STRIPE_SIZE;
  // Scratch dir under the system temp (or an explicitly configured temp dir) -
  // removed in finally. Only an explicit temp dir is validated: os.tmpdir()
  // always exists, and the error hint would point back at it anyway. mkdtemp
  // rather than a predictable name: the system temp is shared, so a guessable
  // path would be open to link planting and would leak backup data via the
  // default file mode.
  const explicitTempDir = options.tempDir ?? config.temp_dir ?? null;
  if (explicitTempDir !== null) {
    await _validateConfigDir(explicitTempDir, 'temp-dir');
    // The validation accepts a not-yet-existing leaf (only the parent must
    // exist) and mkdtemp does not create parents - so create it here.
    await fs.mkdir(explicitTempDir, { recursive: true, mode: 0o700 });
  }
  const tmpDir = await fs.mkdtemp(path.join(explicitTempDir ?? os.tmpdir(), 'bfs-pull-'));
  await fs.chmod(tmpDir, 0o700).catch(() => {});
  const tmpPaths = new Map<number, string>();
  try {
    const { blobSize, kdf_salt, failures } = await _downloadShardsToTempFiles(config, manifest, options, tmpDir, tmpPaths);
    if (tmpPaths.size < N) throw _notEnoughShards({ manifest, needed: N, have: tmpPaths.size, failures });
    if (blobSize === 0) throw new BfsError(t('pull_blob_size_unreadable'));
    const shardSize = calcShardPayloadSize(blobSize, N);
    const numStripes = Math.ceil(shardSize / stripeSize);
    if (debugEnabled) {
      process.stderr.write(`[bfs:debug] _pullV2: blobSize=${blobSize} stripeSize=${stripeSize}` + ` shardSize=${shardSize} numStripes=${numStripes}` + ` encrypted=${manifest.encrypted} N=${N} K=${K}\n`);
    }
    let encKey: Buffer | undefined;
    if (manifest.encrypted) {
      let password: Nullable<string> = options.password ?? null;
      if (!password) password = await options.io.askSecret(t('vault_ask_decrypt_password'));
      if (!password) throw new BfsError(t('vault_password_required'));
      if (!kdf_salt) throw new BfsError(t('pull_salt_missing'));
      options.io.info(t('vault_decrypting'));
      encKey = await deriveKey(password, kdf_salt);
    }
    // Pre-validate every downloaded shard end-to-end before decode: a present
    // but corrupt shard (bit rot, truncation, tamper) is excluded here and
    // reconstructed from the healthy shards + parity, instead of poisoning the
    // decode and aborting the whole restore.
    await _validateShardIntegrity({ tmpPaths, encKey, targetVersion, failures, manifest, io: options.io });
    if (tmpPaths.size < N) throw _notEnoughShards({ manifest, needed: N, have: tmpPaths.size, failures });
    await _decodeFromTempFiles({ tmpPaths, N, K, stripeSize, blobSize, targetVersion, encKey, outputPath, io: options.io });
    return { isDegraded: tmpPaths.size < N + K, failures };
  } finally {
    for (const [, p] of tmpPaths) await fs.unlink(p).catch(() => {});
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// --- Internal helpers ---------------------------------------------------------

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
      failures.set(ms.shard_index, 'provider_not_configured');
      io.warn(fmt('pull_provider_not_found_skip', ms.provider_id));
      continue;
    }
    // See _downloadShardsToTempFiles: an unregistered adapter type must skip
    // the shard, not crash the pull, so Reed-Solomon decodes from the rest.
    let probe: StorageProvider;
    try {
      probe = providerRegistry.create(pc, io);
    } catch {
      failures.set(ms.shard_index, 'adapter_missing');
      io.warn(fmt('vault_provider_adapter_missing', pc.id));
      continue;
    }
    if (!(await probe.healthCheck())) {
      failures.set(ms.shard_index, 'provider_unreachable');
      io.warn(fmt('vault_provider_unreachable', pc.id));
      continue;
    }
    try {
      const shardData = await fetchShard({ pc, ms, config, cacheDir, targetVersion, io });
      // fetchShard returns null for a part whose bytes no longer match the hash
      // recorded for it - the part is there and readable, its contents are not
      // what they should be. That is damage, and the failure report must say so
      // rather than leave this medium unaccounted for.
      if (!shardData) {
        failures.set(ms.shard_index, 'corrupt');
        continue;
      }
      const { header: meta } = await parseShardHeaderFromStream(Readable.from(shardData));
      if (meta.shard_index !== ms.shard_index || meta.version !== targetVersion || meta.vault_id !== config.vault_id) {
        failures.set(ms.shard_index, 'corrupt');
        io.warn(fmt('pull_shard_header_invalid_skip', ms.provider_id));
        continue;
      }
      shardSlots[ms.shard_index] = extractShardPayload(shardData);
      if (blobSize === 0) blobSize = Number(meta.blob_size);
      if (!kdf_salt && meta.kdf_salt) kdf_salt = meta.kdf_salt;
      io.progress(fmt('vault_download_shard_progress', String(ms.shard_index + 1), String(N + K)), ((ms.shard_index + 1) / (N + K)) * 100);
    } catch (err) {
      // The per-medium notice has to agree with the cause recorded for it -
      // otherwise one run tells the operator "missing" here and "damaged" in the
      // closing sentence, about the same medium.
      const reason = _failureReason(err);
      failures.set(ms.shard_index, reason);
      io.warn(fmt(reason === 'corrupt' ? 'vault_shard_damaged_on_provider' : 'vault_file_missing_on_provider', pc.id));
    }
  }
  return { shardSlots, blobSize, kdf_salt, failures };
}

/** Inputs for {@link fetchShard}. */
interface FetchShardOptions {
  /** Provider config to download from. */
  pc: ProviderConfig;
  /** Manifest entry for the shard (index, provider, hash). */
  ms: ManifestShard;
  /** Vault config (vault_name, vault_id). */
  config: VaultConfig;
  /** Local cache directory checked before the network. */
  cacheDir: string;
  /** Version being pulled (shard filename suffix). */
  targetVersion: number;
  /** ProviderIO for warnings. */
  io: ProviderIO;
}

/**
 * Fetches a single shard: tries the local cache first, then downloads from the provider.
 * Validates the payload hash. Returns null if the shard should be skipped.
 */
async function fetchShard(options: FetchShardOptions): Promise<Nullable<Buffer>> {
  const { pc, ms, config, cacheDir, targetVersion, io } = options;
  const filename = `shard_${ms.shard_index}.bfs.${targetVersion}`;
  const cacheFile = path.join(cacheDir, filename);

  // Try cache first - avoid network round-trip if payload hash matches
  try {
    const cached = await fs.readFile(cacheFile);
    if (hashBuffer(extractShardPayload(cached)) === ms.shard_hash) return cached;
    await fs.unlink(cacheFile).catch(() => {});
  } catch {
    // cache miss - proceed to provider download
  }

  const provider = providerRegistry.create(pc, io);
  await provider.authenticate();
  provider.setVaultName(config.vault_name);
  const shardStream = await provider.download({ provider_id: ms.provider_id, path: filename });
  const shardData = await streamToBuffer(shardStream);
  if (hashBuffer(extractShardPayload(shardData)) !== ms.shard_hash) {
    io.warn(fmt('pull_shard_hash_mismatch_skip', ms.provider_id));
    return null;
  }
  return shardData;
}

/** Inputs for {@link decodeAndDecrypt}. */
interface DecodeAndDecryptArgs {
  /** Downloaded shard payloads (null = missing, triggers RS repair). */
  shardSlots: Nullable<Buffer>[];
  /** Version manifest (scheme, encrypted flag). */
  manifest: VersionManifest;
  /** KDF salt from a shard header (encrypted vaults). */
  kdf_salt: Nullable<Buffer>;
  /** Plain blob size before RS encode (padding removal). */
  blobSize: number;
  /** Version being decoded (repaired-shard cache filename). */
  targetVersion: number;
  /** Cache directory where repaired shards are written. */
  cacheDir: string;
  /** Pull options (io, password). */
  options: PullOptions;
}

/**
 * RS-decodes the shard slots into a single blob and optionally decrypts it.
 * In degraded mode (some slots null), runs RS repair and caches the repaired shards.
 * If the vault is encrypted, prompts for the password (unless already provided in options).
 *
 * @throws BfsError if fewer than N shards are available, password is missing, or kdf_salt not found
 */
async function decodeAndDecrypt(args: DecodeAndDecryptArgs): Promise<{ plainBlob: Buffer; isDegraded: boolean }> {
  const { shardSlots, manifest, kdf_salt, blobSize, targetVersion, cacheDir, options } = args;
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const isDegraded = shardSlots.some((s) => s === null);
  let rsOutput: Buffer;

  if (isDegraded) {
    options.io.info(t('pull_degraded_repair'));
    const repaired = rsRepair(shardSlots, N, K);
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    for (let i = 0; i < N + K; i++) {
      if (shardSlots[i] === null) {
        const repairedShard = repaired[i];
        if (!repairedShard) continue;
        await fs.writeFile(path.join(cacheDir, `shard_${i}.bfs.${targetVersion}.repaired`), repairedShard, { mode: 0o600 }).catch(() => {});
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
  if (!password) password = await options.io.askSecret(t('vault_ask_decrypt_password'));
  if (!password) throw new BfsError(t('vault_password_required'));
  if (!kdf_salt) throw new BfsError(t('pull_salt_missing'));
  options.io.info(t('vault_decrypting'));
  return { plainBlob: await decryptBlob(rsOutput, password, kdf_salt), isDegraded };
}

// --- Public API ---------------------------------------------------------------

/**
 * Initialises a new vault in rootDir. Refuses a directory that already describes
 * one, so an existing backup's configuration is never replaced.
 * Creates .bfs/, .bfs/manifests/, config.json, state.json.
 * Writes default .bfsignore if missing.
 * Probes each provider (probeConnection creates the base directory and
 * round-trips a probe file) and refuses a location that already holds a
 * different backup, so configuration errors surface before config.json is
 * written and before the first push.
 *
 * @throws VaultAlreadyInitializedError if rootDir already holds .bfs/config.json.
 * @throws BfsError if providers.length !== data_shards + parity_shards.
 * @throws ProviderError if a provider's location cannot be provisioned or reached.
 * @throws VaultCollisionError if a provider's location already holds a different backup.
 */
export async function init(rootDir: string, options: InitOptions): Promise<void> {
  // Before anything else, and before any medium is touched: a directory that
  // already describes a backup is not a place to set one up. registerInit checks
  // this too, early enough to spare the operator the questionnaire; this one
  // covers every other caller of the vault API.
  await assertNoExistingVault(rootDir);

  const { data_shards: N, parity_shards: K } = options.scheme;
  if (options.providers.length !== N + K) {
    throw new BfsError(fmt('scheme_provider_count_mismatch', String(N + K), String(options.providers.length)));
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

  // Set up and verify every provider BEFORE writing config: probeConnection()
  // creates the target directory and round-trips a probe file, so a provider
  // whose base path is missing/unwritable - or whose type is unknown - fails
  // here instead of leaving a corrupted config on disk, and instead of only
  // surfacing at the first push. Runs for --ci too, where the interactive
  // pre-probe (probeProviderWithRecovery in init.ts) never ran. setVaultName()
  // must precede probeConnection(): it resolves the probe path under the vault
  // sub-directory.
  for (const pc of options.providers) {
    const p = providerRegistry.create(pc, options.io);
    p.setVaultName(options.vault_name);
    await p.probeConnection();
    // Refuse a target that already holds a DIFFERENT backup of the same name: a
    // fresh init has no vault_id yet, so any shard present is foreign. Stops a
    // later push from silently overwriting another machine's shards.
    await assertNoForeignVault(p, options.vault_name, null, options.io);
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

// --- pull() private helpers ---------------------------------------------------

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
    // --yes and --force are exactly the channel for this consent, so a run with
    // nobody in it is told to use one instead of being handed a cancellation it
    // never chose and a retry that would end the same way.
    if (options.io.interactive === false) {
      throw new BfsError(fmt('pull_overwrite_no_operator', String(workingVersion), String(targetVersion)));
    }
    const cont = await options.io.confirm(fmt('vault_pull_overwrite_confirm', String(workingVersion), String(targetVersion)));
    if (!cont) throw new BfsError(t('pull_cancelled'));
  }
  let plainBlob: Buffer = Buffer.alloc(0);
  let shardFailures = new Map<number, ShardFailureReason>();
  if (isV2) {
    await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
    trackFile(blobCachePath);
    const decoded = await _pullV2(config, manifest, options, blobCachePath);
    shardFailures = decoded.failures;
  } else {
    const { data_shards: N } = manifest.scheme;
    options.io.info(fmt('vault_download_shards', String(targetVersion)));
    const downloaded = await downloadShardSlots(config, manifest, rootDir, options.io);
    shardFailures = downloaded.failures;
    const available = downloaded.shardSlots.filter((s) => s !== null).length;
    if (available < N) throw _notEnoughShards({ manifest, needed: N, have: available, failures: shardFailures });
    options.io.info(t('vault_decoding_rs'));
    const decoded = await decodeAndDecrypt({ shardSlots: downloaded.shardSlots, manifest, kdf_salt: downloaded.kdf_salt, blobSize: downloaded.blobSize, targetVersion, cacheDir, options });
    plainBlob = decoded.plainBlob;
  }
  const computedHash = isV2 ? await hashFileExcludingTail(blobCachePath, SHA256_BYTES) : hashBuffer(plainBlob.subarray(0, plainBlob.length - SHA256_BYTES));
  if (computedHash !== manifest.blob_hash) {
    if (isV2) await fs.unlink(blobCachePath).catch(() => {});
    throw new BfsError(t('pull_blob_hash_mismatch'));
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
      throw new BfsError(t('pull_cancelled'));
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
      await fs.mkdir(path.dirname(blobCachePath), { recursive: true, mode: 0o700 });
      trackFile(blobCachePath);
      // pull.blob.pending is a full plaintext copy of the restored data; keep it
      // owner-only even when cacheDir already existed with looser permissions.
      await fs.writeFile(blobCachePath, plainBlob, { mode: 0o600 });
      await fs.chmod(blobCachePath, 0o600).catch(() => {});
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
  // Both manifests that reach here with no file count are written now, and for the
  // same reason: this is the first moment their numbers are known. One came from a
  // recovery, which cannot read them out of a shard header; the other was rebuilt
  // during this very pull and has never been on disk at all - until the data is
  // out, that version stays a marker, so an attempt cut short leaves the next one
  // a clean starting point instead of a record of a restore that never finished.
  if (manifest && (manifest.file_count === null || manifest.total_size === null)) {
    const fileEntries = isV2 ? await parseBlobFileTableFromFile(blobCachePath) : parseBlobFileTable(plainBlob);
    manifest.file_count = fileEntries.length;
    manifest.total_size = fileEntries.reduce((s, e) => s + Number(e.size), 0);
    await writeManifest(rootDir, manifest);
  }
  // The rest of the state rides along. `writeState` replaces the file, so naming
  // only the two fields a pull owns would drop `locations_confirmed` - and an
  // absent flag reads as confirmed, retiring the gate that makes the first write
  // path show the operator where a recovered config points. Reading from those
  // storages is not that approval: Reed-Solomon lets a pull finish while one of
  // them was never reached at all.
  await writeState(rootDir, { ...state, latest_version: Math.max(state.latest_version, targetVersion), working_version: targetVersion });
  if (shardFailures.size === 0) {
    try {
      const cacheEntries = await fs.readdir(cacheDir);
      for (const entry of cacheEntries) {
        if (entry === 'pull.blob.pending') continue;
        await fs.unlink(path.join(cacheDir, entry)).catch(() => {});
      }
    } catch {
      // cache dir may not exist - fine
    }
  } else {
    _emitDegradedWarnings(shardFailures, manifest, io);
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
  if (!config) throw new BfsError(t('pull_no_config'));
  assertSchemeValid(config);
  await _runPullPreflight(config, options);

  const state = await readState(rootDir);
  const targetVersion = options.version ?? state.latest_version;
  if (targetVersion === 0) throw new BfsError(t('no_versions_available'));

  // Priority: CLI flag -> config.json -> default
  const cacheDir = options.cacheDir ?? config.cache_dir ?? path.join(rootDir, '.bfs', 'cache');
  const blobCachePath = path.join(cacheDir, 'pull.blob.pending');
  await _validateConfigDir(cacheDir, 'cache-dir');

  // A version recovery met but could not open has no manifest - only a marker
  // saying it is out there. Rebuild it from the parts before anything else: the
  // password that opens its location map is the same one that decrypts its data,
  // so the operator reaching for this version supplies it either way. This runs
  // ahead of the cached-blob path on purpose - letting `--cache` past it would
  // unpack the data and leave the version still marked, restored and unrecovered
  // at once.
  const stored = await readManifest(rootDir, targetVersion);
  const lazy = stored === null ? await _rebuildMarkedVersion(rootDir, config, targetVersion, options) : null;
  const manifest = stored ?? lazy?.manifest ?? null;
  const isV2 = manifest?.rs_striped === true;

  const { loadedFromCache, plainBlob: cachedBlob } = await _loadBlobFromCache(isV2, blobCachePath, options.io, options.fromCache);
  let shardFailures = new Map<number, ShardFailureReason>();
  let plainBlob = cachedBlob;
  if (!loadedFromCache) {
    if (!manifest) throw new BfsError(await _describeMissingVersion(rootDir, targetVersion));
    // The password that opened the location map decrypts the data too, so it
    // carries over - asking a second time would read as the first answer having
    // been rejected.
    const downloadOptions: PullOptions = lazy?.password != null ? { ...options, password: lazy.password } : options;
    const result = await _downloadAndVerifyBlob({ config, manifest, rootDir, cacheDir, blobCachePath, isV2, targetVersion, workingVersion: state.working_version, options: downloadOptions });
    plainBlob = result.plainBlob;
    shardFailures = result.shardFailures;
  }

  const { extracted, skipped } = await _unpackFiles({ rootDir, manifest, isV2, plainBlob, blobCachePath, options });
  await _finalizePullState({ rootDir, cacheDir, state, targetVersion, manifest, isV2, plainBlob, blobCachePath, shardFailures, io: options.io });

  return { version: targetVersion, extracted: extracted.length, skipped };
}

/**
 * Refuses a prune that would leave no version anyone could restore.
 *
 * Housekeeping picks versions by number, so `--keep-last 1` over a backup whose
 * newest version rotted deletes the operator's only good copy and keeps the
 * unrecoverable one. The verdict comes from what the last verify recorded - the
 * only knowledge available without pulling every version over the network - so a
 * backup that has never been verified deeply may still hold surprises; the
 * message says as much. Nothing is refused when no restorable version exists in
 * the first place: unrecoverable versions must stay deletable.
 *
 * @param rootDir - Absolute path to the vault working directory
 * @param options - The prune request (`force` skips this guard entirely)
 * @throws BfsError when the request would delete the last restorable version
 */
export async function assertPruneKeepsARestorableVersion(rootDir: string, options: PruneOptions): Promise<void> {
  if (options.force) return;

  const manifests = await listManifests(rootDir);
  const restorable = manifests.filter((m) => m.health !== VersionHealth.Damaged);
  if (restorable.length === 0) return;

  const doomed = restorable.filter((m) => options.versions.includes(m.version));
  const surviving = restorable.filter((m) => !options.versions.includes(m.version));
  if (doomed.length > 0 && surviving.length === 0) {
    const last = doomed[doomed.length - 1];
    throw new BfsError(fmt('prune_last_restorable', String(last?.version ?? '')));
  }
}

/**
 * Deletes specified versions: removes shards from all providers and manifests from disk.
 * Updates state.json if the latest version was pruned.
 *
 * @param rootDir - Absolute path to the vault working directory
 * @param options - Versions to delete and associated ProviderIO
 * @throws BfsError if config is missing, or if the request would delete the last
 *   version that can still be restored (unless `force` is set).
 */
export async function prune(rootDir: string, options: PruneOptions): Promise<void> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('push_no_config'));

  assertSchemeValid(config);

  const state = await readState(rootDir);

  await assertPruneKeepsARestorableVersion(rootDir, options);

  const silentIO: ProviderIO = {
    lang: 'en',
    workDir: rootDir,
    // Prune runs unattended, so providers must apply their non-interactive
    // trust policy (pinned fingerprint / accept_new_host_key for SSH) instead of
    // prompting. Without this signal an SSH host-key decision takes the
    // interactive path, is declined by the confirm() below, and the delete fails
    // - silently orphaning the shard on the medium.
    interactive: false,
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
        // Delete is best-effort - the shard may already be gone. But a genuine
        // failure (permissions, unreachable medium) would otherwise orphan the
        // data on the medium silently; surface it so the operator can reclaim it.
        options.io?.warn(fmt('prune_orphan_warn', String(version), ms.provider_id));
      }
    }
    await deleteManifest(rootDir, version).catch(() => {});
  }

  // Update state if latest was pruned. Versions present on the storage but not
  // recovered count too: they still occupy their numbers, and lowering the
  // counter under one of them would hand the next push a number that is taken.
  // The rest of the state rides along - dropping `locations_confirmed` here would
  // quietly retire the confirmation gate a recovery put up.
  const remaining = await listManifests(rootDir);
  const unrecovered = await listUnrecoveredVersions(rootDir);
  const newLatest = Math.max(0, ...remaining.map((m) => m.version), ...unrecovered);
  if (newLatest !== state.latest_version) {
    const newWorking = state.working_version > newLatest ? 0 : state.working_version;
    await writeState(rootDir, { ...state, latest_version: newLatest, working_version: newWorking });
  }
}

/**
 * Removes a provider from config, with three strategies:
 * - 'remove': marks affected manifests as degraded, updates config.
 * - 'relocate': updates shard headers with new connection info.
 * - 'rebuild': downloads remaining shards, RS-repairs, uploads to target provider.
 *
 * When the config is unconfirmed after a disaster recovery
 * (state.locations_confirmed === false), the network-writing strategies
 * ('relocate'/'rebuild') first require the operator to confirm the provider
 * locations and clear the flag once the heal completes; 'remove' is not gated.
 *
 * @throws BfsError on validation failure, missing required options, or when the
 *   operator declines the post-recovery location confirmation.
 */
export async function removeProvider(rootDir: string, providerId: string, options: RemoveProviderOptions): Promise<void> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('push_no_config'));

  // No assertSchemeValid - rebuild flow needs providers.length > N+K transiently.

  if (!config.providers.find((p) => p.id === providerId)) {
    throw new BfsError(fmt('provider_not_found_in_config', providerId));
  }

  // relocate/rebuild authenticate to every provider in the recovered config to
  // rewrite shard headers (and rebuild uploads a reconstructed shard). After a
  // disaster recovery that config came from an untrusted --no-enc location map,
  // so confirm the locations before contacting any host. 'remove' performs no
  // network write, so it is not gated. Cleared on the first confirmed heal.
  let clearLocationsConfirmed = false;
  if (options.strategy === 'relocate' || options.strategy === 'rebuild') {
    const state = await readState(rootDir);
    if (state.locations_confirmed === false) {
      await confirmRecoveredLocations(config, options.io);
      clearLocationsConfirmed = true;
    }
  }

  if (options.strategy === 'remove') {
    if (config.providers.length <= 3) {
      throw new BfsError(t('provider_remove_min'));
    }
    const updatedProviders = config.providers.filter((p) => p.id !== providerId);
    await writeConfig(rootDir, { ...config, providers: updatedProviders });

    const manifests = await listManifests(rootDir);
    for (const manifest of manifests) {
      if (manifest.shards.some((s) => s.provider_id === providerId) && manifest.health === VersionHealth.Healthy) {
        await writeManifest(rootDir, applyHealthChange(manifest, VersionHealth.Degraded));
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
    if (clearLocationsConfirmed) await _clearLocationsConfirmed(rootDir);
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
    if (clearLocationsConfirmed) await _clearLocationsConfirmed(rootDir);
  }
}

/**
 * Clears the post-recovery "unconfirmed locations" flag after a confirmed heal,
 * so subsequent write operations run unprompted.
 */
async function _clearLocationsConfirmed(rootDir: string): Promise<void> {
  const state = await readState(rootDir);
  await writeState(rootDir, { ...state, locations_confirmed: true });
}

/**
 * Returns a summary of the current vault state.
 * @throws BfsError if config is missing.
 */
export async function status(rootDir: string): Promise<StatusInfo> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('push_no_config'));
  const state = await readState(rootDir);
  return { vault_name: config.vault_name, latest_version: state.latest_version, working_version: state.working_version, provider_count: config.providers.length, scheme: config.scheme, encryption_enabled: config.encryption.enabled };
}

/**
 * Returns all version manifests sorted by version ascending.
 * @throws BfsError if config is missing.
 */
export async function listVersions(rootDir: string): Promise<VersionManifest[]> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('push_no_config'));
  return listManifests(rootDir);
}
