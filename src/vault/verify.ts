import { BfsError } from '../core/errors.js';
import { createProvider } from '../providers/provider.js';
import type { ProviderIO, VersionHealth } from '../types/index.js';
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
export async function verifyAll(
  rootDir: string,
  io: ProviderIO,
): Promise<VerifyReport> {
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
export async function verifyVersion(
  rootDir: string,
  version: number,
  io: ProviderIO,
): Promise<VersionStatus> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const manifest = await readManifest(rootDir, version);
  if (!manifest)
    throw new BfsError(`Manifest for version ${version} not found.`);

  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const total = N + K;
  let available = 0;

  for (const ms of manifest.shards) {
    // Find provider config
    const pc = config.providers.find((p) => p.id === ms.provider_id);
    if (!pc) continue; // provider removed from config

    try {
      const provider = createProvider(pc, io);

      // Check provider health
      const healthy = await provider.healthCheck();
      if (!healthy) continue;

      // Check shard exists (list with filename prefix)
      await provider.authenticate();
      provider.setVaultName(config.vault_name);
      const filename = `shard_${ms.shard_index}.bfs.${version}`;
      const refs = await provider.list(filename);
      if (refs.some((r) => r.path === filename)) {
        available++;
      }
    } catch {
      // provider unreachable or error — shard counts as unavailable
    }
  }

  let health: VersionHealth;
  if (available < N) {
    health = 'damaged';
  } else if (available < total) {
    health = 'degraded';
  } else {
    health = 'healthy';
  }

  // Update manifest health on disk
  if (manifest.health !== health) {
    manifest.health = health;
    await writeManifest(rootDir, manifest);
  }

  const tolerance = available >= N ? available - N : 0;

  return {
    version,
    health,
    available_shards: available,
    total_shards: total,
    tolerance,
  };
}
