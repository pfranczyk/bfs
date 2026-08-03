import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BfsError } from '../core/errors.js';
import { parseShardHeaderFromStream, readShardHeaderBytes, SHARD_HEADER_READ_BYTES } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import type { ManifestShard, ProviderConfig, ProviderIO, ShardHeader, ShardLocation, StorageProvider, VaultConfig, VersionManifest } from '../types/index.js';
import { PushMode, VersionHealth } from '../types/index.js';
import { checkVersionMismatch, detectMissingAdapters, formatMissingAdaptersMessage } from './adapter-preflight.js';
import { type BootstrapResult, bootstrapFromProvider, parseVersionFromFilename } from './bootstrap.js';
import { writeConfig } from './config.js';
import { shardHeaderConsensusMismatch } from './consensus.js';
import { readManifest, writeManifest } from './manifest.js';
import { promptForVaultPassword, tryPooledPasswords } from './password-pool.js';
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
  /**
   * Transport secrets the operator already supplied for the bootstrap provider
   * (field name → value, e.g. `{ password: '...' }`). They seed the input pool
   * so other providers sharing the same credential connect without re-prompting.
   */
  bootstrapInputs?: Record<string, string>;
  /** Overrides cache directory for recovered shards. Defaults to {rootDir}/.bfs/cache. */
  cacheDir?: string;
  /**
   * When true, recovery continues even if some external adapters are missing,
   * relying on Reed-Solomon redundancy to decode from whatever providers
   * remain available. Missing built-in providers (local, ftp) always abort
   * — their absence means the BFS installation itself is broken.
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
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

/** Context passed to processVersion for each version discovered during recovery. */
interface ProcessVersionContext {
  readonly vaultName: string;
  readonly bootstrapVaultId: string;
  readonly passwordPool: string[];
  readonly io: ProviderIO;
}

/**
 * Lists all shard files across all providers and groups them by version number.
 * Unreachable providers are silently skipped.
 *
 * @returns Map of version → { provider_id → { shardIndex, provider } }
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
      // provider unavailable — skip
    }
  }
  return versionProviderMap;
}

/**
 * Processes one version during recovery: collects the headers of its distinct
 * shards, resolves the location map from the first shard that yields it (falling
 * back past a damaged primary to a healthy sibling), runs consensus, and builds
 * the manifest from the shard the map actually came from.
 *
 * @returns { manifest, consensusOk } on success, or null if the version should be skipped
 */
async function processVersion(version: number, entries: Array<{ shardIndex: number; provider: StorageProvider }>, ctx: ProcessVersionContext): Promise<Nullable<{ manifest: VersionManifest; consensusOk: boolean }>> {
  const { vaultName, bootstrapVaultId, passwordPool, io } = ctx;

  // Collect the headers of DISTINCT shards, deduping by shard index. The bootstrap
  // provider and a config provider can be the SAME physical medium under two ids;
  // keying on provider id would spend the budget on one shard and never reach a
  // real sibling. Collecting every distinct shard (not just two) lets map
  // resolution fall through a damaged primary to a healthy sibling. Providers MUST
  // honor `downloadHeader` and avoid pulling the full payload over the wire.
  const collected: Array<{ header: ShardHeader; headerBytes: Buffer; providerId: string; shardIndex: number }> = [];
  const seenShardIndices = new Set<number>();
  for (const entry of entries) {
    if (seenShardIndices.has(entry.shardIndex)) continue;
    try {
      const filename = `shard_${entry.shardIndex}.bfs.${version}`;
      entry.provider.setVaultName(vaultName);
      // Sidecar-aware: after a relocate the CURRENT map lives in the sidecar;
      // reading the in-shard header would rebuild the manifest from a stale map.
      const headerBytes = await readShardHeaderBytes(entry.provider, { provider_id: entry.provider.id, path: filename }, SHARD_HEADER_READ_BYTES);
      const { header: shardHeader, payloadStream } = await parseShardHeaderFromStream(Readable.from(headerBytes));
      payloadStream.on('error', () => {}).destroy();
      collected.push({ header: shardHeader, headerBytes, providerId: entry.provider.id, shardIndex: entry.shardIndex });
      seenShardIndices.add(entry.shardIndex);
    } catch {
      // Unreadable header (truncated/corrupt) — treat this medium as absent.
    }
  }
  if (collected.length === 0) return null;

  // Resolve which shard supplies the location map. Walk candidates in order: skip
  // any whose vault_id is foreign (the guard follows the map's source shard, not
  // the first listed entry), then open the map — pooled passwords for encrypted
  // shards (no prompt yet), the parsed plaintext map for --no-enc. The first
  // candidate that clears both becomes the source. Per-version salt is shared, so
  // memoize derived keys across candidates to keep Argon2id to one pass per pool
  // password.
  const keyCache = new Map<string, Buffer>();
  let source: Nullable<{ header: ShardHeader; shardIndex: number; location_map: ShardLocation[] }> = null;
  const failedProviderIds: string[] = [];
  let sawEncryptedCandidate = false;

  for (const c of collected) {
    if (c.header.vault_id !== bootstrapVaultId) continue; // foreign shard — keep looking
    if (c.header.encrypted) {
      sawEncryptedCandidate = true;
      const resolved = await tryPooledPasswords(c.header, c.headerBytes, passwordPool, keyCache);
      if (resolved) {
        source = { header: c.header, shardIndex: c.shardIndex, location_map: resolved.location_map };
        break;
      }
      failedProviderIds.push(c.providerId);
    } else {
      source = { header: c.header, shardIndex: c.shardIndex, location_map: c.header.location_map };
      break;
    }
  }

  // Encrypted, and no pooled password opened any candidate: the pool is genuinely
  // exhausted (a version predating a password change, or every candidate damaged).
  // Warn and prompt ONCE per version — on the first encrypted candidate with a
  // matching vault_id — never once per candidate shard.
  if (!source && sawEncryptedCandidate) {
    const promptTarget = collected.find((c) => c.header.vault_id === bootstrapVaultId && c.header.encrypted);
    if (promptTarget) {
      if (passwordPool.length > 0) io.warn(fmt('recovery_pool_password_failed', String(version)));
      const resolved = await promptForVaultPassword(
        promptTarget.header,
        promptTarget.headerBytes,
        passwordPool,
        io,
        { poolExhausted: fmt('recovery_pool_password_failed', String(version)), ask: fmt('recovery_ask_version_password', String(version)), retry: fmt('recovery_wrong_password_retry', String(version)) },
        keyCache,
      );
      if (resolved) source = { header: promptTarget.header, shardIndex: promptTarget.shardIndex, location_map: resolved.location_map };
    }
  }

  if (!source) {
    io.warn(fmt('recovery_decrypt_skip', String(version)));
    return null;
  }
  const src = source;
  const sourceMeta = src.header;

  if (sourceMeta.vault_id !== bootstrapVaultId) {
    io.warn(fmt('recovery_consensus_vault_id_mismatch', String(version)));
    return null;
  }

  // Filename cross-check keyed on the shard the header actually came from — not
  // the first listed entry, which may have dropped out of the candidates.
  const parsedFilename = parseVersionFromFilename(`shard_${src.shardIndex}.bfs.${version}`);
  if (!parsedFilename || parsedFilename.shardIndex !== sourceMeta.shard_index || parsedFilename.version !== sourceMeta.version) {
    io.warn(fmt('recovery_consensus_filename_mismatch', String(version)));
    return null;
  }

  // Consensus + fallback disclosure. If the map came from a sibling past a
  // candidate that could not supply it, the primary medium is damaged: name it and
  // withhold consensus so verify/repair still surface it. Otherwise cross-check the
  // source against another distinct medium. An unencrypted location_map divergence
  // means a forged map redirecting a provider; encrypted maps are MAC-protected and
  // skipped in the comparison.
  let consensusOk = true;
  if (failedProviderIds.length > 0) {
    io.warn(fmt('recovery_map_from_sibling', String(version), failedProviderIds.join(', ')));
    consensusOk = false;
  } else {
    const other = collected.find((c) => c.shardIndex !== src.shardIndex);
    if (other) {
      const mismatch = shardHeaderConsensusMismatch(sourceMeta, other.header);
      if (mismatch.length > 0) {
        io.warn(fmt('recovery_consensus_failed', String(version), mismatch.join(', ')));
        consensusOk = false;
      }
    }
  }

  // Build the manifest from the MAP SOURCE's header metadata (provenance): a
  // manifest mixing one shard's map with another's blob_hash/scheme/stripe would
  // describe a version that does not exist.
  const manifestShards: ManifestShard[] = src.location_map.map((loc) => ({ shard_index: loc.shard_index, provider_id: loc.provider_id, provider_type: loc.provider_type, remote_path: loc.remote_path, shard_hash: loc.shard_hash }));
  const manifest: VersionManifest = {
    version,
    pushed_at: null,
    file_count: null,
    total_size: null,
    blob_hash: sourceMeta.blob_hash,
    scheme: { data_shards: sourceMeta.data_shards, parity_shards: sourceMeta.parity_shards },
    encrypted: sourceMeta.encrypted,
    shards: manifestShards,
    health: VersionHealth.Degraded,
  };
  // FORMAT_VERSION >= 2 (streaming pipeline): always rs_striped + per-shard
  // encryption. These flags live only in the manifest, never the header.
  if (sourceMeta.format_version >= 2) {
    manifest.rs_striped = true;
    if (sourceMeta.rs_stripe_size !== null) {
      manifest.rs_stripe_size = sourceMeta.rs_stripe_size;
    }
    if (sourceMeta.encrypted) manifest.encrypted_per_shard = true;
  }
  return { manifest, consensusOk };
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
export async function recover(rootDir: string, options: RecoveryOptions): Promise<RecoveryReport> {
  const { vaultName, provider: bootstrapProvider, io } = options;

  // ── 1. Create / reset .bfs/ and .bfs/cache/ ──────────────────────────────
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

  // ── 2. Bootstrap ──────────────────────────────────────────────────────────
  const passwordPool: string[] = options.passwords ? [...options.passwords] : [];

  const bootstrap = await bootstrapFromProvider(bootstrapProvider, { vaultName, io, passwords: passwordPool, transportInputs: options.bootstrapInputs, trustLocations: options.trustLocations === true });

  // Save bootstrap shard to cache
  bootstrapProvider.setVaultName(vaultName);

  // ── 2a. Adapter preflight from the bootstrap location map ─────────────────
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

  // ── 3. Discover all versions across all providers ─────────────────────────
  const allProviders: StorageProvider[] = [bootstrapProvider, ...bootstrap.providers];
  const versionProviderMap = await discoverAllVersions(allProviders, vaultName);

  // ── 4. Process each version — build and write its manifest ────────────────
  const reportVersions: Array<{ version: number; health: VersionHealth; consensus: boolean }> = [];
  let latestVerified = 0;
  const processCtx: ProcessVersionContext = { vaultName, bootstrapVaultId: bootstrap.vault_id, passwordPool, io };

  // Process newest versions first — bootstrap password is most likely to match
  // recent versions, minimizing interactive password prompts when passwords change.
  for (const version of [...versionProviderMap.keys()].sort((a, b) => b - a)) {
    const providerEntries = versionProviderMap.get(version);
    if (!providerEntries || providerEntries.size === 0) continue;

    const result = await processVersion(version, [...providerEntries.values()], processCtx);
    if (!result) continue;

    await writeManifest(rootDir, result.manifest);
    latestVerified = Math.max(latestVerified, version);
    reportVersions.push({ version, health: VersionHealth.Degraded, consensus: result.consensusOk });
  }

  if (reportVersions.length === 0) {
    throw new BfsError(t('recovery_no_manifests'));
  }

  // Find the actual latest verified version
  const allSortedVersions = reportVersions.map((v) => v.version).sort((a, b) => a - b);
  latestVerified = allSortedVersions[allSortedVersions.length - 1] ?? 0;
  const latestManifest = await readManifest(rootDir, latestVerified);
  if (!latestManifest) {
    throw new BfsError(fmt('recovery_manifest_unreadable', String(latestVerified)));
  }

  // ── 5. Reconstruct config.json from the latest manifest ───────────────────
  const config = reconstructConfig(bootstrap, latestManifest);
  await writeConfig(rootDir, config);

  // ── 6. Reconstruct state.json ─────────────────────────────────────────────
  // Mark the rebuilt config unconfirmed (it came from an untrusted location map)
  // so the first push/heal shows the locations and requires confirmation — unless
  // the operator already pre-approved them with --trust-locations (unattended).
  await writeState(rootDir, { latest_version: latestVerified, working_version: 0, locations_confirmed: options.trustLocations === true });

  // ── 7. Run verify to update health ────────────────────────────────────────
  const verifyReport = await verifyAll(rootDir, io);
  for (const vs of verifyReport.versions) {
    const rv = reportVersions.find((r) => r.version === vs.version);
    if (rv) rv.health = vs.health;
  }

  return { manifests_rebuilt: reportVersions.length, provider_count: config.providers.length, versions: reportVersions };
}
