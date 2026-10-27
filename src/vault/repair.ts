import { Readable } from 'node:stream';
import { BfsError, DecryptionError, ShardCorruptedError, TamperDetectedError } from '../core/errors.js';
import { parseShardHeaderFromStream, SHARD_HEADER_READ_BYTES } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ManifestShard, ProviderConfig, ProviderIO, RepairPair, ShardHeader, ShardLocation, StorageProvider, VaultConfig, VersionManifest } from '../types/index.js';
import { parseVersionFromFilename } from './bootstrap.js';
import { readConfig, writeConfig } from './config.js';
import { rebuildShardInPlace, rebuildVersion, relocateProvider, updateLocationMaps } from './heal.js';
import { secretFieldsForType, splitLocationSecrets } from './location-map.js';
import { acquireRepairLock, LOCK_FORMAT_VERSION, type RepairLock, type RepairLockFailedPair, type RepairLockFailedShard, type RepairLockSucceededPair, removeLock, repairLockPath, writeLockAtomic } from './lockfile.js';
import { listManifests, writeManifest } from './manifest.js';
import { tryDecryptLocationMap } from './password-pool.js';
import { buildRemotePath } from './push-pipeline.js';

/** Input to {@link repairVault}. Version resolution and spec parsing happen in the CLI layer. */
export interface RepairOptions {
  /** Classified `<name> "<params>"` pairs from `parseRepairSpec`. */
  readonly pairs: RepairPair[];
  /** Versions whose remote headers to rewrite (config change is always global). */
  readonly versions: number[];
  readonly io: ProviderIO;
  /** Vault passwords for encrypted backups, tried in MRU order. */
  readonly passwords: string[];
  /** Reed-Solomon-reconstruct a lost shard instead of only rewriting headers. */
  readonly rebuild: boolean;
  /** Continue a migration when a destination shard is unverifiable (not when it is missing or mismatched). With `rebuild` it also waives a destination whose header does not parse, which the reconstruction then overwrites. */
  readonly forceUnverified: boolean;
  /** Rebuild missing/broken location-header sidecars from the current config instead of editing a provider. Defaults to false. */
  readonly restoreHeaders?: boolean;
}

/** Outcome of {@link repairVault} - surviving pairs committed, failed pairs/shards left for retry. */
export interface RepairResult {
  readonly succeeded: RepairLockSucceededPair[];
  readonly failed_pairs: RepairLockFailedPair[];
  readonly failed_shards: RepairLockFailedShard[];
}

/**
 * Repairs the location of one or more providers whose payload is intact but
 * whose coordinates drifted (cross-OS path change, rotated credential). For
 * each pair it rewrites `.bfs/config.json` (global) and the sibling shards'
 * location maps for the in-scope versions, so a fresh recovery discovers the
 * provider at its new address. When `options.restoreHeaders` is set it takes no
 * pairs and instead rebuilds every location-header sidecar for the in-scope
 * versions from the current config. Delegates the config + header work to
 * {@link relocateProvider}; adds a plaintext integrity pre-check (foreign-shard
 * detection) and vault-password resolution, plus `repair.lock` forensics.
 *
 * @param rootDir  vault root directory
 * @param options  see {@link RepairOptions}
 * @returns committed and failed pairs; a non-empty `failed_pairs` means exit != 0
 * @throws BfsError on missing config or an empty version scope
 * @throws TamperDetectedError on a foreign shard; ShardCorruptedError when a
 *         probed header names another version; DecryptionError on password failure
 * @throws LockConcurrentActiveError when a live push or repair holds the vault
 * @throws LockReservationUnreadableError when repair.lock stays reserved without a readable owner
 */
export async function repairVault(rootDir: string, options: RepairOptions): Promise<RepairResult> {
  const { pairs, versions, io, passwords, rebuild, forceUnverified, restoreHeaders } = options;
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('no_config'));

  if (versions.length === 0) throw new BfsError(t('repair_no_versions'));

  const scoped = (await listManifests(rootDir)).filter((m) => versions.includes(m.version));

  // -- Phase 2a - plaintext integrity pre-check + vault-password resolution --
  const passwordPool = [...passwords];
  const vaultPassword = await precheckAndResolvePassword(config, scoped, passwordPool, io);

  // -- Lock -- (secrets in each "<params>" are redacted for the forensic file) --
  // acquireRepairLock is the atomic acquisition point: it writes repair.lock
  // via an exclusive create, so two overlapping repairs cannot both proceed.
  const redacted = new Map(pairs.map((p) => [p.oldName, redactPairParams(p, config, io)]));
  const command = restoreHeaders ? 'repair --restore-headers' : `repair ${pairs.map((p) => `${p.oldName} "${redacted.get(p.oldName) ?? ''}"`).join(' ')}`;
  const lock = buildRepairLock(command, versions.join(','));
  await acquireRepairLock(rootDir, lock);

  const ctx: CommitContext = { rootDir, config, pairs, versions, scoped, vaultPassword, io, lock, redacted, forceUnverified };
  if (restoreHeaders) {
    await commitRestoreHeaders(ctx);
  } else {
    // Same-id edits/rebuilds and type/id migrations are committed on distinct
    // paths; each pair independently joins succeeded/failed (clean exclusion).
    const migrationPairs = pairs.filter((p) => p.isMigration);
    const sameIdPairs = pairs.filter((p) => !p.isMigration);
    if (migrationPairs.length > 0) await commitMigrationPairs({ ...ctx, pairs: migrationPairs }, rebuild);
    if (sameIdPairs.length > 0) {
      if (rebuild) await commitRebuildPairs({ ...ctx, pairs: sameIdPairs });
      else await commitEditPairs({ ...ctx, pairs: sameIdPairs });
    }
  }

  if (lock.failed_pairs.length === 0 && lock.failed_shards.length === 0) await removeLock(repairLockPath(rootDir));

  return { succeeded: lock.succeeded_pairs, failed_pairs: lock.failed_pairs, failed_shards: lock.failed_shards };
}

/** Shared state for the per-pair commit phase (edit or rebuild). */
interface CommitContext {
  readonly rootDir: string;
  readonly config: VaultConfig;
  readonly pairs: RepairPair[];
  readonly versions: number[];
  readonly scoped: VersionManifest[];
  readonly vaultPassword: Nullable<string>;
  readonly io: ProviderIO;
  readonly lock: RepairLock;
  readonly redacted: Map<string, string>;
  readonly forceUnverified: boolean;
}

/**
 * Non-rebuild commit: for each pair rewrite the config (global) and the scoped
 * sibling headers via {@link relocateProvider}. A pair that throws is recorded
 * in `failed_pairs` and excluded; surviving pairs stay committed.
 */
async function commitEditPairs(ctx: CommitContext): Promise<void> {
  const { rootDir, config, pairs, versions, vaultPassword, io, lock, redacted } = ctx;
  for (const pair of pairs) {
    try {
      const newConnectionConfig = await buildEditConfig(config, pair, io);
      await relocateProvider(rootDir, pair.oldName, { newConnectionConfig, io, versions, ...(vaultPassword !== null ? { password: vaultPassword } : {}) });
      lock.succeeded_pairs.push({ old_name: pair.oldName, new_name: pair.oldName });
    } catch (err) {
      lock.failed_pairs.push({ name: pair.oldName, params: redacted.get(pair.oldName) ?? '', reason: 'unknown', detail: err instanceof Error ? err.message : String(err) });
    }
    await writeLockAtomic(repairLockPath(rootDir), lock);
  }
}

/**
 * Restore commit: for each in-scope version, rebuild every location-header
 * sidecar from the current `config.json` map plus each shard's in-shard frozen
 * fields (no payload pull), overwriting missing and broken ones alike. A version
 * that throws is recorded in `failed_shards`; the rest are left intact.
 */
async function commitRestoreHeaders(ctx: CommitContext): Promise<void> {
  const { rootDir, config, scoped, vaultPassword, io, lock } = ctx;
  for (const manifest of scoped) {
    try {
      const newLocationMap = buildConfigLocationMap(config, manifest, io);
      await updateLocationMaps(rootDir, manifest.version, { newLocationMap, io, ...(vaultPassword !== null ? { password: vaultPassword } : {}) });
    } catch (err) {
      lock.failed_shards.push({ version: manifest.version, shard_index: -1, pair_name: '', reason: 'unknown', detail: err instanceof Error ? err.message : String(err) });
    }
    await writeLockAtomic(repairLockPath(rootDir), lock);
  }
}

/**
 * Builds the location map for a version's sidecars from the current config: each
 * shard's connection details come from its provider entry, its position from the
 * manifest. Used to rebuild sidecars without changing any location.
 */
function buildConfigLocationMap(config: VaultConfig, manifest: VersionManifest, io: ProviderIO): ShardLocation[] {
  return manifest.shards.map((ms) => {
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    const split = splitLocationSecrets(ms.provider_type, pc?.config ?? {}, io);
    return {
      shard_index: ms.shard_index,
      provider_id: ms.provider_id,
      provider_type: ms.provider_type,
      adapterPackage: pc?.adapterPackage ?? null,
      connection_config: split.connection_config,
      required_inputs: split.required_inputs,
      remote_path: ms.remote_path,
      shard_hash: ms.shard_hash,
    };
  });
}

/**
 * Rebuild commit: for each pair, persist a location change to the config first
 * (when params are given), then Reed-Solomon-reconstruct the lost shard for
 * every in-scope version via {@link rebuildShardInPlace}. A version that throws
 * is recorded in `failed_shards`; a pair with no failures joins `succeeded_pairs`.
 */
async function commitRebuildPairs(ctx: CommitContext): Promise<void> {
  const { rootDir, config, pairs, versions, scoped, vaultPassword, io, lock } = ctx;
  for (const pair of pairs) {
    const newConnectionConfig = await applyRebuildConfigChange(rootDir, config, pair, io);
    let pairFailed = false;
    for (const version of versions) {
      try {
        await rebuildShardInPlace(rootDir, version, { providerId: pair.oldName, io, ...(vaultPassword !== null ? { password: vaultPassword } : {}), ...(newConnectionConfig ? { newConnectionConfig } : {}) });
      } catch (err) {
        pairFailed = true;
        const idx = scoped.find((m) => m.version === version)?.shards.find((s) => s.provider_id === pair.oldName)?.shard_index ?? -1;
        lock.failed_shards.push({ version, shard_index: idx, pair_name: pair.oldName, reason: 'unknown', detail: err instanceof Error ? err.message : String(err) });
      }
      await writeLockAtomic(repairLockPath(rootDir), lock);
    }
    if (!pairFailed) lock.succeeded_pairs.push({ old_name: pair.oldName, new_name: pair.oldName });
  }
}

/**
 * When a rebuild pair carries params (a new location), builds and persists the
 * new connection config globally so the rebuilt shard and its headers land at
 * the new address. Returns the new config, or null for an empty (in-place) pair.
 */
async function applyRebuildConfigChange(rootDir: string, config: VaultConfig, pair: RepairPair, io: ProviderIO): Promise<Nullable<Record<string, unknown>>> {
  if (pair.rawParams.length === 0) return null;
  const newConnectionConfig = await buildEditConfig(config, pair, io);
  const providers = config.providers.map((p) => (p.id === pair.oldName ? { ...p, config: newConnectionConfig } : p));
  await writeConfig(rootDir, { ...config, providers });
  config.providers = providers; // keep the in-memory config current for later pairs
  return newConnectionConfig;
}

/**
 * Migration commit: move a provider's shard to a new provider id/type. Phase A
 * ({@link scanPairAtDestination}) asks the destination what it holds before
 * anything is written, on both paths. Without `--rebuild` the payload is
 * expected already there, so anything but a match fails the pair; then the
 * config, every manifest and the scoped headers are swapped to the new provider.
 * With `--rebuild` the same answers are classified instead: what has to be
 * reconstructed goes to {@link migrateWithRebuild}, and a destination that
 * already holds every in-scope part is a plain relocation. Each pair
 * independently joins `succeeded_pairs` or `failed_pairs`.
 */
async function commitMigrationPairs(ctx: CommitContext, rebuild: boolean): Promise<void> {
  for (const pair of ctx.pairs) {
    const newConfig = pair.newConfig;
    if (!newConfig) continue; // a migration pair always carries newConfig
    try {
      const scan = await scanPairAtDestination({ ctx, pair, newConfig, rebuild });
      if (!scan.ok) {
        ctx.lock.failed_pairs.push({ name: pair.oldName, params: ctx.redacted.get(pair.oldName) ?? '', reason: scan.reason, detail: scan.detail });
        await writeLockAtomic(repairLockPath(ctx.rootDir), ctx.lock);
        continue;
      }
      // Nothing to reconstruct is a relocation, whether or not `--rebuild` was
      // asked for: every in-scope part is already sound at the destination.
      if (scan.rebuild.length === 0) await migrateInPlace(ctx, pair, newConfig);
      else await migrateWithRebuild({ ctx, pair, newConfig, scan });
      ctx.lock.succeeded_pairs.push({ old_name: pair.oldName, new_name: newConfig.id, new_type: newConfig.type });
    } catch (err) {
      ctx.lock.failed_pairs.push({ name: pair.oldName, params: ctx.redacted.get(pair.oldName) ?? '', reason: 'unknown', detail: err instanceof Error ? err.message : String(err) });
    }
    await writeLockAtomic(repairLockPath(ctx.rootDir), ctx.lock);
  }
}

/** One in-scope version whose part has to be reconstructed at the destination. */
interface RebuildTarget {
  readonly version: number;
  /** true when the manifest still names the pair's source; false when it names the destination. */
  readonly underOldName: boolean;
}

type DestinationScan = { ok: true; rebuild: RebuildTarget[]; present: number[] } | { ok: false; reason: RepairLockFailedPair['reason']; detail: string };

interface MigrateWithRebuildOptions {
  readonly ctx: CommitContext;
  readonly pair: RepairPair;
  readonly newConfig: ProviderConfig;
  /** Phase A's verdict: which in-scope versions to reconstruct, and which are already sound. */
  readonly scan: { readonly rebuild: RebuildTarget[]; readonly present: number[] };
}

interface DestinationScanOptions {
  readonly ctx: CommitContext;
  readonly pair: RepairPair;
  readonly newConfig: ProviderConfig;
  readonly rebuild: boolean;
}

interface ClassifyPartOptions {
  readonly ctx: CommitContext;
  readonly newConfig: ProviderConfig;
  readonly rebuild: boolean;
  readonly manifest: VersionManifest;
  readonly ms: ManifestShard;
  readonly provider: StorageProvider;
  /** true when the manifest names the pair's source rather than its destination. */
  readonly underOldName: boolean;
}

type PartVerdict = { outcome: 'rebuild' | 'present' } | { outcome: 'refuse'; reason: RepairLockFailedPair['reason']; detail: string };

/**
 * What one in-scope version's part at the destination means for this pair:
 * reconstruct it, leave it alone, or refuse the pair.
 */
async function _classifyDestinationPart(options: ClassifyPartOptions): Promise<PartVerdict> {
  const { ctx, newConfig, rebuild, manifest, ms, provider, underOldName } = options;
  const ref = { provider_id: newConfig.id, path: `shard_${ms.shard_index}.bfs.${manifest.version}` };
  const result = await provider.verifyShard(ref, { vault_id: ctx.config.vault_id, shard_index: ms.shard_index, version: manifest.version });
  if (result.ok) {
    // A manifest naming the pair's source still has to have its provider
    // swapped, which only the rebuild does - so those versions go there whatever
    // lies at the destination, exactly as they did before this gate existed.
    // Only a manifest already naming the destination can be left alone.
    if (rebuild && (underOldName || !(await _sizeMatchesSiblings({ ctx, manifest, ms, provider, ref })))) return { outcome: 'rebuild' };
    return { outcome: 'present' };
  }
  if (result.reason === 'not_found' && rebuild) return { outcome: 'rebuild' };
  // `corrupted` joins `unverifiable` under the waiver only on the rebuild path:
  // there the destination is about to be written anyway, so the operator can
  // decide to overwrite content nobody can identify. Without the waiver both
  // stay refusals, and on the non-rebuild path `corrupted` stays one regardless -
  // nothing would rewrite it, so continuing over it would commit to damage.
  const waivable = result.reason === 'unverifiable' || (rebuild && result.reason === 'corrupted');
  if (waivable && ctx.forceUnverified) {
    // Two different waivers: one says nobody could check, the other says what is
    // there could not be read AND is about to be written over.
    ctx.io.warn(fmt(result.reason === 'corrupted' ? 'repair_force_unreadable_warn' : 'repair_force_unverified_warn', String(manifest.version)));
    return { outcome: rebuild ? 'rebuild' : 'present' };
  }
  return { outcome: 'refuse', reason: result.reason, detail: result.detail };
}

/**
 * Phase A - asks the destination what lies under each in-scope version's part
 * before anything is written. Without `--rebuild` a missing / mismatched /
 * corrupted / auth failure fails the pair and an unverifiable result passes only
 * under `forceUnverified`, as the payload is expected to be there already.
 *
 * With `--rebuild` the same gate runs and the answers are classified instead:
 * an absent part is reconstructed, a sound one is left alone, and a part whose
 * identity matches but whose size does not is the leftover of an interrupted
 * run - reconstruction overwrites it. Identity alone cannot tell those two apart
 * (verifyShard compares vault_id, index and version, all of which survive in a
 * half-written file), so the size of a sibling part decides. A destination whose
 * content cannot be identified at all is still refused: reconstruction writes
 * over it, and BFS does not overwrite what it could not identify.
 */
async function scanPairAtDestination(options: DestinationScanOptions): Promise<DestinationScan> {
  const { ctx, pair, newConfig, rebuild } = options;
  let provider: StorageProvider;
  try {
    provider = providerRegistry.create(newConfig, ctx.io);
    if (rebuild) {
      // A rebuild destination is a possibly-fresh or wiped medium (lost disk,
      // replaced server), so its base directory may not exist yet.
      // probeConnection provisions it - exactly as init does - while a bare
      // authenticate() lists the base path and hard-fails on a provider that
      // lists strictly, refusing the pair before a part could be written.
      provider.setVaultName(ctx.config.vault_name);
      await provider.probeConnection();
    } else {
      await provider.authenticate();
      provider.setVaultName(ctx.config.vault_name);
    }
  } catch (err) {
    return { ok: false, reason: 'auth_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  const toRebuild: RebuildTarget[] = [];
  const present: number[] = [];
  for (const manifest of ctx.scoped) {
    // The part is looked up under either name this pair can carry. Restoring a
    // name the backup records but the configuration lost means no manifest ever
    // mentions `oldName` - matching on it alone would leave the identity gate
    // with nothing to check and wave a foreign part of the same filename through.
    const ms = manifest.shards.find((s) => s.provider_id === pair.oldName) ?? manifest.shards.find((s) => s.provider_id === newConfig.id);
    if (!ms) continue; // this version does not use the migrated provider
    const underOldName = ms.provider_id === pair.oldName;
    const verdict = await _classifyDestinationPart({ ctx, newConfig, rebuild, manifest, ms, provider, underOldName });
    if (verdict.outcome === 'refuse') return { ok: false, reason: verdict.reason, detail: verdict.detail };
    if (verdict.outcome === 'rebuild') toRebuild.push({ version: manifest.version, underOldName });
    else present.push(manifest.version);
  }
  return { ok: true, rebuild: toRebuild, present };
}

/**
 * True when the destination part is as long as a sibling part of the same
 * version. Parts of one version are written to the same length, so a sibling is
 * the cheapest yardstick - and `getSize` is a metadata call every medium can
 * answer, unlike reading a header in place. The yardstick is approximate in one
 * direction only: a part rebuilt onto a new address carries a location map of
 * its own length, so a sound part can read as different and be reconstructed
 * needlessly - which costs transfer, never data. An unreadable yardstick (no
 * sibling left, or one that will not answer) returns true: without a length to
 * compare against, the identity match is all there is, and it already passed.
 */
async function _sizeMatchesSiblings(options: Omit<ClassifyPartOptions, 'newConfig' | 'rebuild' | 'underOldName'> & { ref: { provider_id: string; path: string } }): Promise<boolean> {
  const { ctx, manifest, ms, provider, ref } = options;
  for (const sibling of manifest.shards) {
    if (sibling.provider_id === ms.provider_id) continue;
    const pc = ctx.config.providers.find((p) => p.id === sibling.provider_id);
    if (!pc) continue;
    try {
      const siblingProvider = providerRegistry.create(pc, ctx.io);
      await siblingProvider.authenticate();
      siblingProvider.setVaultName(ctx.config.vault_name);
      const expected = await siblingProvider.getSize({ provider_id: sibling.provider_id, path: `shard_${sibling.shard_index}.bfs.${manifest.version}` });
      return (await provider.getSize(ref)) === expected;
    } catch (err) {
      // A sibling that cannot answer is skipped - but a storage presenting an
      // identity it was not pinned under is not something to step over while
      // measuring a file: it fails the pair, with the reason kept in repair.lock.
      if (err instanceof TamperDetectedError) throw err;
    }
  }
  return true;
}

/**
 * Non-rebuild migration commit: swap the provider in the config, rename it in
 * every manifest (global), and rewrite the scoped sibling headers so recovery
 * finds the shard under the new provider. The payload is already at the target.
 */
async function migrateInPlace(ctx: CommitContext, pair: RepairPair, newConfig: ProviderConfig): Promise<void> {
  const providers = ctx.config.providers.filter((p) => p.id !== pair.oldName).concat(newConfig);
  await writeConfig(ctx.rootDir, { ...ctx.config, providers });
  ctx.config.providers = providers;
  await renameProviderInManifests(ctx.rootDir, pair.oldName, newConfig, ctx.config.vault_name);
  await relocateProvider(ctx.rootDir, newConfig.id, { newConnectionConfig: newConfig.config, io: ctx.io, versions: ctx.versions, ...(ctx.vaultPassword !== null ? { password: ctx.vaultPassword } : {}) });
}

/**
 * Rebuild migration commit: add the new provider, then Reed-Solomon-reconstruct
 * the parts Phase A marked - {@link rebuildVersion} for a manifest that names the
 * pair's source (it swaps the provider in the manifest + location maps),
 * {@link rebuildShardInPlace} for one that already names the destination, where
 * there is no provider to swap. Versions whose part was sound get their location
 * maps pointed at the new address instead. A pair that reconstructed nothing
 * rolls its config write back, so the pool keeps its size and the same command
 * can be run again; the old provider is dropped once no manifest references it.
 */
async function migrateWithRebuild(options: MigrateWithRebuildOptions): Promise<void> {
  const { ctx, pair, newConfig, scan } = options;
  const before = ctx.config.providers;
  if (!ctx.config.providers.some((p) => p.id === newConfig.id)) {
    const providers = [...ctx.config.providers, newConfig];
    await writeConfig(ctx.rootDir, { ...ctx.config, providers });
    ctx.config.providers = providers;
  }
  let reconstructed = 0;
  try {
    for (const target of scan.rebuild) {
      // A manifest naming the pair's source is the classic replacement: the part
      // moves to a provider the backup has not heard of, so rebuildVersion swaps
      // it in. A manifest naming the destination is the name the configuration
      // lost: there is no provider to swap, the part is simply missing from the
      // one it already records, and it is rebuilt where it stands.
      if (target.underOldName) await rebuildVersion(ctx.rootDir, target.version, { removedProviderId: pair.oldName, targetProviderId: newConfig.id, io: ctx.io, ...(ctx.vaultPassword !== null ? { password: ctx.vaultPassword } : {}) });
      else await rebuildShardInPlace(ctx.rootDir, target.version, { providerId: newConfig.id, io: ctx.io, ...(ctx.vaultPassword !== null ? { password: ctx.vaultPassword } : {}), newConnectionConfig: newConfig.config });
      reconstructed += 1;
    }
  } catch (err) {
    // A pair that reconstructed nothing leaves the pool the size it was. One
    // entry too many and the scheme stops matching, which refuses every write
    // AND the retry of this very command - the recorded name would already be
    // taken by the half-finished repair. Once a version IS committed the entry
    // has to stay: its part now lives under that name.
    if (reconstructed === 0) {
      await writeConfig(ctx.rootDir, { ...ctx.config, providers: before });
      ctx.config.providers = before;
    }
    throw err;
  }
  // Versions whose part was already sound still need the location maps pointed
  // at the new address; the rebuilt ones had theirs rewritten as they went.
  if (scan.present.length > 0) {
    await relocateProvider(ctx.rootDir, newConfig.id, { newConnectionConfig: newConfig.config, io: ctx.io, versions: scan.present, ...(ctx.vaultPassword !== null ? { password: ctx.vaultPassword } : {}) });
    // relocateProvider persists its own config change (it refreshes the adapter
    // package from the registry), so the in-memory copy is a version behind and
    // the write below would roll that back.
    const persisted = await readConfig(ctx.rootDir);
    if (persisted) ctx.config.providers = persisted.providers;
  }
  const stillReferenced = (await listManifests(ctx.rootDir)).some((m) => m.shards.some((s) => s.provider_id === pair.oldName));
  if (!stillReferenced) {
    const providers = ctx.config.providers.filter((p) => p.id !== pair.oldName);
    await writeConfig(ctx.rootDir, { ...ctx.config, providers });
    ctx.config.providers = providers;
  }
}

/**
 * Renames a provider (id + type) in every manifest that references it. The
 * config/manifest identity change is global - independent of `--version`.
 */
async function renameProviderInManifests(rootDir: string, oldName: string, newConfig: ProviderConfig, vaultName: string): Promise<void> {
  const manifests = await listManifests(rootDir);
  for (const manifest of manifests) {
    if (!manifest.shards.some((s) => s.provider_id === oldName)) continue;
    const shards: ManifestShard[] = manifest.shards.map((s) =>
      s.provider_id === oldName ? { ...s, provider_id: newConfig.id, provider_type: newConfig.type, remote_path: buildRemotePath(newConfig, vaultName, `shard_${s.shard_index}.bfs.${manifest.version}`) } : s,
    );
    await writeManifest(rootDir, { ...manifest, shards });
  }
}

/**
 * For each in-scope version, probes one reachable shard header to detect a
 * foreign shard (plaintext vault_id mismatch) and, for encrypted backups,
 * resolves a working vault password (reused for every version). Read-only: runs
 * before the lock so a bad password or foreign shard aborts without side effects.
 *
 * @returns the working password, or null when no version in scope is encrypted
 * @throws TamperDetectedError on a foreign shard; DecryptionError when no password works
 */
async function precheckAndResolvePassword(config: VaultConfig, scoped: VersionManifest[], passwordPool: string[], io: ProviderIO): Promise<Nullable<string>> {
  let resolved: Nullable<string> = null;
  for (const manifest of scoped) {
    const probe = await probeShardHeader(config, manifest, io);
    if (!probe) continue; // no reachable shard for this version - nothing to check

    if (probe.header.vault_id !== config.vault_id) {
      throw new TamperDetectedError(fmt('repair_foreign_shard_detected', String(manifest.version)));
    }

    if (manifest.encrypted && resolved === null) {
      const result = await tryDecryptLocationMap(probe.header, probe.headerBytes, passwordPool, io, {
        poolExhausted: fmt('repair_pool_password_failed', String(manifest.version)),
        ask: fmt('repair_ask_vault_password', String(manifest.version)),
        retry: fmt('repair_wrong_vault_password_retry', String(manifest.version)),
      });
      // "Attempts exhausted" is only true where attempts were possible. A run
      // with no terminal never gets to try, whether it declared `--ci` or simply
      // has nobody watching, so it hears which flag supplies more passwords.
      // Both reach here as the same signal: `--ci` is what makes the caller build
      // a ProviderIO that reports itself non-interactive on a terminal too.
      const noOperator = io.interactive === false;
      if (!result) throw new DecryptionError(fmt(noOperator ? 'repair_password_required_ci' : 'repair_password_exhausted', String(manifest.version)));
      resolved = result.password;
    }
  }
  return resolved;
}

/**
 * Downloads and parses the header of the first reachable shard for a version.
 * Verifies the filename encodes the same index/version the header claims.
 * Returns null when no provider is reachable; re-throws integrity violations.
 */
async function probeShardHeader(config: VaultConfig, manifest: VersionManifest, io: ProviderIO): Promise<Nullable<{ header: ShardHeader; headerBytes: Buffer }>> {
  for (const ms of manifest.shards) {
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) continue;
    const filename = `shard_${ms.shard_index}.bfs.${manifest.version}`;
    try {
      const provider = providerRegistry.create(pc, io);
      await provider.authenticate();
      provider.setVaultName(config.vault_name);
      const bytes = await provider.downloadHeader({ provider_id: ms.provider_id, path: filename }, SHARD_HEADER_READ_BYTES);
      const parsed = await parseShardHeaderFromStream(Readable.from(bytes));
      parsed.payloadStream.on('error', () => {}).destroy();
      const named = parseVersionFromFilename(filename);
      if (!named || named.shardIndex !== parsed.header.shard_index || named.version !== parsed.header.version) {
        throw new ShardCorruptedError(fmt('repair_wrong_version_shard', String(manifest.version)));
      }
      return { header: parsed.header, headerBytes: bytes };
    } catch (err) {
      if (err instanceof TamperDetectedError || err instanceof ShardCorruptedError) throw err;
      // provider unreachable or header unreadable - try the next sibling
    }
  }
  return null;
}

/**
 * Builds the full replacement connection-config for an in-place edit, mirroring
 * `bfs provider edit`: the adapter's `configureFromFlags` produces the whole
 * config (not a per-field merge) and `validateConfig` gates it.
 *
 * @throws BfsError when the provider is unknown or the adapter rejects the config
 */
async function buildEditConfig(config: VaultConfig, pair: RepairPair, io: ProviderIO): Promise<Record<string, unknown>> {
  const existing = config.providers.find((p) => p.id === pair.oldName);
  if (!existing) throw new BfsError(fmt('repair_unknown_provider', pair.oldName));
  const factory = providerRegistry.getFactory(existing.type);
  if (!factory) throw new BfsError(fmt('provider_type_unknown', existing.type));
  const instance = factory.create({ id: existing.id, type: existing.type, adapterPackage: existing.adapterPackage, config: {} }, io);
  const newConfig = await instance.configureFromFlags({ name: existing.id, rawArgs: pair.rawParams });
  const errors = instance.validateConfig(newConfig);
  if (errors.length > 0) throw new BfsError(fmt('repair_edit_invalid_config', errors.join('; ')));
  return newConfig;
}

/** Builds a fresh `repair.lock` with empty progress arrays. */
function buildRepairLock(command: string, versionRange: string): RepairLock {
  return { format_version: LOCK_FORMAT_VERSION, operation: 'repair', version_range: versionRange, pid: process.pid, command, started_at: new Date().toISOString(), succeeded_pairs: [], failed_pairs: [], failed_shards: [] };
}

/**
 * Redacts a pair's params for the forensic lock, masking secret flag values with
 * the union of the current provider's and the migration target's secret fields.
 * Exported for regression coverage of the type-changing-migration masking.
 */
export function redactPairParams(pair: RepairPair, config: VaultConfig, io: ProviderIO): string {
  return redactParams(pair.rawParams, pairSecretFields(pair, config, io));
}

/**
 * Secret field names to mask in a pair's params. Unions the current provider's
 * secret fields with the migration target type's - a migration's params carry
 * the NEW type's flags (e.g. `local`->`ftp` with `--password`), so masking must
 * use the target type's declaration, not the source's.
 */
function pairSecretFields(pair: RepairPair, config: VaultConfig, io: ProviderIO): string[] {
  const fields = new Set(secretFieldsForType(config.providers.find((c) => c.id === pair.oldName)?.type ?? '', io));
  if (pair.newConfig) {
    for (const f of secretFieldsForType(pair.newConfig.type, io)) fields.add(f);
  }
  return [...fields];
}

/**
 * Masks the value after each secret flag so the forensic `repair.lock` never
 * stores a plaintext credential. BFS-core stays blind to field semantics - the
 * provider declares which fields are secret via `getSecretFields()`.
 */
function redactParams(rawParams: string[], secretFields: readonly string[]): string {
  const out: string[] = [];
  for (let i = 0; i < rawParams.length; i++) {
    const tok = rawParams[i];
    out.push(tok);
    if (tok.startsWith('--') && secretFields.includes(tok.slice(2)) && i + 1 < rawParams.length) {
      out.push('***');
      i++;
    }
  }
  return out.join(' ');
}
