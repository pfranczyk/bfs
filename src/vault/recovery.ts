import fs from 'node:fs/promises';
import path from 'node:path';
import { BfsError } from '../core/errors.js';
import { fmt, t } from '../i18n/index.js';
import type { ProviderConfig, ProviderIO, StorageProvider, VaultConfig, VersionManifest } from '../types/index.js';
import { PushMode, VersionHealth } from '../types/index.js';
import { checkVersionMismatch, detectMissingAdapters, formatMissingAdaptersMessage } from './adapter-preflight.js';
import { type BootstrapResult, bootstrapFromProvider, parseVersionFromFilename } from './bootstrap.js';
import { writeConfig } from './config.js';
import { readManifest, writeManifest, writeUnrecoveredMarker } from './manifest.js';
import { writeState } from './state.js';
import { verifyAll } from './verify.js';
import { rebuildVersionManifest, type VersionRebuildContext } from './version-rebuild.js';

// --- Option and report types --------------------------------------------------

export interface RecoveryOptions {
  /** Vault subdirectory name on the provider */
  vaultName: string;
  /** Already authenticated bootstrap provider */
  provider: StorageProvider;
  /** ProviderIO for authentication of other providers */
  io: ProviderIO;
  /** Known passwords for encrypted vaults (all added to the password pool) */
  passwords?: string[];
  /**
   * Transport secrets the operator already supplied for the bootstrap provider
   * (field name -> value, e.g. `{ password: '...' }`). They seed the input pool
   * so other providers sharing the same credential connect without re-prompting.
   */
  bootstrapInputs?: Record<string, string>;
  /**
   * When true, recovery continues even if some external adapters are missing,
   * relying on Reed-Solomon redundancy to decode from whatever providers
   * remain available. Missing built-in providers (local, ftp, ssh) always abort -
   * their absence means the BFS installation itself is broken.
   */
  allowMissingAdapters?: boolean;
  /**
   * Unattended recovery (`bfs recovery --trust-locations`): the operator
   * pre-approves the recovered provider locations, so providers connect without
   * blocking on a per-host confirmation and the rebuilt config is marked
   * confirmed (the next push won't re-prompt). For the rare 1% who automate
   * recovery (e.g. rebuilding a whole VM); interactive recovery leaves it off.
   */
  trustLocations?: boolean;
}

export interface RecoveryReport {
  manifests_rebuilt: number;
  provider_count: number;
  versions: Array<{ version: number; health: VersionHealth; consensus: boolean }>;
  /** Versions found on the storage whose location map no supplied password opened. */
  unrecovered_versions: number[];
}
// --- Internal helpers ---------------------------------------------------------

/**
 * Lists all shard files across all providers and groups them by version number.
 * Unreachable providers are silently skipped.
 *
 * @returns Map of version -> { provider_id -> { shardIndex, provider } }
 */
async function discoverAllVersions(allProviders: StorageProvider[], vaultName: string): Promise<Map<number, Map<string, { shardIndex: number; provider: StorageProvider }>>> {
  const versionProviderMap = new Map<number, Map<string, { shardIndex: number; provider: StorageProvider }>>();

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
        versionProviderMap.get(parsed.version)?.set(p.id, { shardIndex: parsed.shardIndex, provider: p });
      }
    } catch {
      // provider unavailable - skip
    }
  }
  return versionProviderMap;
}

/**
 * Builds a VaultConfig from the bootstrap result and the latest verified manifest.
 * Connection configs are sourced from the bootstrap location map.
 */
function reconstructConfig(bootstrap: BootstrapResult, latestManifest: VersionManifest): VaultConfig {
  const providerConfigs: ProviderConfig[] = latestManifest.shards.map((ms) => {
    const loc = bootstrap.location_map.find((l) => l.provider_id === ms.provider_id);
    return { id: ms.provider_id, type: ms.provider_type, adapterPackage: loc?.adapterPackage ?? null, config: loc?.connection_config ?? {} };
  });
  return {
    vault_id: bootstrap.vault_id,
    vault_name: bootstrap.vault_name,
    version: 1,
    scheme: latestManifest.scheme,
    encryption: { enabled: latestManifest.encrypted, algorithm: 'aes-256-gcm', kdf: 'argon2id' },
    compression: { enabled: true, algorithm: 'deflate' as const },
    push_mode: PushMode.NewVersion,
    providers: providerConfigs,
  };
}

// --- Public API ---------------------------------------------------------------

/**
 * Recovers (rebuilds) the .bfs/ directory from remote providers.
 * Does NOT unpack files - only reconstructs config.json, state.json, and manifests.
 * After recovery, use `bfs pull` to restore files.
 *
 * Strategy:
 *  1. Bootstrap from the given provider (discover vault_id, location_map, scheme)
 *  2. Connect to all providers found in location_map
 *  3. Enumerate all available versions across providers
 *  4. For each version: read the header window of every distinct shard reachable
 *     for it, open its location map, cross-check against a sibling when one is
 *     available -> rebuild manifest
 *  5. Reconstruct config.json and state.json from the latest verified manifest
 *  6. Run verify to compute final health for each version
 *
 * @throws BfsError when bootstrap fails, when a provider type has no registered
 *         adapter, or when no version could be rebuilt
 * @throws TamperDetectedError if consensus check fails during bootstrap
 */
export async function recover(rootDir: string, options: RecoveryOptions): Promise<RecoveryReport> {
  const { vaultName, provider: bootstrapProvider, io } = options;

  // -- 1. Create / reset .bfs/ and .bfs/cache/ ------------------------------
  // 0700: .bfs/ holds config.json (provider secrets) and cached plaintext
  // blobs, so keep the whole tree owner-only on POSIX (no-op on Windows NTFS).
  await fs.mkdir(path.join(rootDir, '.bfs', 'manifests'), { recursive: true, mode: 0o700 });
  const cacheDir = path.join(rootDir, '.bfs', 'cache');
  await fs.mkdir(cacheDir, { recursive: true, mode: 0o700 });
  // Clear existing cache (recovery starts fresh)
  try {
    const existing = await fs.readdir(cacheDir);
    for (const f of existing) {
      await fs.unlink(path.join(cacheDir, f)).catch(() => {});
    }
  } catch {
    // cache dir may not exist yet
  }

  // -- 2. Bootstrap ----------------------------------------------------------
  const passwordPool: string[] = options.passwords ? [...options.passwords] : [];

  const bootstrap = await bootstrapFromProvider(bootstrapProvider, { vaultName, io, passwords: passwordPool, transportInputs: options.bootstrapInputs, trustLocations: options.trustLocations === true });

  // Scope the bootstrap provider's listings to the vault sub-directory before discovery
  bootstrapProvider.setVaultName(vaultName);

  // -- 2a. Adapter preflight from the bootstrap location map -----------------
  // Every shard's location map advertises all provider types in the vault.
  // Before we try to touch them, verify each type is registered. Missing
  // built-in = hard abort ("BFS installation broken"). Missing external
  // adapter = batched report with install commands, respecting
  // allowMissingAdapters so Reed-Solomon can still decode from what remains.
  const recoveredProviders: ProviderConfig[] = bootstrap.location_map.map((loc) => ({ id: loc.provider_id, type: loc.provider_type, adapterPackage: loc.adapterPackage, config: loc.connection_config }));
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
    io.warn(vm.severity === 'strong' ? fmt('adapter_version_mismatch_strong', vm.type, vm.recordedPackage, vm.installedPackage, vm.recordedPackage) : fmt('adapter_version_mismatch_soft', vm.type, vm.recordedPackage, vm.installedPackage));
  }

  // -- 3. Discover all versions across all providers -------------------------
  const allProviders: StorageProvider[] = [bootstrapProvider, ...bootstrap.providers];
  const versionProviderMap = await discoverAllVersions(allProviders, vaultName);

  // -- 4. Process each version - build and write its manifest ----------------
  const reportVersions: Array<{ version: number; health: VersionHealth; consensus: boolean }> = [];
  const unrecoveredVersions: number[] = [];
  let latestVerified = 0;
  const rebuildCtx: VersionRebuildContext = { vaultName, vaultId: bootstrap.vault_id, passwordPool, caller: 'recovery', io };

  // Process newest versions first - bootstrap password is most likely to match
  // recent versions, minimizing interactive password prompts when passwords change.
  for (const version of [...versionProviderMap.keys()].sort((a, b) => b - a)) {
    const providerEntries = versionProviderMap.get(version);
    if (!providerEntries || providerEntries.size === 0) continue;

    const result = await rebuildVersionManifest(version, [...providerEntries.values()], rebuildCtx);
    switch (result.outcome) {
      case 'recovered':
        await writeManifest(rootDir, result.manifest);
        latestVerified = Math.max(latestVerified, version);
        reportVersions.push({ version, health: VersionHealth.Degraded, consensus: result.consensusOk });
        break;
      case 'map_unopened':
        unrecoveredVersions.push(version);
        break;
      case 'unusable':
        break;
    }
  }

  if (reportVersions.length === 0) {
    throw new BfsError(t('recovery_no_manifests'));
  }

  // Record the versions that stayed sealed - but only now that the recovery is
  // known to stand. A run that ends by refusing must leave nothing behind, or the
  // directory keeps announcing versions while holding no config to reach them.
  for (const version of unrecoveredVersions) {
    // Recovery runs more than once - the messages that send an operator here say
    // so - and each run brings whichever passwords are at hand. A run without the
    // password for a version already rebuilt must leave that manifest alone: it is
    // the only local record of where that version lives. A file that cannot be
    // read is left alone for the same reason, and never costs the whole recovery.
    const existing = await readManifest(rootDir, version).catch(() => 'unreadable' as const);
    if (existing === null) await writeUnrecoveredMarker(rootDir, version);
  }

  // Find the actual latest verified version
  const allSortedVersions = reportVersions.map((v) => v.version).sort((a, b) => a - b);
  latestVerified = allSortedVersions[allSortedVersions.length - 1] ?? 0;
  const latestManifest = await readManifest(rootDir, latestVerified);
  if (!latestManifest) {
    throw new BfsError(fmt('recovery_manifest_unreadable', String(latestVerified)));
  }

  // -- 5. Reconstruct config.json from the latest manifest -------------------
  const config = reconstructConfig(bootstrap, latestManifest);
  await writeConfig(rootDir, config);

  // -- 6. Reconstruct state.json ---------------------------------------------
  // Mark the rebuilt config unconfirmed (it came from an untrusted location map)
  // so the first push/heal shows the locations and requires confirmation - unless
  // the operator already pre-approved them with --trust-locations (unattended).
  // `latest_version` is the highest version ON THE STORAGE, not the highest one
  // this run could read: `push` builds the next number from it, so counting only
  // what was recovered would hand the next push a number that is already taken
  // and overwrite the parts sitting under it. Every discovered version counts,
  // including the ones skipped - an inflated counter costs a version number,
  // a deflated one costs data.
  const latestOnMedia = Math.max(latestVerified, ...versionProviderMap.keys());
  await writeState(rootDir, { latest_version: latestOnMedia, working_version: 0, locations_confirmed: options.trustLocations === true });

  // -- 7. Run verify to update health ----------------------------------------
  const verifyReport = await verifyAll(rootDir, io);
  for (const vs of verifyReport.versions) {
    const rv = reportVersions.find((r) => r.version === vs.version);
    if (rv) rv.health = vs.health;
  }

  return { manifests_rebuilt: reportVersions.length, provider_count: config.providers.length, versions: reportVersions, unrecovered_versions: unrecoveredVersions };
}
