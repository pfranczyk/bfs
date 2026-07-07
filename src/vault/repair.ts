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
import { assertNoActiveLock, LOCK_FORMAT_VERSION, type RepairLock, type RepairLockFailedPair, type RepairLockFailedShard, type RepairLockSucceededPair, removeLock, repairLockPath, writeLockAtomic } from './lockfile.js';
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
  /** Non-interactive: never prompt; an unresolved password fails fast. */
  readonly isCi: boolean;
  /** Reed-Solomon-reconstruct a lost shard instead of only rewriting headers. */
  readonly rebuild: boolean;
  /** Continue a migration when a destination shard is unverifiable (not when it is missing or mismatched). */
  readonly forceUnverified: boolean;
  /** Rebuild missing/broken location-header sidecars from the current config instead of editing a provider. Defaults to false. */
  readonly restoreHeaders?: boolean;
}

/** Outcome of {@link repairVault} — surviving pairs committed, failed pairs/shards left for retry. */
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
 * @returns committed and failed pairs; a non-empty `failed_pairs` means exit ≠ 0
 * @throws BfsError on missing config, empty scope, or an unsupported migration
 * @throws TamperDetectedError on a foreign shard; DecryptionError on password failure
 */
export async function repairVault(rootDir: string, options: RepairOptions): Promise<RepairResult> {
  const { pairs, versions, io, passwords, isCi, rebuild, forceUnverified, restoreHeaders } = options;
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError(t('no_config'));

  if (versions.length === 0) throw new BfsError(t('repair_no_versions'));

  const scoped = (await listManifests(rootDir)).filter((m) => versions.includes(m.version));

  // ── Phase 2a — plaintext integrity pre-check + vault-password resolution ──
  const passwordPool = [...passwords];
  const vaultPassword = await precheckAndResolvePassword(config, scoped, passwordPool, io, isCi);

  // ── Lock ── (secrets in each "<params>" are redacted for the forensic file) ──
  await assertNoActiveLock(rootDir, 'repair');
  const redacted = new Map(pairs.map((p) => [p.oldName, redactPairParams(p, config, io)]));
  const command = restoreHeaders ? 'repair --restore-headers' : `repair ${pairs.map((p) => `${p.oldName} "${redacted.get(p.oldName) ?? ''}"`).join(' ')}`;
  const lock = buildRepairLock(command, versions.join(','));
  await writeLockAtomic(repairLockPath(rootDir), lock);

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
 * Migration commit: move a provider's shard to a new provider id/type. Without
 * `--rebuild` the payload is expected already at the destination — Phase A
 * verifyShard confirms it, then the config, every manifest and the scoped
 * headers are swapped to the new provider. With `--rebuild` the lost shard is
 * Reed-Solomon-reconstructed onto the new provider via {@link rebuildVersion}.
 * Each pair independently joins `succeeded_pairs` or `failed_pairs`.
 */
async function commitMigrationPairs(ctx: CommitContext, rebuild: boolean): Promise<void> {
  for (const pair of ctx.pairs) {
    const newConfig = pair.newConfig;
    if (!newConfig) continue; // a migration pair always carries newConfig
    try {
      if (rebuild) {
        await migrateWithRebuild(ctx, pair, newConfig);
      } else {
        const verdict = await verifyPairAtDestination(ctx, pair, newConfig);
        if (!verdict.ok) {
          ctx.lock.failed_pairs.push({ name: pair.oldName, params: ctx.redacted.get(pair.oldName) ?? '', reason: verdict.reason, detail: verdict.detail });
          await writeLockAtomic(repairLockPath(ctx.rootDir), ctx.lock);
          continue;
        }
        await migrateInPlace(ctx, pair, newConfig);
      }
      ctx.lock.succeeded_pairs.push({ old_name: pair.oldName, new_name: newConfig.id, new_type: newConfig.type });
    } catch (err) {
      ctx.lock.failed_pairs.push({ name: pair.oldName, params: ctx.redacted.get(pair.oldName) ?? '', reason: 'unknown', detail: err instanceof Error ? err.message : String(err) });
    }
    await writeLockAtomic(repairLockPath(ctx.rootDir), ctx.lock);
  }
}

/**
 * Phase A — verifies the migrated shard is present and identical at the new
 * provider for every in-scope version. Clean-exclusion verdict: a missing /
 * mismatched / corrupted / auth failure fails the pair; an unverifiable result
 * passes only under `forceUnverified`.
 */
async function verifyPairAtDestination(ctx: CommitContext, pair: RepairPair, newConfig: ProviderConfig): Promise<{ ok: true } | { ok: false; reason: RepairLockFailedPair['reason']; detail: string }> {
  let provider: StorageProvider;
  try {
    provider = providerRegistry.create(newConfig, ctx.io);
    await provider.authenticate();
    provider.setVaultName(ctx.config.vault_name);
  } catch (err) {
    return { ok: false, reason: 'auth_failed', detail: err instanceof Error ? err.message : String(err) };
  }
  for (const manifest of ctx.scoped) {
    const ms = manifest.shards.find((s) => s.provider_id === pair.oldName);
    if (!ms) continue; // this version does not use the migrated provider
    const filename = `shard_${ms.shard_index}.bfs.${manifest.version}`;
    const result = await provider.verifyShard({ provider_id: newConfig.id, path: filename }, { vault_id: ctx.config.vault_id, shard_index: ms.shard_index, version: manifest.version });
    if (!result.ok) {
      if (result.reason === 'unverifiable' && ctx.forceUnverified) {
        ctx.io.warn(fmt('repair_force_unverified_warn', String(manifest.version)));
        continue;
      }
      return { ok: false, reason: result.reason, detail: result.detail };
    }
  }
  return { ok: true };
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
 * Rebuild migration commit: add the new provider, Reed-Solomon-reconstruct the
 * lost shard onto it for each in-scope version (rebuildVersion swaps the
 * provider in the manifest + location maps), then drop the old provider once no
 * manifest references it.
 */
async function migrateWithRebuild(ctx: CommitContext, pair: RepairPair, newConfig: ProviderConfig): Promise<void> {
  if (!ctx.config.providers.some((p) => p.id === newConfig.id)) {
    const providers = [...ctx.config.providers, newConfig];
    await writeConfig(ctx.rootDir, { ...ctx.config, providers });
    ctx.config.providers = providers;
  }
  for (const version of ctx.versions) {
    await rebuildVersion(ctx.rootDir, version, { removedProviderId: pair.oldName, targetProviderId: newConfig.id, io: ctx.io, ...(ctx.vaultPassword !== null ? { password: ctx.vaultPassword } : {}) });
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
 * config/manifest identity change is global — independent of `--version`.
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
async function precheckAndResolvePassword(config: VaultConfig, scoped: VersionManifest[], passwordPool: string[], io: ProviderIO, isCi: boolean): Promise<Nullable<string>> {
  let resolved: Nullable<string> = null;
  for (const manifest of scoped) {
    const probe = await probeShardHeader(config, manifest, io);
    if (!probe) continue; // no reachable shard for this version — nothing to check

    if (probe.header.vault_id !== config.vault_id) {
      throw new TamperDetectedError(fmt('repair_foreign_shard_detected', String(manifest.version)));
    }

    if (manifest.encrypted && resolved === null) {
      const result = await tryDecryptLocationMap(probe.header, probe.headerBytes, passwordPool, io, {
        poolExhausted: fmt('repair_pool_password_failed', String(manifest.version)),
        ask: fmt('repair_ask_vault_password', String(manifest.version)),
        retry: fmt('repair_wrong_vault_password_retry', String(manifest.version)),
      });
      if (!result) throw new DecryptionError(fmt(isCi ? 'repair_password_required_ci' : 'repair_password_exhausted', String(manifest.version)));
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
      // provider unreachable or header unreadable — try the next sibling
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
 * secret fields with the migration target type's — a migration's params carry
 * the NEW type's flags (e.g. `local`→`ftp` with `--password`), so masking must
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
 * stores a plaintext credential. BFS-core stays blind to field semantics — the
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
