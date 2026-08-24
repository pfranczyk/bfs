import { BfsError } from '../core/errors.js';
import { buildShardHeaderFromBytes, extractSidecarHeaderBytes, SHARD_HEADER_READ_BYTES, shardIntegrityFailure } from '../core/shard-io.js';
import { fmt, t } from '../i18n/index.js';
import { providerRegistry } from '../providers/provider.js';
import type { ManifestShard, ProviderIO, RemoteRef, ShardHeader, StorageProvider, VaultConfig, VersionManifest } from '../types/index.js';
import { VersionHealth } from '../types/index.js';
import { readConfig } from './config.js';
import { listManifests, readManifest, writeManifest } from './manifest.js';

// --- Report types -------------------------------------------------------------

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
  /**
   * true when this pass reported a verdict it could not observe itself: a
   * shallow run reading the header window, over a version whose payload rot was
   * found by an earlier deep run. Lets the caller tell the operator where the
   * verdict comes from and how to refresh it.
   */
  retained_from_deep: boolean;
}

export interface VerifyReport {
  versions: VersionStatus[];
}

/**
 * Options controlling verify depth.
 * `deep` streams each shard end-to-end and verifies its trailing SHA-256
 * (payload integrity), instead of inspecting only the header window.
 */
export interface VerifyOptions {
  deep?: boolean;
}

/** Sidecar-header presence for a single shard, as observed on a reachable provider. */
type SidecarState = 'valid' | 'missing' | 'broken' | 'n/a';

// --- Public API ---------------------------------------------------------------

/**
 * Verifies health of all manifest versions.
 * For each version, checks provider availability and shard existence.
 * Updates health in each manifest file.
 *
 * @param rootDir - Vault root directory
 * @param io      - ProviderIO for provider authentication
 * @param options - Verify options (deep = verify full payload, not just header)
 * @returns       Report with status for each version
 * @throws BfsError if config is missing
 */
export async function verifyAll(rootDir: string, io: ProviderIO, options?: VerifyOptions): Promise<VerifyReport> {
  const manifests = await listManifests(rootDir);
  const results: VersionStatus[] = [];
  for (const manifest of manifests) {
    const vs = await verifyVersion(rootDir, manifest.version, io, options);
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
 * @param options - Verify options (deep = verify full payload, not just header)
 * @returns       VersionStatus (health, available/total shards)
 * @throws BfsError if config or manifest is missing
 */
export async function verifyVersion(rootDir: string, version: number, io: ProviderIO, options?: VerifyOptions): Promise<VersionStatus> {
  const config = await readConfig(rootDir);
  if (!config) throw new BfsError('No vault config found.');

  const manifest = await readManifest(rootDir, version);
  if (!manifest) throw new BfsError(`Manifest for version ${version} not found.`);

  const deep = options?.deep ?? false;
  const { data_shards: N, parity_shards: K } = manifest.scheme;
  const total = N + K;
  let available = 0;
  let payloadRot = 0;
  const sidecarCounts = { valid: 0, missing: 0, broken: 0 };

  for (const ms of manifest.shards) {
    const result = await inspectShard(ms, { config, manifest, io, deep });
    if (result.available) available++;
    if (result.payload_corrupt) payloadRot++;
    if (result.sidecar !== 'n/a') sidecarCounts[result.sidecar]++;
  }

  let health: VersionHealth;
  if (available < N) {
    health = VersionHealth.Damaged;
  } else if (available < total) {
    health = VersionHealth.Degraded;
  } else {
    health = VersionHealth.Healthy;
  }

  const settled = settleVerdict(manifest, health, { deep, payloadRot });
  health = settled.health;
  if (settled.changed) await writeManifest(rootDir, manifest);
  const retained_from_deep = settled.retained;

  const tolerance = available >= N ? available - N : 0;
  // Advisory only when a healthy sibling proves the version was relocated
  // (so every shard should carry a sidecar), yet some are missing or broken.
  const header_advisory: Nullable<HeaderAdvisory> = sidecarCounts.valid >= 1 && sidecarCounts.missing + sidecarCounts.broken >= 1 ? { missing: sidecarCounts.missing, broken: sidecarCounts.broken } : null;

  return { version, health, available_shards: available, total_shards: total, tolerance, header_advisory, retained_from_deep };
}

/** Orders health verdicts so they can be compared: healthy < degraded < damaged. */
function severity(health: VersionHealth): number {
  switch (health) {
    case VersionHealth.Damaged:
      return 2;
    case VersionHealth.Degraded:
      return 1;
    default:
      return 0;
  }
}

/**
 * Decides which verdict this pass reports, and stamps it onto the manifest with
 * its provenance.
 *
 * Only a deep pass reads payload bytes, so only a deep pass may put rot on record
 * or retire it: a shallow pass carries the existing record forward untouched,
 * whatever verdict it reached itself. Were it allowed to clear the record
 * whenever its own observation happened to match or exceed the stored one - a
 * medium offline for unrelated reasons is enough - the rot would stop counting
 * the moment that medium came back, without anything having re-read the data.
 *
 * While rot is on record, a shallow pass also may not report a better verdict
 * than the stored one: it is blind to the very damage that produced it.
 *
 * @param manifest - Manifest to stamp (mutated in place)
 * @param observed - Health this pass worked out from the media it could reach
 * @param ctx      - Whether this pass read payloads, and how many were corrupt
 * @returns the verdict to report, whether it was carried over from a deep pass,
 *          and whether the manifest needs writing back
 */
function settleVerdict(manifest: VersionManifest, observed: VersionHealth, ctx: { deep: boolean; payloadRot: number }): { health: VersionHealth; retained: boolean; changed: boolean } {
  const rotOnRecord = manifest.health_deep_rot === true;
  const deepRot = ctx.deep ? ctx.payloadRot > 0 : rotOnRecord;
  const retained = !ctx.deep && rotOnRecord && severity(observed) < severity(manifest.health);
  const health = retained ? manifest.health : observed;
  const changed = manifest.health !== health || manifest.health_deep_rot !== deepRot;

  manifest.health = health;
  manifest.health_deep_rot = deepRot;
  if (changed) manifest.health_checked_at = new Date().toISOString();

  return { health, retained, changed };
}

/** Loop-invariant context for checking one shard's integrity within a version. */
interface ShardCheckContext {
  config: VaultConfig;
  manifest: VersionManifest;
  io: ProviderIO;
  /** Deep mode: stream the full shard and verify its trailing SHA-256 payload checksum. */
  deep: boolean;
}

/** Per-shard outcome of one verify pass: availability plus what was observed alongside it. */
interface ShardInspection {
  available: boolean;
  sidecar: SidecarState;
  payload_corrupt: boolean;
}

/** The name a version's shard carries on every medium. */
function shardFilename(ms: ManifestShard, manifest: VersionManifest): string {
  return `shard_${ms.shard_index}.bfs.${manifest.version}`;
}

/** The failure text a report carries through, whatever the thrown value was. */
function failureReason(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Reaches one shard's medium and checks the shard on it, naming the cause of
 * every outcome that costs the version a part.
 *
 * A count alone cannot be acted on: "2/3" reads the same whether a medium is
 * switched off, its address is stale, or the part was deleted - and those call
 * for opposite moves (bring the medium back vs `bfs repair <name> "" --rebuild`,
 * which needs the name/params pair its parser insists on). So an
 * unreachable medium, a provider the configuration no longer knows and a medium
 * with no installed adapter are reported, not swallowed, exactly as the per-file
 * failures below already are.
 *
 * An unreachable medium is never reported as damage: nothing was read, so the
 * bytes are not accused. The distinction matters because a momentary read error
 * would otherwise condemn a healthy medium.
 *
 * @param ms  - Manifest entry of the shard to inspect
 * @param ctx - Config, manifest, IO and depth for this pass
 * @returns availability, sidecar state and whether the payload was found rotten
 */
async function inspectShard(ms: ManifestShard, ctx: ShardCheckContext): Promise<ShardInspection> {
  const { config, io } = ctx;
  const filename = shardFilename(ms, ctx.manifest);
  const unavailable: ShardInspection = { available: false, sidecar: 'n/a', payload_corrupt: false };

  const pc = config.providers.find((p) => p.id === ms.provider_id);
  if (!pc) {
    io.warn(fmt('verify_shard_provider_unknown', filename, ms.provider_id));
    return unavailable;
  }

  let provider: StorageProvider;
  try {
    provider = providerRegistry.create(pc, io);
  } catch (err) {
    // Nothing was contacted: BFS has no adapter to speak this medium's protocol.
    // Reporting that as "unreachable" would send the operator to check a cable
    // instead of installing the adapter.
    io.warn(fmt('verify_shard_adapter_missing', filename, ms.provider_id, failureReason(err)));
    return unavailable;
  }

  try {
    if (!(await provider.healthCheck())) {
      io.warn(fmt('verify_shard_medium_unreachable', filename, ms.provider_id, t('verify_reason_health_check')));
      return unavailable;
    }
    await provider.authenticate();
    provider.setVaultName(config.vault_name);
    return await checkShardIntegrity(provider, ms, ctx);
  } catch (err) {
    io.warn(fmt('verify_shard_medium_unreachable', filename, ms.provider_id, failureReason(err)));
    return unavailable;
  }
}

/**
 * Verifies that a single shard exists, has a non-zero size, and carries an
 * in-shard header consistent with the manifest, and observes the state of its
 * location-header sidecar. In shallow mode pulls only the header window
 * (~16 KB). In deep mode (`ctx.deep`) additionally streams the whole shard and
 * verifies its trailing SHA-256, catching payload bit-rot the header check
 * cannot see - at the cost of transferring the full shard.
 *
 * Availability is read from the IN-SHARD header, so it is independent of the
 * sidecar: a broken or missing sidecar never marks the shard unavailable.
 *
 * Failure modes (reported via io.warn, `available: false`):
 *   - getSize fails or returns 0   -> shard missing
 *   - downloadHeader / parse fails -> header truncated or corrupt
 *   - vault_id / version / shard_index / blob_hash / scheme mismatch -> wrong shard
 *   - deep: trailing SHA-256 mismatch -> payload corrupted (bit-rot / truncation)
 *
 * @returns availability plus the observed sidecar state
 */
async function checkShardIntegrity(provider: StorageProvider, ms: ManifestShard, ctx: ShardCheckContext): Promise<ShardInspection> {
  const { config, manifest, io, deep } = ctx;
  const filename = shardFilename(ms, manifest);
  const ref = { provider_id: provider.id, path: filename };

  let size: number;
  try {
    size = await provider.getSize(ref);
  } catch (err) {
    // The medium answered but the file did not come back: deleted, renamed, or
    // unreadable. The provider's own reason is carried through, so a deleted
    // part is not reported the same way as a permission or transport failure.
    io.warn(fmt('verify_shard_unreadable', filename, provider.id, failureReason(err)));
    return { available: false, sidecar: 'n/a', payload_corrupt: false };
  }
  if (size === 0) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, 'size=0'));
    return { available: false, sidecar: 'n/a', payload_corrupt: false };
  }

  const sidecar = await probeSidecarState(provider, ref);

  let header: ShardHeader;
  try {
    header = buildShardHeaderFromBytes(await provider.downloadHeader(ref, SHARD_HEADER_READ_BYTES));
  } catch (err) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, err instanceof Error ? err.message : String(err)));
    return { available: false, sidecar, payload_corrupt: false };
  }

  const mismatches = headerMismatches(header, config, manifest, ms);
  if (mismatches.length > 0) {
    io.warn(fmt('verify_shard_check_failed', filename, provider.id, `header mismatch: ${mismatches.join(', ')}`));
    return { available: false, sidecar, payload_corrupt: false };
  }
  if (deep) {
    const corruptReason = await shardIntegrityFailure(provider, ref);
    if (corruptReason !== null) {
      io.warn(fmt('verify_shard_check_failed', filename, provider.id, corruptReason));
      return { available: false, sidecar, payload_corrupt: true };
    }
  }
  return { available: true, sidecar, payload_corrupt: false };
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
 * or the sidecar probe itself failed). Password-free - validates the envelope
 * (magic + checksum) without decrypting the location map.
 */
async function probeSidecarState(provider: StorageProvider, ref: RemoteRef): Promise<SidecarState> {
  if (!provider.usesSidecar()) return 'n/a';

  let sidecar: Nullable<Buffer>;
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
