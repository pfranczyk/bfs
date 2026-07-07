import { beforeAll, describe, expect, it } from 'vitest';
import { deriveKey, generateSalt } from '../../src/core/crypto.js';
import { buildShard } from '../../src/core/shard-io.js';
import { createMockProviderIO } from '../../src/providers/provider.js';
import type { ShardHeader, ShardLocation } from '../../src/types/index.js';
import { tryDecryptLocationMap } from '../../src/vault/password-pool.js';

const LOCATIONS: ShardLocation[] = [
  { shard_index: 0, provider_id: 'local-1', provider_type: 'local', adapterPackage: null, connection_config: { path: '/mnt/backup' }, required_inputs: [], remote_path: '/mnt/backup/v/shard_0.bfs.1', shard_hash: 'a'.repeat(64) },
];

function makeHeader(overrides: Partial<ShardHeader> = {}): ShardHeader {
  return {
    magic: 'BFSS',
    format_version: 1,
    vault_id: '550e8400-e29b-41d4-a716-446655440000',
    vault_name: 'v',
    blob_size: 1024n,
    blob_hash: 'b'.repeat(64),
    data_shards: 2,
    parity_shards: 1,
    shard_index: 0,
    version: 1,
    encrypted: false,
    kdf_salt: null,
    rs_stripe_size: 64 * 1024 * 1024,
    map_length: 0,
    location_map: LOCATIONS,
    ...overrides,
  };
}

const PROMPTS = { poolExhausted: 'no pooled password worked', ask: 'enter password', retry: 'wrong password, retry' };

describe('tryDecryptLocationMap', () => {
  let salt: Buffer;
  let correctKey: Buffer;
  let header: ShardHeader;
  let headerBytes: Buffer;

  beforeAll(async () => {
    salt = generateSalt();
    correctKey = await deriveKey('correct', salt);
    header = makeHeader({ encrypted: true, kdf_salt: salt });
    headerBytes = buildShard(header, Buffer.from('payload'), correctKey);
  });

  it('should return null for an unencrypted shard', async () => {
    const { io } = createMockProviderIO();

    const result = await tryDecryptLocationMap(makeHeader({ encrypted: false }), headerBytes, [], io, PROMPTS);

    expect(result).toBeNull();
  });

  it('should decrypt using a pooled password', async () => {
    const { io } = createMockProviderIO();

    const result = await tryDecryptLocationMap(header, headerBytes, ['correct'], io, PROMPTS);

    expect(result).not.toBeNull();
    expect(result?.location_map[0]?.provider_id).toBe('local-1');
    expect(result?.encKey.equals(correctKey)).toBe(true);
  });

  it('should try pooled passwords most-recently-added first', async () => {
    const { io } = createMockProviderIO();

    // MRU order: 'correct' was added last, so it is tried before 'wrong'.
    const result = await tryDecryptLocationMap(header, headerBytes, ['wrong', 'correct'], io, PROMPTS);

    expect(result?.encKey.equals(correctKey)).toBe(true);
  });

  it('should fall through a wrong pooled password to a correct one', async () => {
    const { io } = createMockProviderIO();

    const result = await tryDecryptLocationMap(header, headerBytes, ['correct', 'wrong'], io, PROMPTS);

    expect(result?.encKey.equals(correctKey)).toBe(true);
  });

  it('should prompt when the pool is exhausted and append the working password', async () => {
    const { io, logs } = createMockProviderIO({ [PROMPTS.ask]: 'correct' });
    const pool = ['wrong'];

    const result = await tryDecryptLocationMap(header, headerBytes, pool, io, PROMPTS);

    expect(result?.encKey.equals(correctKey)).toBe(true);
    expect(pool).toContain('correct');
    expect(logs.some((l) => l.level === 'warn' && l.message === PROMPTS.poolExhausted)).toBe(true);
  });

  it('should not warn about an exhausted pool when the pool started empty', async () => {
    const { io, logs } = createMockProviderIO({ [PROMPTS.ask]: 'correct' });

    const result = await tryDecryptLocationMap(header, headerBytes, [], io, PROMPTS);

    expect(result?.encKey.equals(correctKey)).toBe(true);
    expect(logs.some((l) => l.message === PROMPTS.poolExhausted)).toBe(false);
  });

  it('should return null when the operator gives up at the prompt', async () => {
    // First manual attempt (ask) is wrong; the retry answer is blank → give up.
    const { io } = createMockProviderIO({ [PROMPTS.ask]: 'still-wrong', [PROMPTS.retry]: '' });

    const result = await tryDecryptLocationMap(header, headerBytes, ['wrong'], io, PROMPTS);

    expect(result).toBeNull();
  });
});
