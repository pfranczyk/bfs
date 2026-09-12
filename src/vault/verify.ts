import { BfsError, ShardCorruptedError } from '../core/errors.js';
import { buildShardHeaderFromBytes, extractSidecarHeaderBytes, placementMismatches, SHARD_HEADER_READ_BYTES, shardIntegrityFailure } from '../core/shard-io.js';
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

/**
 * Why a part did not count towards its version.
 *
 * The distinction is the whole point: a bare count reads identically for a
 * medium that is switched off, a part that was deleted and data that rotted, and
 * those call for opposite moves. The causes are ordered by how far the exchange
 * got, so nothing accuses bytes that were never read - `medium_unreachable` and
 * `read_failed` say only that BFS did not get to look, while `data_corrupt`
 * means it looked and the bytes contradict themselves.
 */
export type ShardLossCause = 'provider_not_configured' | 'adapter_missing' | 'medium_unreachable' | 'file_missing' | 'read_failed' | 'header_mismatch' | 'data_corrupt';

/** One cause of loss for a version, with the media it hit under the names the backup records. */
export interface VersionLoss {
  cause: ShardLossCause;
  providers: string[];
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
   * Why this version is short of parts, grouped so each cause names its media
   * once. Empty when nothing was lost.
   *
   * Carried as data rather than written out here: a line per part, emitted from
   * inside the loop, arrives once per medium in the middle of whatever progress
   * display the caller is running, and cannot name the version it belongs to -
   * `verifyAll` walks every manifest, so a long history buries the table it is
   * meant to explain.
   */
  loss_causes: VersionLoss[];
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
  const losses = new Map<number, ShardLossCause>();

  for (const ms of manifest.shards) {
    const result = await inspectShard(ms, { config, manifest, io, deep });
    if (result.available) available++;
    if (result.payload_corrupt) payloadRot++;
    if (result.sidecar !== 'n/a') sidecarCounts[result.sidecar]++;
    if (result.loss !== null) losses.set(ms.shard_index, result.loss);
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

  return { version, health, available_shards: available, total_shards: total, tolerance, header_advisory, retained_from_deep, loss_causes: groupLosses(manifest, losses) };
}

/**
 * The order causes are reported in, matching the one a failed restore uses
 * (`_describeShardFailures` in vault-manager), so the same two faults never come
 * out in opposite orders depending on which command found them. Fixed rather than
 * derived from the shards, or the same backup would read differently from one run
 * to the next as slots fail in a different sequence.
 */
const LOSS_CAUSE_ORDER: readonly ShardLossCause[] = ['data_corrupt', 'file_missing', 'medium_unreachable', 'adapter_missing', 'provider_not_configured', 'read_failed', 'header_mismatch'];

/**
 * Groups the media that lost a part by the cause, under the names the backup
 * records for them.
 *
 * @param manifest - Version manifest, to map shard indexes to medium names
 * @param losses   - Shard index -> why that part did not count
 * @returns one entry per cause that occurred, in {@link LOSS_CAUSE_ORDER}
 */
function groupLosses(manifest: VersionManifest, losses: Map<number, ShardLossCause>): VersionLoss[] {
  const grouped: VersionLoss[] = [];
  for (const cause of LOSS_CAUSE_ORDER) {
    const providers = [...losses.entries()]
      .filter(([, c]) => c === cause)
      .map(([index]) => manifest.shards.find((s) => s.shard_index === index)?.provider_id)
      .filter((id): id is string => id !== undefined);
    if (providers.length > 0) grouped.push({ cause, providers });
  }
  return grouped;
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
  /** Why this part did not count, or null when it did. */
  loss: Nullable<ShardLossCause>;
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
 * Whether a thrown value is the parser refusing bytes it read, as opposed to a
 * read that never delivered them.
 *
 * The constructor name stands in beside `instanceof` because an adapter shipped
 * outside this bundle throws from its own copy of the class: two copies of the
 * same error type do not share identity, so `instanceof` alone silently misses
 * every corruption an external adapter reports. Getting this wrong in either
 * direction misnames the fault: a dropped session reported as damage sends the
 * operator to rebuild sound data, and damage reported as a dropped session tells
 * them to try again forever.
 */
function isShardCorruption(err: unknown): boolean {
  return err instanceof ShardCorruptedError || (err instanceof Error && err.constructor.name === 'ShardCorruptedError');
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
 * with no installed adapter each carry their own cause, exactly as the per-file
 * failures below do.
 *
 * An unreachable medium is never reported as damage: nothing was read, so the
 * bytes are not accused. The distinction matters because a momentary read error
 * would otherwise condemn a healthy medium.
 *
 * The cause is returned, never written out: the caller groups the media per
 * cause and says it once. What the medium itself said goes to the debug channel,
 * where it stays available for a diagnosis without crowding the report.
 *
 * @param ms  - Manifest entry of the shard to inspect
 * @param ctx - Config, manifest, IO and depth for this pass
 * @returns availability, sidecar state, whether the payload was found rotten,
 *          and the cause when the part did not count
 */
async function inspectShard(ms: ManifestShard, ctx: ShardCheckContext): Promise<ShardInspection> {
  const { config, io } = ctx;
  const filename = shardFilename(ms, ctx.manifest);
  const lost = (cause: ShardLossCause): ShardInspection => ({ available: false, sidecar: 'n/a', payload_corrupt: false, loss: cause });

  const pc = config.providers.find((p) => p.id === ms.provider_id);
  if (!pc) {
    io.debug(`verify: ${filename} on "${ms.provider_id}" - the configuration no longer knows this provider`);
    return lost('provider_not_configured');
  }

  let provider: StorageProvider;
  try {
    provider = providerRegistry.create(pc, io);
  } catch (err) {
    // Nothing was contacted: BFS has no adapter to speak this medium's protocol.
    // Reporting that as "unreachable" would send the operator to check a cable
    // instead of installing the adapter.
    io.debug(`verify: ${filename} on "${ms.provider_id}" - no adapter installed: ${failureReason(err)}`);
    return lost('adapter_missing');
  }

  try {
    if (!(await provider.healthCheck())) {
      io.debug(`verify: ${filename} on "${ms.provider_id}" - no answer to the reachability check`);
      return lost('medium_unreachable');
    }
    await provider.authenticate();
    provider.setVaultName(config.vault_name);
    return await checkShardIntegrity(provider, ms, ctx);
  } catch (err) {
    // Reaching the medium is what failed - the reachability check, the login, or
    // the connection behind either. Classified by how far the exchange got, not
    // by what was thrown: a refused login raises the same error class as a
    // transfer that dies later, and calling this one a failed transfer would
    // describe a medium BFS never got to read from.
    io.debug(`verify: ${filename} on "${ms.provider_id}" - medium unreachable: ${failureReason(err)}`);
    return lost('medium_unreachable');
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
 * Failure modes (`available: false`, each with its own cause):
 *   - getSize fails or returns 0   -> `file_missing`
 *   - downloadHeader fails to deliver -> `read_failed`
 *   - the delivered header does not parse -> `data_corrupt`
 *   - vault_id / version / shard_index / blob_hash / scheme mismatch -> `header_mismatch`
 *   - deep: the payload read breaks -> `read_failed`
 *   - deep: trailing SHA-256 mismatch -> `data_corrupt` (bit-rot / truncation)
 *
 * `header_mismatch` covers one field more than the restore paths judge identity
 * by: `blob_hash` describes content rather than address and has a legal window of
 * disagreement (an interrupted `push --overwrite` leaves this version's own newer
 * part beside a manifest describing the older content). Both belong in the report
 * - the part cannot be counted either way - so the cause says the header
 * disagrees, and never whose part it is.
 *
 * @returns availability, the observed sidecar state and the cause of any loss
 */
async function checkShardIntegrity(provider: StorageProvider, ms: ManifestShard, ctx: ShardCheckContext): Promise<ShardInspection> {
  const { config, manifest, io, deep } = ctx;
  const filename = shardFilename(ms, manifest);
  const ref = { provider_id: provider.id, path: filename };

  if (!(await partIsPresent(provider, ref, filename, io))) {
    return { available: false, sidecar: 'n/a', payload_corrupt: false, loss: 'file_missing' };
  }

  const sidecar = await probeSidecarState(provider, ref);

  let header: ShardHeader;
  try {
    header = buildShardHeaderFromBytes(await provider.downloadHeader(ref, SHARD_HEADER_READ_BYTES));
  } catch (err) {
    // Two failures meet at this one call and want opposite moves: bytes that
    // arrived and contradict themselves (repair the part) against a transfer
    // that never delivered them (try again, look at the link). Anything the
    // parser did not refuse is read as the latter - the conservative side, since
    // nothing was established about the bytes.
    const corrupted = isShardCorruption(err);
    io.debug(`verify: ${filename} on "${provider.id}" - ${corrupted ? 'header damaged' : 'header read failed'}: ${failureReason(err)}`);
    return { available: false, sidecar, payload_corrupt: false, loss: corrupted ? 'data_corrupt' : 'read_failed' };
  }

  const mismatches = headerMismatches(header, config, manifest, ms);
  if (mismatches.length > 0) {
    io.debug(`verify: ${filename} on "${provider.id}" - header mismatch: ${mismatches.join(', ')}`);
    return { available: false, sidecar, payload_corrupt: false, loss: 'header_mismatch' };
  }
  if (deep) return await checkPayloadIntegrity(provider, ref, filename, sidecar, io);
  return { available: true, sidecar, payload_corrupt: false, loss: null };
}

/**
 * Whether the part is on the medium at all, asked with a metadata call rather
 * than a transfer.
 *
 * A size of zero counts as absent: the name is taken but nothing is behind it,
 * which is what an interrupted upload leaves. Either way the medium answered -
 * the file is what did not come back - so the reason it gave is kept on the
 * debug channel, where a deleted part can still be told from a refused
 * permission without an adapter's error text reaching everyone.
 *
 * @param provider - Provider holding the shard, already authenticated
 * @param ref      - RemoteRef of the shard
 * @param filename - The part's name, for the debug line
 * @param io       - ProviderIO the medium's own reason is written to
 * @returns true when a non-empty file answered
 */
async function partIsPresent(provider: StorageProvider, ref: RemoteRef, filename: string, io: ProviderIO): Promise<boolean> {
  try {
    const size = await provider.getSize(ref);
    if (size > 0) return true;
    io.debug(`verify: ${filename} on "${provider.id}" - part missing or unreadable: size=0`);
    return false;
  } catch (err) {
    io.debug(`verify: ${filename} on "${provider.id}" - part missing or unreadable: ${failureReason(err)}`);
    return false;
  }
}

/**
 * Streams the whole part and settles its trailing SHA-256, for a deep pass.
 *
 * Only a failed checksum condemns the bytes; {@link shardIntegrityFailure}
 * rethrows everything else for this decision. The medium answered its
 * reachability check and handed over its header moments ago, so a transfer
 * breaking now says nothing about the bytes - and the part is demonstrably still
 * on it, which is why a broken read is never reported as a missing part.
 *
 * @param provider - Provider holding the shard, already authenticated
 * @param ref      - RemoteRef of the shard
 * @param filename - The part's name, for the debug line
 * @param sidecar  - Sidecar state observed before the payload was read
 * @param io       - ProviderIO the medium's own reason is written to
 * @returns the inspection for this part: sound, damaged, or unread
 */
async function checkPayloadIntegrity(provider: StorageProvider, ref: RemoteRef, filename: string, sidecar: SidecarState, io: ProviderIO): Promise<ShardInspection> {
  let corruptReason: Nullable<string>;
  try {
    corruptReason = await shardIntegrityFailure(provider, ref);
  } catch (err) {
    // An adapter outside this bundle may raise the parser's refusal from here
    // rather than returning it, and that one IS about the bytes.
    const corrupted = isShardCorruption(err);
    io.debug(`verify: ${filename} on "${provider.id}" - ${corrupted ? 'payload damaged' : 'payload read failed'}: ${failureReason(err)}`);
    return { available: false, sidecar, payload_corrupt: corrupted, loss: corrupted ? 'data_corrupt' : 'read_failed' };
  }
  if (corruptReason !== null) {
    io.debug(`verify: ${filename} on "${provider.id}" - payload damaged: ${corruptReason}`);
    return { available: false, sidecar, payload_corrupt: true, loss: 'data_corrupt' };
  }
  return { available: true, sidecar, payload_corrupt: false, loss: null };
}

/**
 * Collects the manifest/config fields the in-shard header disagrees with.
 *
 * The five placement fields come from the same comparison the restore paths use,
 * so a part cannot be judged as belonging here by one command and not by the
 * other. The content hash is verify's alone: it reads headers without decoding
 * anything, so this is its only chance to notice that a part describes content
 * other than the manifest's - a restore instead checks the content itself, after
 * the decode.
 */
function headerMismatches(header: ShardHeader, config: VaultConfig, manifest: VersionManifest, ms: ManifestShard): string[] {
  const mismatches = placementMismatches(header, { vault_id: config.vault_id, version: manifest.version, shard_index: ms.shard_index, data_shards: manifest.scheme.data_shards, parity_shards: manifest.scheme.parity_shards });
  if (header.blob_hash !== manifest.blob_hash) mismatches.push('blob_hash');
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
