import type { ShardLocation } from '../types/index.js';
import { divergentShardIndices } from './location-map.js';

/**
 * Shard-header fields whose divergence between two sibling shards of the same
 * version signals tampering or corruption. Values come straight from a parsed
 * `ShardHeader` (or, for the bootstrap reference, the header meta plus its
 * separately-parsed location map). A full `ShardHeader` is structurally
 * assignable, so callers may pass one directly.
 */
export interface ConsensusFields {
  readonly vault_id: string;
  readonly blob_hash: string;
  readonly version: number;
  readonly data_shards: number;
  readonly parity_shards: number;
  readonly encrypted: boolean;
  readonly rs_stripe_size: Nullable<number>;
  readonly location_map: ShardLocation[];
}

/**
 * Compares two sibling shard headers and returns the names of the fields that
 * diverge (empty array = full agreement). `rs_stripe_size` is included because
 * two shards of one version must share the same striping — a difference means
 * they were not produced together. `location_map` is compared only for
 * unencrypted vaults: encrypted maps are MAC-protected, so tampering is caught
 * at decrypt. The caller decides whether a non-empty result is a hard error
 * (bootstrap) or a soft flag (recovery/repair).
 *
 * @param reference the shard treated as the source of truth
 * @param candidate the sibling shard being checked against it
 * @returns diverging field names, in a stable order
 */
export function shardHeaderConsensusMismatch(reference: ConsensusFields, candidate: ConsensusFields): string[] {
  const mismatch: string[] = [];
  if (candidate.vault_id !== reference.vault_id) mismatch.push('vault_id');
  if (candidate.blob_hash !== reference.blob_hash) mismatch.push('blob_hash');
  if (candidate.version !== reference.version) mismatch.push('version');
  if (candidate.data_shards !== reference.data_shards) mismatch.push('data_shards');
  if (candidate.parity_shards !== reference.parity_shards) mismatch.push('parity_shards');
  if (candidate.encrypted !== reference.encrypted) mismatch.push('encrypted');
  if ((candidate.rs_stripe_size ?? null) !== (reference.rs_stripe_size ?? null)) mismatch.push('rs_stripe_size');
  if (!reference.encrypted && divergentShardIndices(reference.location_map, candidate.location_map).length > 0) {
    mismatch.push('location_map');
  }
  return mismatch;
}
