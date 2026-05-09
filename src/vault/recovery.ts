import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { deriveKey } from '../core/crypto.js';
import { BfsError } from '../core/errors.js';
import { parseShardHeaderFromStream } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import type {
  ManifestShard,
  ProviderConfig,
  ProviderIO,
  ShardHeader,
  ShardLocation,
  StorageProvider,
  VaultConfig,
  VersionManifest,
} from '../types/index.js';
import { PushMode, VersionHealth } from '../types/index.js';
import {
  checkVersionMismatch,
  detectMissingAdapters,
  formatMissingAdaptersMessage,
} from './adapter-preflight.js';
import {
  type BootstrapResult,
  bootstrapFromProvider,
  parseVersionFromFilename,
} from './bootstrap.js';
import { writeConfig } from './config.js';
import { readManifest, writeManifest } from './manifest.js';
import { writeState } from './state.js';
import { verifyAll } from './verify.js';

// ─── Option and report types ──────────────────────────────────────────────────

export interface RecoveryOptions {
  /** Vault subdirectory name on the provider */
  vaultName: string;
  /** Already authenticated bootstrap provider */
  provider: StorageProvider;
  /** ProviderIO for authentication of other providers */
  io: ProviderIO;
  /** Known passwords for encrypted vaults (all added to the password pool) */
  passwords?: string[];
  /** Overrides cache directory for recovered shards. Defaults to {rootDir}/.bfs/cache. */
  cacheDir?: string;
  /**
   * When true, recovery continues even if some external adapters are missing,
   * relying on Reed-Solomon redundancy to decode from whatever providers
   * remain available. Missing built-in providers (local, ftp) always abort
   * — their absence means the BFS installation itself is broken.
   */
  allowMissingAdapters?: boolean;
}

export interface RecoveryReport {
  manifests_rebuilt: number;
  provider_count: number;
  versions: Array<{
    version: number;
    health: VersionHealth;
    consensus: boolean;
  }>;
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Context passed to processVersion for each version discovered during recovery. */
interface ProcessVersionContext {
  readonly vaultName: string;
  readonly bootstrapVaultId: string;
  readonly passwordPool: string[];
  readonly io: ProviderIO;
}

const MAX_PASSWORD_ATTEMPTS = 3;

/**
 * Maximum bytes pulled from a shard for header inspection during recovery.
 * The shard header (magic, common fields, kdf_salt, location_map) is bounded
 * by the number of providers (N+K) and a JSON location map. 16 KB
 * comfortably covers realistic schemes (≤ 32 providers) without forcing
 * adapters to stream the full multi-MB payload.
 */
const SHARD_HEADER_READ_BYTES = 16384;

/** Attempts to decrypt a location map from a shard using the provided password pool (MRU order). */
async function tryDecryptLocationMap(
  header: ShardHeader,
  headerBytes: Buffer,
  version: number,
  passwordPool: string[],
  io: ProviderIO,
): Promise<Nullable<{ location_map: ShardLocation[]; encKey: Buffer }>> {
  if (!header.encrypted || !header.kdf_salt) return null;

  // Try all known passwords from pool (MRU order)
  for (let i = passwordPool.length - 1; i >= 0; i--) {
    const pwd = passwordPool[i];
    if (pwd === undefined) continue;
    try {
      const key = await deriveKey(pwd, header.kdf_salt);
      const { header: h1, payloadStream: ps1 } =
        await parseShardHeaderFromStream(Readable.from(headerBytes), key);
      ps1.on('error', () => {}).destroy();
      return { location_map: h1.location_map, encKey: key };
    } catch {
      // wrong password — try next
    }
  }

  // No password in pool worked — ask user with retry
  const ver = String(version);
  if (passwordPool.length > 0) {
    io.warn(fmt('recovery_pool_password_failed', ver));
  }

  for (let attempt = 0; attempt < MAX_PASSWORD_ATTEMPTS; attempt++) {
    let newPassword: Nullable<string> = null;
    try {
      const prompt =
        attempt === 0
          ? fmt('recovery_ask_version_password', ver)
          : fmt('recovery_wrong_password_retry', ver);
      newPassword = await io.askSecret(prompt);
    } catch {
      return null;
    }
    if (!newPassword) return null;

    try {
      const key = await deriveKey(newPassword, header.kdf_salt);
      const { header: h2, payloadStream: ps2 } =
        await parseShardHeaderFromStream(Readable.from(headerBytes), key);
      ps2.on('error', () => {}).destroy();
      passwordPool.push(newPassword);
      return { location_map: h2.location_map, encKey: key };
    } catch {
      // wrong password — retry
    }
  }

  return null;
}

/**
 * Lists all shard files across all providers and groups them by version number.
 * Unreachable providers are silently skipped.
 *
 * @returns Map of version → { provider_id → { shardIndex, provider } }
 */
async function discoverAllVersions(
  allProviders: StorageProvider[],
  vaultName: string,
): Promise<
  Map<number, Map<string, { shardIndex: number; provider: StorageProvider }>>
> {
  const versionProviderMap = new Map<
    number,
    Map<string, { shardIndex: number; provider: StorageProvider }>
  >();

  for (const p of allProviders) {
    try {
      p.setVaultName(vaultName);
      const refs = await p.list('shard_');
      for (const ref of refs) {
        const parsed = parseVersionFromFilename(ref.path);
        if (!parsed) continue;
        if (!versionProviderMap.has(parsed.version)) {
          versionProviderMap.set(parsed.version, new Map());
        }
        versionProviderMap
          .get(parsed.version)
          ?.set(p.id, { shardIndex: parsed.shardIndex, provider: p });
      }
    } catch {
      // provider unavailable — skip
    }
  }
  return versionProviderMap;
}

/**
 * Processes one version during recovery: downloads up to 2 shards, runs consensus,
 * decrypts the location map, and writes the manifest file.
 *
 * @returns { manifest, consensusOk } on success, or null if the version should be skipped
 */
async function processVersion(
  version: number,
  entries: Array<{ shardIndex: number; provider: StorageProvider }>,
  ctx: ProcessVersionContext,
): Promise<Nullable<{ manifest: VersionManifest; consensusOk: boolean }>> {
  const { vaultName, bootstrapVaultId, passwordPool, io } = ctx;

  // Pull up to 2 shard headers from different providers for consensus.
  // Providers MUST honor `downloadHeader` and avoid pulling the full payload
  // over the wire (FTP issues SIZE + aborts after maxBytes; LocalFS uses a
  // bounded createReadStream).
  const shardDataList: Array<{
    header: ShardHeader;
    headerBytes: Buffer;
    providerId: string;
  }> = [];
  for (const entry of entries) {
    if (shardDataList.length >= 2) break;
    try {
      const filename = `shard_${entry.shardIndex}.bfs.${version}`;
      entry.provider.setVaultName(vaultName);
      const headerBytes = await entry.provider.downloadHeader(
        { provider_id: entry.provider.id, path: filename },
        SHARD_HEADER_READ_BYTES,
      );

      // Parse header from buffered bytes; payload stream errors are expected (truncated data)
      const { header: shardHeader, payloadStream } =
        await parseShardHeaderFromStream(Readable.from(headerBytes));
      payloadStream.on('error', () => {}).destroy();
      shardDataList.push({
        header: shardHeader,
        headerBytes,
        providerId: entry.provider.id,
      });
    } catch {
      /* skip */
    }
  }
  if (shardDataList.length === 0) return null;

  const primaryData = shardDataList[0];
  if (!primaryData) return null;
  const primaryMeta = primaryData.header;

  if (primaryMeta.vault_id !== bootstrapVaultId) {
    io.warn(fmt('recovery_consensus_vault_id_mismatch', String(version)));
    return null;
  }

  const parsedFilename = parseVersionFromFilename(
    `shard_${entries[0]?.shardIndex}.bfs.${version}`,
  );
  if (
    !parsedFilename ||
    parsedFilename.shardIndex !== primaryMeta.shard_index ||
    parsedFilename.version !== primaryMeta.version
  ) {
    io.warn(fmt('recovery_consensus_filename_mismatch', String(version)));
    return null;
  }

  // Consensus check (if we have 2 shards from different providers)
  let consensusOk = true;
  if (shardDataList.length >= 2) {
    const secondaryMeta = shardDataList[1]?.header ?? primaryMeta;
    const mismatch: string[] = [];
    if (secondaryMeta.vault_id !== primaryMeta.vault_id)
      mismatch.push('vault_id');
    if (secondaryMeta.blob_hash !== primaryMeta.blob_hash)
      mismatch.push('blob_hash');
    if (secondaryMeta.version !== primaryMeta.version) mismatch.push('version');
    if (secondaryMeta.data_shards !== primaryMeta.data_shards)
      mismatch.push('data_shards');
    if (secondaryMeta.parity_shards !== primaryMeta.parity_shards)
      mismatch.push('parity_shards');
    if (mismatch.length > 0) {
      io.warn(
        fmt('recovery_consensus_failed', String(version), mismatch.join(', ')),
      );
      consensusOk = false;
    }
  }

  // Resolve location map (decrypt if needed)
  let location_map: Nullable<ShardLocation[]> = null;
  if (primaryMeta.encrypted) {
    const result = await tryDecryptLocationMap(
      primaryData.header,
      primaryData.headerBytes,
      version,
      passwordPool,
      io,
    );
    if (result) location_map = result.location_map;
  } else {
    location_map = primaryData.header.location_map;
  }
  if (!location_map) {
    io.warn(fmt('recovery_decrypt_skip', String(version)));
    return null;
  }

  // Build manifest from the location map and header metadata
  const manifestShards: ManifestShard[] = location_map.map((loc) => ({
    shard_index: loc.shard_index,
    provider_id: loc.provider_id,
    provider_type: loc.provider_type,
    remote_path: loc.remote_path,
    shard_hash: loc.shard_hash,
  }));
  const manifest: VersionManifest = {
    version,
    pushed_at: null,
    file_count: null,
    total_size: null,
    blob_hash: primaryMeta.blob_hash,
    scheme: {
      data_shards: primaryMeta.data_shards,
      parity_shards: primaryMeta.parity_shards,
    },
    encrypted: primaryMeta.encrypted,
    shards: manifestShards,
    health: VersionHealth.Degraded,
  };
  // Detect FORMAT_VERSION >= 2 (always rs_striped + per-shard encryption).
  // These flags are NOT stored in ShardHeader — they live only in VersionManifest.
  // format_version >= 2 unambiguously identifies the streaming push pipeline.
  if (primaryMeta.format_version >= 2) {
    manifest.rs_striped = true;
    if (primaryMeta.rs_stripe_size !== null) {
      manifest.rs_stripe_size = primaryMeta.rs_stripe_size;
    }
    if (primaryMeta.encrypted) manifest.encrypted_per_shard = true;
  }
  return { manifest, consensusOk };
}

/**
 * Builds a VaultConfig from the bootstrap result and the latest verified manifest.
 * Connection configs are sourced from the bootstrap location map.
 */
function reconstructConfig(
  bootstrap: BootstrapResult,
  latestManifest: VersionManifest,
): VaultConfig {
  const providerConfigs: ProviderConfig[] = latestManifest.shards.map((ms) => {
    const loc = bootstrap.location_map.find(
      (l) => l.provider_id === ms.provider_id,
    );
    return {
      id: ms.provider_id,
      type: ms.provider_type,
      adapterPackage: loc?.adapterPackage ?? null,
      config: loc?.connection_config ?? {},
    };
  });
  return {
    vault_id: bootstrap.vault_id,
    vault_name: bootstrap.vault_name,
    version: 1,
    scheme: latestManifest.scheme,
    encryption: {
      enabled: latestManifest.encrypted,
      algorithm: 'aes-256-gcm',
      kdf: 'argon2id',
    },
    compression: { enabled: true, algorithm: 'deflate' as const },
    push_mode: PushMode.NewVersion,
    providers: providerConfigs,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Recovers (rebuilds) the .bfs/ directory from remote providers.
 * Does NOT unpack files — only reconstructs config.json, state.json, and manifests.
 * After recovery, use `bfs pull` to restore files.
 *
 * Strategy:
 *  1. Bootstrap from the given provider (discover vault_id, location_map, scheme)
 *  2. Connect to all providers found in location_map
 *  3. Enumerate all available versions across providers
 *  4. For each version: download ≥ 2 shards from different providers → consensus → rebuild manifest
 *  5. Reconstruct config.json and state.json from the latest verified manifest
 *  6. Run verify to compute final health for each version
 *
 * @throws BfsError if bootstrap fails
 * @throws TamperDetectedError if consensus check fails during bootstrap
 */
export async function recover(
  rootDir: string,
  options: RecoveryOptions,
): Promise<RecoveryReport> {
  const { vaultName, provider: bootstrapProvider, io } = options;

  // ── 1. Create / reset .bfs/ and .bfs/cache/ ──────────────────────────────
  await fs.mkdir(path.join(rootDir, '.bfs', 'manifests'), { recursive: true });
  const cacheDir = path.join(rootDir, '.bfs', 'cache');
  await fs.mkdir(cacheDir, { recursive: true });
  // Clear existing cache (recovery starts fresh)
  try {
    const existing = await fs.readdir(cacheDir);
    for (const f of existing) {
      await fs.unlink(path.join(cacheDir, f)).catch(() => {});
    }
  } catch {
    // cache dir may not exist yet
  }

  // ── 2. Bootstrap ──────────────────────────────────────────────────────────
  const passwordPool: string[] = options.passwords
    ? [...options.passwords]
    : [];

  const bootstrap = await bootstrapFromProvider(
    bootstrapProvider,
    vaultName,
    io,
    undefined,
    passwordPool,
  );

  // Save bootstrap shard to cache
  bootstrapProvider.setVaultName(vaultName);

  // ── 2a. Adapter preflight from the bootstrap location map ─────────────────
  // Every shard's location map advertises all provider types in the vault.
  // Before we try to touch them, verify each type is registered. Missing
  // built-in = hard abort ("BFS installation broken"). Missing external
  // adapter = batched report with install commands, respecting
  // allowMissingAdapters so Reed-Solomon can still decode from what remains.
  const recoveredProviders: ProviderConfig[] = bootstrap.location_map.map(
    (loc) => ({
      id: loc.provider_id,
      type: loc.provider_type,
      adapterPackage: loc.adapterPackage,
      config: loc.connection_config,
    }),
  );
  const missing = detectMissingAdapters(recoveredProviders);
  const builtInMissing = missing.filter((m) => m.adapterPackage === null);
  if (builtInMissing.length > 0) {
    const names = builtInMissing.map((m) => `"${m.type}"`).join(', ');
    throw new BfsError(fmt('adapter_preflight_builtin_broken_many', names));
  }
  const externalMissing = missing.filter((m) => m.adapterPackage !== null);
  if (externalMissing.length > 0 && options.allowMissingAdapters !== true) {
    throw new BfsError(`${formatMissingAdaptersMessage(externalMissing)}\n`);
  }
  if (externalMissing.length > 0) {
    io.warn(formatMissingAdaptersMessage(externalMissing));
  }
  const versionMismatches = checkVersionMismatch(recoveredProviders);
  for (const vm of versionMismatches) {
    io.warn(
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

  // ── 3. Discover all versions across all providers ─────────────────────────
  const allProviders: StorageProvider[] = [
    bootstrapProvider,
    ...bootstrap.providers,
  ];
  const versionProviderMap = await discoverAllVersions(allProviders, vaultName);

  // ── 4. Process each version — build and write its manifest ────────────────
  const reportVersions: Array<{
    version: number;
    health: VersionHealth;
    consensus: boolean;
  }> = [];
  let latestVerified = 0;
  const processCtx: ProcessVersionContext = {
    vaultName,
    bootstrapVaultId: bootstrap.vault_id,
    passwordPool,
    io,
  };

  // Process newest versions first — bootstrap password is most likely to match
  // recent versions, minimizing interactive password prompts when passwords change.
  for (const version of [...versionProviderMap.keys()].sort((a, b) => b - a)) {
    const providerEntries = versionProviderMap.get(version);
    if (!providerEntries || providerEntries.size === 0) continue;

    const result = await processVersion(
      version,
      [...providerEntries.values()],
      processCtx,
    );
    if (!result) continue;

    await writeManifest(rootDir, result.manifest);
    latestVerified = Math.max(latestVerified, version);
    reportVersions.push({
      version,
      health: VersionHealth.Degraded,
      consensus: result.consensusOk,
    });
  }

  if (reportVersions.length === 0) {
    throw new BfsError(t('recovery_no_manifests'));
  }

  // Find the actual latest verified version
  const allSortedVersions = reportVersions
    .map((v) => v.version)
    .sort((a, b) => a - b);
  latestVerified = allSortedVersions[allSortedVersions.length - 1] ?? 0;
  const latestManifest = await readManifest(rootDir, latestVerified);
  if (!latestManifest) {
    throw new BfsError(
      fmt('recovery_manifest_unreadable', String(latestVerified)),
    );
  }

  // ── 5. Reconstruct config.json from the latest manifest ───────────────────
  const config = reconstructConfig(bootstrap, latestManifest);
  await writeConfig(rootDir, config);

  // ── 6. Reconstruct state.json ─────────────────────────────────────────────
  await writeState(rootDir, {
    latest_version: latestVerified,
    working_version: 0,
  });

  // ── 7. Run verify to update health ────────────────────────────────────────
  const verifyReport = await verifyAll(rootDir, io);
  for (const vs of verifyReport.versions) {
    const rv = reportVersions.find((r) => r.version === vs.version);
    if (rv) rv.health = vs.health;
  }

  return {
    manifests_rebuilt: reportVersions.length,
    provider_count: config.providers.length,
    versions: reportVersions,
  };
}
