import fs from 'node:fs/promises';
import path from 'node:path';
import { deriveKey } from '../core/crypto.js';
import { BfsError } from '../core/errors.js';
import { parseShard, parseShardHeaderOnly } from '../core/shard-io.js';
import type {
  ManifestShard,
  ProviderConfig,
  ProviderIO,
  ShardLocation,
  StorageProvider,
  VaultConfig,
  VersionManifest,
} from '../types/index.js';
import { PushMode, VersionHealth } from '../types/index.js';
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
  /** Starting password for encrypted vaults (added to the password pool) */
  password?: string;
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
  readonly cacheDir: string;
  readonly bootstrapVaultId: string;
  readonly passwordPool: string[];
  readonly io: ProviderIO;
}

/** Attempts to decrypt a location map from a shard using the provided password pool (MRU order). */
async function tryDecryptLocationMap(
  shardData: Buffer,
  passwordPool: string[],
  io: ProviderIO,
): Promise<Nullable<{ location_map: ShardLocation[]; encKey: Buffer }>> {
  const meta = parseShardHeaderOnly(shardData);
  if (!meta.encrypted || !meta.kdf_salt) return null;

  for (let i = passwordPool.length - 1; i >= 0; i--) {
    const pwd = passwordPool[i];
    if (pwd === undefined) continue;
    try {
      const key = await deriveKey(pwd, meta.kdf_salt);
      const { header } = parseShard(shardData, key);
      return { location_map: header.location_map, encKey: key };
    } catch {
      // wrong password — try next
    }
  }

  // No password in pool worked — ask user for a new one
  let newPassword: Nullable<string> = null;
  try {
    newPassword = await io.askSecret(
      'Enter password for this version (or leave blank to skip):',
    );
  } catch {
    return null;
  }
  if (!newPassword) return null;

  try {
    const key = await deriveKey(newPassword, meta.kdf_salt);
    const { header } = parseShard(shardData, key);
    passwordPool.push(newPassword); // add to pool for future versions
    return { location_map: header.location_map, encKey: key };
  } catch {
    return null;
  }
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
  const { vaultName, cacheDir, bootstrapVaultId, passwordPool, io } = ctx;

  // Download up to 2 shards from different providers for consensus
  const shardDataList: Array<{ data: Buffer; providerId: string }> = [];
  for (const entry of entries) {
    if (shardDataList.length >= 2) break;
    try {
      const filename = `shard_${entry.shardIndex}.bfs.${version}`;
      entry.provider.setVaultName(vaultName);
      const data = await entry.provider.download({
        provider_id: entry.provider.id,
        path: filename,
      });
      await fs.writeFile(path.join(cacheDir, filename), data).catch(() => {});
      shardDataList.push({ data, providerId: entry.provider.id });
    } catch {
      /* skip */
    }
  }
  if (shardDataList.length === 0) return null;

  const primaryData = shardDataList[0];
  if (!primaryData) return null;
  const primaryMeta = parseShardHeaderOnly(primaryData.data);

  if (primaryMeta.vault_id !== bootstrapVaultId) {
    io.warn(`Version ${version}: vault_id mismatch — skipping`);
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
    io.warn(`Version ${version}: filename/header mismatch — skipping`);
    return null;
  }

  // Consensus check (if we have 2 shards from different providers)
  let consensusOk = true;
  if (shardDataList.length >= 2) {
    const secondaryMeta = parseShardHeaderOnly(shardDataList[1]?.data);
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
        `Version ${version}: consensus failed (fields: ${mismatch.join(', ')}) — marking as untrusted`,
      );
      consensusOk = false;
    }
  }

  // Resolve location map (decrypt if needed)
  let location_map: Nullable<ShardLocation[]> = null;
  if (primaryMeta.encrypted) {
    const result = await tryDecryptLocationMap(
      primaryData.data,
      passwordPool,
      io,
    );
    if (result) location_map = result.location_map;
  } else {
    const { header } = parseShard(primaryData.data);
    location_map = header.location_map;
  }
  if (!location_map) {
    io.warn(`Version ${version}: could not decrypt location map — skipping`);
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
  const passwordPool: string[] = options.password ? [options.password] : [];

  const bootstrap = await bootstrapFromProvider(
    bootstrapProvider,
    vaultName,
    io,
    undefined,
    options.password,
  );

  // Save bootstrap shard to cache
  bootstrapProvider.setVaultName(vaultName);

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
    cacheDir,
    bootstrapVaultId: bootstrap.vault_id,
    passwordPool,
    io,
  };

  for (const version of [...versionProviderMap.keys()].sort((a, b) => a - b)) {
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
    throw new BfsError(
      'Could not reconstruct any valid manifest from the available providers.',
    );
  }

  // Find the actual latest verified version
  const allSortedVersions = reportVersions
    .map((v) => v.version)
    .sort((a, b) => a - b);
  latestVerified = allSortedVersions[allSortedVersions.length - 1] ?? 0;
  const latestManifest = await readManifest(rootDir, latestVerified);
  if (!latestManifest) {
    throw new BfsError(
      `Manifest for latest version ${latestVerified} could not be read after recovery.`,
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
