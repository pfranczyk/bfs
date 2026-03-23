import { describe, expect, it } from 'vitest';
import { BfsError } from '../../src/core/errors.js';
import {
  calcShardPayloadSize,
  rsDecode,
  rsEncode,
  rsRepair,
  SHARD_ALIGNMENT,
} from '../../src/core/reed-solomon.js';

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Generates a Buffer of `size` bytes with non-zero, non-repeating pattern. */
function makeData(size: number): Buffer {
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = (i * 37 + 13) % 251;
  return buf;
}

/** Drops shard slots by index, replacing them with null. */
function dropShards(shards: Buffer[], indices: number[]): (Buffer | null)[] {
  return shards.map((s, i) => (indices.includes(i) ? null : s));
}

// ─── Tests ─────────────────────────────────────────────────────────────────

describe('SHARD_ALIGNMENT', () => {
  it('should be a positive integer', () => {
    expect(SHARD_ALIGNMENT).toBeGreaterThan(0);
    expect(Number.isInteger(SHARD_ALIGNMENT)).toBe(true);
  });
});

describe('calcShardPayloadSize', () => {
  it('should return a multiple of SHARD_ALIGNMENT', () => {
    const sizes = [1, 7, 8, 9, 100, 1000, 1024 * 1024];
    for (const size of sizes) {
      const result = calcShardPayloadSize(size, 3);
      expect(result % SHARD_ALIGNMENT).toBe(0);
    }
  });

  it('should be >= ceil(dataLen / dataShards)', () => {
    const dataLen = 100;
    const dataShards = 3;
    const min = Math.ceil(dataLen / dataShards);
    expect(calcShardPayloadSize(dataLen, dataShards)).toBeGreaterThanOrEqual(
      min,
    );
  });
});

describe('rsEncode', () => {
  it('should return N+K shards for 3/1 config', () => {
    const data = makeData(100);
    const shards = rsEncode(data, 3, 1);
    expect(shards).toHaveLength(4);
    for (const s of shards) expect(s).toBeInstanceOf(Buffer);
  });

  it('should return N+K shards for 5/2 config', () => {
    const data = makeData(500);
    const shards = rsEncode(data, 5, 2);
    expect(shards).toHaveLength(7);
  });

  it('should produce shards of equal size', () => {
    const shards = rsEncode(makeData(200), 4, 2);
    const firstShard = shards[0];
    expect(firstShard).toBeDefined();
    const size = firstShard?.length;
    for (const s of shards) expect(s.length).toBe(size);
  });

  it('should throw BfsError when dataShards < 2', () => {
    expect(() => rsEncode(makeData(10), 1, 1)).toThrow(BfsError);
  });

  it('should throw BfsError when parityShards < 1', () => {
    expect(() => rsEncode(makeData(10), 3, 0)).toThrow(BfsError);
  });

  it('should throw BfsError when N+K > 256', () => {
    expect(() => rsEncode(makeData(10), 200, 57)).toThrow(BfsError);
  });
});

describe('rsDecode', () => {
  it('should decode 3/1 → roundtrip with all shards present', () => {
    const data = makeData(100);
    const shards = rsEncode(data, 3, 1);
    const decoded = rsDecode(shards, 3, 1, data.length);
    expect(decoded.equals(data)).toBe(true);
  });

  it('should decode 5/2 → roundtrip with all shards present', () => {
    const data = makeData(500);
    const shards = rsEncode(data, 5, 2);
    const decoded = rsDecode(shards, 5, 2, data.length);
    expect(decoded.equals(data)).toBe(true);
  });

  it('should reconstruct when K shards are missing (3/1 → drop 1)', () => {
    const data = makeData(96);
    const shards = rsEncode(data, 3, 1);
    // Drop parity shard (index 3)
    const withMissing = dropShards(shards, [3]);
    const decoded = rsDecode(withMissing, 3, 1, data.length);
    expect(decoded.equals(data)).toBe(true);
  });

  it('should reconstruct when K shards are missing (5/2 → drop 2)', () => {
    const data = makeData(200);
    const shards = rsEncode(data, 5, 2);
    // Drop any 2 shards
    const withMissing = dropShards(shards, [1, 4]);
    const decoded = rsDecode(withMissing, 5, 2, data.length);
    expect(decoded.equals(data)).toBe(true);
  });

  it('should reconstruct when K data shards are missing', () => {
    const data = makeData(300);
    const shards = rsEncode(data, 5, 2);
    // Drop 2 data shards
    const withMissing = dropShards(shards, [0, 2]);
    const decoded = rsDecode(withMissing, 5, 2, data.length);
    expect(decoded.equals(data)).toBe(true);
  });

  it('should throw BfsError when K+1 shards are missing', () => {
    const data = makeData(200);
    const shards = rsEncode(data, 5, 2);
    const withMissing = dropShards(shards, [0, 1, 2]); // 3 missing > K=2
    expect(() => rsDecode(withMissing, 5, 2, data.length)).toThrow(BfsError);
  });

  it('should handle non-aligned data length (originalSize strips padding)', () => {
    // 13 bytes — not aligned to SHARD_ALIGNMENT
    const data = makeData(13);
    const shards = rsEncode(data, 3, 1);
    const decoded = rsDecode(shards, 3, 1, data.length);
    expect(decoded.equals(data)).toBe(true);
    expect(decoded.length).toBe(13);
  });

  it('should work with real data block (not just zeros)', () => {
    const data = Buffer.from(
      'The quick brown fox jumps over the lazy dog',
      'utf8',
    );
    const shards = rsEncode(data, 4, 2);
    const withMissing = dropShards(shards, [0, 3]);
    const decoded = rsDecode(withMissing, 4, 2, data.length);
    expect(decoded.equals(data)).toBe(true);
  });
});

describe('rsRepair', () => {
  it('should repair 1 missing shard in 5/2 config', () => {
    const data = makeData(200);
    const original = rsEncode(data, 5, 2);
    const withMissing = dropShards(original, [2]);
    const repaired = rsRepair(withMissing, 5, 2);

    expect(repaired).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      const r = repaired[i];
      const o = original[i];
      expect(r).toBeDefined();
      expect(o).toBeDefined();
      expect(r?.equals(o ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it('should repair 2 missing shards in 5/2 config', () => {
    const data = makeData(200);
    const original = rsEncode(data, 5, 2);
    const withMissing = dropShards(original, [1, 5]);
    const repaired = rsRepair(withMissing, 5, 2);

    expect(repaired).toHaveLength(7);
    for (let i = 0; i < 7; i++) {
      const r = repaired[i];
      const o = original[i];
      expect(r).toBeDefined();
      expect(o).toBeDefined();
      expect(r?.equals(o ?? Buffer.alloc(0))).toBe(true);
    }
  });

  it('should throw BfsError when too many shards missing', () => {
    const data = makeData(200);
    const shards = rsEncode(data, 5, 2);
    const withMissing = dropShards(shards, [0, 1, 2]);
    expect(() => rsRepair(withMissing, 5, 2)).toThrow(BfsError);
  });
});
