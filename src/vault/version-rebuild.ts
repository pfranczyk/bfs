import { Readable } from 'node:stream';
import { parseShardHeaderFromStream, readShardHeaderBytes, SHARD_HEADER_READ_BYTES } from '../core/shard-io.js';
import { fmt } from '../i18n/index.js';
import type { ManifestShard, ProviderIO, ShardHeader, ShardLocation, StorageProvider, VersionManifest } from '../types/index.js';
import { VersionHealth } from '../types/index.js';
import { parseVersionFromFilename } from './bootstrap.js';
import { shardHeaderConsensusMismatch } from './consensus.js';
import { promptForVaultPassword, tryPooledPasswords } from './password-pool.js';

// --- Rebuilding one version's manifest from the parts on the storage ---------
//
// A version's location map lives in every one of its shard headers, sealed under
// the key that version was pushed with. Rebuilding its manifest therefore needs
// nothing but the parts themselves and the password: read a header, open the map,
// and the manifest follows. Two callers need exactly that - `bfs recovery`, which
// walks every version it finds, and `bfs pull`, which rebuilds the single version
// the operator asked for.

/**
 * What one version yielded when its manifest was rebuilt from the storage.
 *
 * `map_unopened` is set apart from `unusable` because only it says the version is
 * ours and merely locked: its shards carry our vault_id, their headers parsed,
 * and the sole thing missing is the password sealing the location map. That is
 * the one case worth recording for the operator - a version belonging to another
 * backup, or one whose headers could not be read at all, promises nothing.
 */
export type VersionRebuildResult = { outcome: 'recovered'; manifest: VersionManifest; consensusOk: boolean } | { outcome: 'map_unopened' } | { outcome: 'unusable' };

/** One part of the version being rebuilt, and the medium serving it. */
export interface VersionShardEntry {
  readonly shardIndex: number;
  readonly provider: StorageProvider;
}

/**
 * Which command's vocabulary the operator hears while a version is rebuilt.
 *
 * `recovery` walks every version it finds, so one it cannot open is skipped and
 * says so, and a blank password moves on to the next. `pull` was told to fetch
 * one named version: nothing is skipped, a blank password ends the command, and
 * the caller has a refusal of its own to deliver - so this path stays quiet and
 * lets it speak.
 */
export type VersionRebuildCaller = 'recovery' | 'pull';

/** Everything the rebuild needs beyond the parts themselves. */
export interface VersionRebuildContext {
  readonly vaultName: string;
  /** Identity every accepted shard must carry - a foreign one is never a source. */
  readonly vaultId: string;
  /** Candidate passwords, newest first; a password accepted here is appended. */
  readonly passwordPool: string[];
  readonly caller: VersionRebuildCaller;
  readonly io: ProviderIO;
}

/**
 * Rebuilds one version's manifest from the parts on the storage: collects the
 * headers of its distinct shards, resolves the location map from the first shard
 * that yields it (falling back past a damaged primary to a healthy sibling), runs
 * consensus, and builds the manifest from the shard the map actually came from.
 *
 * Nothing is written - the caller decides whether the version is worth recording,
 * and when.
 *
 * @param version - Version number being rebuilt
 * @param entries - Its parts, and the medium serving each
 * @param ctx     - Vault identity, candidate passwords, and the operator channel
 * @returns the rebuilt manifest, or why this version could not be rebuilt
 */
export async function rebuildVersionManifest(version: number, entries: readonly VersionShardEntry[], ctx: VersionRebuildContext): Promise<VersionRebuildResult> {
  const { vaultName, vaultId, passwordPool, caller, io } = ctx;

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
      // Unreadable header (truncated/corrupt) - treat this medium as absent.
    }
  }
  if (collected.length === 0) return { outcome: 'unusable' };

  // Resolve which shard supplies the location map. Walk candidates in order: skip
  // any whose vault_id is foreign (the guard follows the map's source shard, not
  // the first listed entry), then open the map - pooled passwords for encrypted
  // shards (no prompt yet), the parsed plaintext map for --no-enc. The first
  // candidate that clears both becomes the source. Per-version salt is shared, so
  // memoize derived keys across candidates to keep Argon2id to one pass per pool
  // password.
  const keyCache = new Map<string, Buffer>();
  let source: Nullable<{ header: ShardHeader; shardIndex: number; location_map: ShardLocation[] }> = null;
  const failedProviderIds: string[] = [];
  let sawEncryptedCandidate = false;

  for (const c of collected) {
    if (c.header.vault_id !== vaultId) continue; // foreign shard - keep looking
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
  // Warn and prompt ONCE per version - on the first encrypted candidate with a
  // matching vault_id - never once per candidate shard.
  if (!source && sawEncryptedCandidate) {
    const promptTarget = collected.find((c) => c.header.vault_id === vaultId && c.header.encrypted);
    if (promptTarget) {
      if (passwordPool.length > 0) io.warn(fmt('recovery_pool_password_failed', String(version)));
      const resolved = await promptForVaultPassword(
        promptTarget.header,
        promptTarget.headerBytes,
        passwordPool,
        io,
        {
          poolExhausted: fmt('recovery_pool_password_failed', String(version)),
          // "Leave blank to skip" is true only where a blank answer moves on to
          // the next version. In `pull` it ends the command, so it is not said.
          ask: fmt(caller === 'pull' ? 'pull_ask_version_password' : 'recovery_ask_version_password', String(version)),
          retry: fmt('recovery_wrong_password_retry', String(version)),
        },
        keyCache,
      );
      if (resolved) source = { header: promptTarget.header, shardIndex: promptTarget.shardIndex, location_map: resolved.location_map };
    }
  }

  if (!source) {
    // Recovery moves on to the next version and says so. `pull` has one version
    // to deliver and a refusal of its own naming the real cause - a "skipped"
    // line ahead of it would describe a different outcome than the one that
    // follows a moment later.
    if (caller === 'recovery') io.warn(fmt('recovery_decrypt_skip', String(version)));
    // A candidate of OUR backup whose map stayed sealed is the one case where the
    // version is known to be ours and waiting on a password. Without such a
    // candidate the loop found only shards of another backup, and nothing here
    // says this version is the operator's to come back for.
    return { outcome: sawEncryptedCandidate ? 'map_unopened' : 'unusable' };
  }
  const src = source;
  const sourceMeta = src.header;

  if (sourceMeta.vault_id !== vaultId) {
    io.warn(fmt('recovery_consensus_vault_id_mismatch', String(version)));
    return { outcome: 'unusable' };
  }

  // Filename cross-check keyed on the shard the header actually came from - not
  // the first listed entry, which may have dropped out of the candidates.
  const parsedFilename = parseVersionFromFilename(`shard_${src.shardIndex}.bfs.${version}`);
  if (!parsedFilename || parsedFilename.shardIndex !== sourceMeta.shard_index || parsedFilename.version !== sourceMeta.version) {
    io.warn(fmt('recovery_consensus_filename_mismatch', String(version)));
    return { outcome: 'unusable' };
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
  return { outcome: 'recovered', manifest, consensusOk };
}
