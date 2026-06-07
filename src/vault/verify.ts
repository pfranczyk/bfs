import { BfsError } from '../core/errors.js';
import { readShardHeader } from '../core/shard-io.js';
import { fmt } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ManifestShard, ProviderIO, ShardHeader, StorageProvider, VaultConfig, VersionManifest } from '../types/index.js';
import { VersionHealth } from '../types/index.js';
import { readConfig } from './config.js';
import { listManifests, readManifest, writeManifest } from './manifest.js';

// ─── Report types ─────────────────────────────────────────────────────────────

export interface VersionStatus {
  version: number;
  health: VersionHealth;
  available_shards: number;
  total_shards: number;
  /** Number of additional shards that can be lost before data becomes unrecoverable. 0 when damaged. */
  tolerance: number;
}

export interface VerifyReport {
  versions: VersionStatus[];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Verifies health of all manifest versions.
 * For each version, checks provider availability and shard existence.
 * Updates health in each manifest file.
 *
 * @param rootDir - Vault root directory
 * @param io      - ProviderIO for provider authentication
 * @returns       Report with status for each version
 * @throws BfsError if config is missing
 */
export async function verifyAll(rootDir: string, io: ProviderIO): Promise<VerifyReport> {
  const manifests = await listManifests(rootDir);
  const results: VersionStatus[] = [];
  for (const manifest of manifests) {
    const vs = await verifyVersion(rootDir, manifest.version, io);
    results.push(vs);
  }
  return { versions: results };
}

/**
 * Verifies health of a single version.
 * Checks each shard: provider accessible + file exists.
 * Updates the manifest health field on disk.
 *
 * @param rootDir - Vault root directory
 * @param version - Version number to check
 * @param io      - ProviderIO for provider authentication
 * @returns       VersionStatus (health, available/total shards)
 * @throws BfsError if config or manifest is missing
 */
export async function verifyVersion(rootDir: string, version: number, io: ProviderIO): Promise<VersionStatus> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const manifest = await readManifest(rootDir, version);
  if (!manifest) throw new BfsError(`Manifest for version ${version} not found.`);

  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const total = N + K;
  let available = 0;

  for (const ms of manifest.shards) {
    // Find provider config
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) continue; // provider removed from config

    try {
      const provider = providerRegistry.create(pc, io);

      // Check provider health
      const healthy = await provider.healthCheck();
      if (!healthy) continue;

      await provider.authenticate();
      provider.setVaultName(config.vault_name);
      const ok = await checkShardIntegrity(provider, config, manifest, ms, io);
      if (ok) available++;
    } catch {
      // provider unreachable or error — shard counts as unavailable
    }
  }

  let health: VersionHealth;
  if (available < N) {
    health = VersionHealth.Damaged;
  } else if (available < total) {
    health = VersionHealth.Degraded;
  } else {
    health = VersionHealth.Healthy;
  }

  // Update manifest health on disk
  if (manifest.health !== health) {
    manifest.health = health;
    await writeManifest(rootDir, manifest);
  }

  const tolerance = available >= N ? available - N : 0;

  return { version, health, available_shards: available, total_shards: total, tolerance };
}

/**
 * Verifies that a single shard exists, has a non-zero size, and carries a
 * header consistent with the manifest. Pulls only the header window
 * (~16 KB) — providers MUST NOT stream the full payload.
 *
 * Failure modes (all reported via io.warn and counted as unavailable):
 *   - getSize fails or returns 0   → shard missing
 *   - downloadHeader / parse fails → header truncated or corrupt
 *   - vault_id / version / shard_index / blob_hash / scheme mismatch → wrong shard
 *
 * @returns true when the shard is healthy
 */
async function checkShardIntegrity(provider: StorageProvider, config: VaultConfig, manifest: VersionManifest, ms: ManifestShard, io: ProviderIO): Promise<boolean> {
  const filename = `shard_${ms.shard_index}.bfs.${manifest.version}`;
  const ref = { provider_id: provider.id, path: filename };

  let size: number;
  try {
    size = await provider.getSize(ref);
  } catch {
    return false; // missing
  }
  if (size === 0) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, 'size=0'));
    return false;
  }

  let header: ShardHeader;
  try {
    header = await readShardHeader(provider, ref);
  } catch (err) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, err instanceof Error ? err.message : String(err)));
    return false;
  }

  const mismatches: string[] = [];
  if (header.vault_id !== config.vault_id) mismatches.push('vault_id');
  if (header.version !== manifest.version) mismatches.push('version');
  if (header.shard_index !== ms.shard_index) mismatches.push('shard_index');
  if (header.blob_hash !== manifest.blob_hash) mismatches.push('blob_hash');
  if (header.data_shards !== manifest.scheme.data_shards) mismatches.push('data_shards');
  if (header.parity_shards !== manifest.scheme.parity_shards) mismatches.push('parity_shards');
  if (mismatches.length > 0) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, `header mismatch: ${mismatches.join(', ')}`));
    return false;
  }
  return true;
}
