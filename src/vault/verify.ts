import { BfsError } from '../core/errors.js';
import { buildShardHeaderFromBytes, extractSidecarHeaderBytes, SHARD_HEADER_READ_BYTES } from '../core/shard-io.js';
import { fmt } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ManifestShard, ProviderIO, RemoteRef, ShardHeader, StorageProvider, VaultConfig, VersionManifest } from '../types/index.js';
import { VersionHealth } from '../types/index.js';
import { readConfig } from './config.js';
import { listManifests, readManifest, writeManifest } from './manifest.js';

// ─── Report types ─────────────────────────────────────────────────────────────

/** Per-version advisory about location-header (sidecar) files, orthogonal to data health. */
export interface HeaderAdvisory {
  missing: number;
  broken: number;
}

export interface VersionStatus {
  version: number;
  health: VersionHealth;
  available_shards: number;
  total_shards: number;
  /** Number of additional shards that can be lost before data becomes unrecoverable. 0 when damaged. */
  tolerance: number;
  /**
   * Location-header advisory, orthogonal to `health` (which tracks payload
   * recoverability). Non-null only when at least one reachable shard has a
   * healthy header while one or more are missing or broken.
   */
  header_advisory: Nullable<HeaderAdvisory>;
}

export interface VerifyReport {
  versions: VersionStatus[];
}

/** Sidecar-header presence for a single shard, as observed on a reachable provider. */
type SidecarState = 'valid' | 'missing' | 'broken' | 'n/a';

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
  const sidecarCounts = { valid: 0, missing: 0, broken: 0 };

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
      const result = await checkShardIntegrity(provider, config, manifest, ms, io);
      if (result.available) available++;
      if (result.sidecar !== 'n/a') sidecarCounts[result.sidecar]++;
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
  // Advisory only when a healthy sibling proves the version was relocated
  // (so every shard should carry a sidecar), yet some are missing or broken.
  const header_advisory: Nullable<HeaderAdvisory> = sidecarCounts.valid >= 1 && sidecarCounts.missing + sidecarCounts.broken >= 1 ? { missing: sidecarCounts.missing, broken: sidecarCounts.broken } : null;

  return { version, health, available_shards: available, total_shards: total, tolerance, header_advisory };
}

/**
 * Verifies that a single shard exists, has a non-zero size, and carries an
 * in-shard header consistent with the manifest, and observes the state of its
 * location-header sidecar. Pulls only the header window (~16 KB) — providers
 * MUST NOT stream the full payload.
 *
 * Availability is read from the IN-SHARD header, so it is independent of the
 * sidecar: a broken or missing sidecar never marks the shard unavailable.
 *
 * Failure modes (reported via io.warn, `available: false`):
 *   - getSize fails or returns 0   → shard missing
 *   - downloadHeader / parse fails → header truncated or corrupt
 *   - vault_id / version / shard_index / blob_hash / scheme mismatch → wrong shard
 *
 * @returns availability plus the observed sidecar state
 */
async function checkShardIntegrity(provider: StorageProvider, config: VaultConfig, manifest: VersionManifest, ms: ManifestShard, io: ProviderIO): Promise<{ available: boolean; sidecar: SidecarState }> {
  const filename = `shard_${ms.shard_index}.bfs.${manifest.version}`;
  const ref = { provider_id: provider.id, path: filename };

  let size: number;
  try {
    size = await provider.getSize(ref);
  } catch {
    return { available: false, sidecar: 'n/a' }; // missing
  }
  if (size === 0) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, 'size=0'));
    return { available: false, sidecar: 'n/a' };
  }

  const sidecar = await probeSidecarState(provider, ref);

  let header: ShardHeader;
  try {
    header = buildShardHeaderFromBytes(await provider.downloadHeader(ref, SHARD_HEADER_READ_BYTES));
  } catch (err) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, err instanceof Error ? err.message : String(err)));
    return { available: false, sidecar };
  }

  const mismatches = headerMismatches(header, config, manifest, ms);
  if (mismatches.length > 0) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, `header mismatch: ${mismatches.join(', ')}`));
    return { available: false, sidecar };
  }
  return { available: true, sidecar };
}

/** Collects the manifest/config fields the in-shard header disagrees with. */
function headerMismatches(header: ShardHeader, config: VaultConfig, manifest: VersionManifest, ms: ManifestShard): string[] {
  const mismatches: string[] = [];
  if (header.vault_id !== config.vault_id) mismatches.push('vault_id');
  if (header.version !== manifest.version) mismatches.push('version');
  if (header.shard_index !== ms.shard_index) mismatches.push('shard_index');
  if (header.blob_hash !== manifest.blob_hash) mismatches.push('blob_hash');
  if (header.data_shards !== manifest.scheme.data_shards) mismatches.push('data_shards');
  if (header.parity_shards !== manifest.scheme.parity_shards) mismatches.push('parity_shards');
  return mismatches;
}

/**
 * Classifies the location-header sidecar for a shard on a reachable provider:
 * `valid` (a well-formed BFSH envelope), `missing` (no sidecar), `broken` (a
 * file that fails BFSH validation), or `n/a` (provider stores headers in place,
 * or the sidecar probe itself failed). Password-free — validates the envelope
 * (magic + checksum) without decrypting the location map.
 */
async function probeSidecarState(provider: StorageProvider, ref: RemoteRef): Promise<SidecarState> {
  if (!provider.usesSidecar()) return 'n/a';

  let sidecar: Buffer | null;
  try {
    sidecar = await provider.downloadHeaderSidecar(ref, SHARD_HEADER_READ_BYTES);
  } catch {
    return 'n/a'; // a flaky probe must not be reported as a missing header
  }
  if (sidecar === null) return 'missing';

  try {
    extractSidecarHeaderBytes(sidecar);
    return 'valid';
  } catch {
    return 'broken';
  }
}
