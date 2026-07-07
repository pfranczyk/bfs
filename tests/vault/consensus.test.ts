import { describe, expect, it } from 'vitest';
import type { ShardLocation } from '../../src/types/index.js';
import { type ConsensusFields, shardHeaderConsensusMismatch } from '../../src/vault/consensus.js';

function loc(shard_index: number, remote_path: string): ShardLocation {
  return { shard_index, provider_id: `p${shard_index}`, provider_type: 'local', adapterPackage: null, connection_config: { path: '/base' }, required_inputs: null, remote_path, shard_hash: 'deadbeef' };
}

function base(overrides: Partial<ConsensusFields> = {}): ConsensusFields {
  return { vault_id: 'vault-1', blob_hash: 'hash-1', version: 3, data_shards: 2, parity_shards: 1, encrypted: false, rs_stripe_size: 268435456, location_map: [], ...overrides };
}

describe('shardHeaderConsensusMismatch', () => {
  it('should return an empty array when headers agree', () => {
    expect(shardHeaderConsensusMismatch(base(), base())).toEqual([]);
  });

  it('should flag a vault_id divergence', () => {
    expect(shardHeaderConsensusMismatch(base(), base({ vault_id: 'other' }))).toEqual(['vault_id']);
  });

  it('should flag a blob_hash divergence', () => {
    expect(shardHeaderConsensusMismatch(base(), base({ blob_hash: 'other' }))).toEqual(['blob_hash']);
  });

  it('should flag an encrypted-flag divergence', () => {
    expect(shardHeaderConsensusMismatch(base(), base({ encrypted: true }))).toEqual(['encrypted']);
  });

  it('should flag an rs_stripe_size divergence (V2 striping consistency)', () => {
    expect(shardHeaderConsensusMismatch(base(), base({ rs_stripe_size: 134217728 }))).toEqual(['rs_stripe_size']);
  });

  it('should treat two V1 shards (null stripe size) as agreeing', () => {
    expect(shardHeaderConsensusMismatch(base({ rs_stripe_size: null }), base({ rs_stripe_size: null }))).toEqual([]);
  });

  it('should flag a null vs numeric stripe size (V1/V2 mix)', () => {
    expect(shardHeaderConsensusMismatch(base({ rs_stripe_size: null }), base({ rs_stripe_size: 268435456 }))).toEqual(['rs_stripe_size']);
  });

  it('should flag every diverging field at once', () => {
    const mismatch = shardHeaderConsensusMismatch(base(), base({ vault_id: 'x', version: 9, data_shards: 3, parity_shards: 2 }));

    expect(mismatch).toContain('vault_id');
    expect(mismatch).toContain('version');
    expect(mismatch).toContain('data_shards');
    expect(mismatch).toContain('parity_shards');
  });

  it('should flag a location_map divergence for an unencrypted vault', () => {
    const a = base({ location_map: [loc(0, '/base/vault/shard_0.bfs.3')] });
    const b = base({ location_map: [loc(0, '/elsewhere/shard_0.bfs.3')] });

    expect(shardHeaderConsensusMismatch(a, b)).toEqual(['location_map']);
  });

  it('should ignore a location_map divergence when the vault is encrypted', () => {
    const a = base({ encrypted: true, location_map: [loc(0, '/base/vault/shard_0.bfs.3')] });
    const b = base({ encrypted: true, location_map: [loc(0, '/elsewhere/shard_0.bfs.3')] });

    expect(shardHeaderConsensusMismatch(a, b)).toEqual([]);
  });
});
