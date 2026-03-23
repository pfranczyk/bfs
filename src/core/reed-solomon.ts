import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { ReedSolomonErasure } from '@subspace/reed-solomon-erasure.wasm';
import { BfsError } from './errors.js';

const require = createRequire(import.meta.url);

/**
 * Alignment boundary for shard payloads (bytes).
 * Shard sizes are rounded up to a multiple of this value.
 * All pipeline code that calculates shard sizes must import this constant.
 */
export const SHARD_ALIGNMENT = 8;

// ─── WASM factory ─────────────────────────────────────────────────────────
//
// The @subspace/reed-solomon-erasure.wasm library uses a simple bump allocator
// in its WASM module. After many malloc/free cycles the allocator runs out of
// available space and reconstruct() starts returning RESULT_ERROR_TOO_FEW_SHARDS_PRESENT.
// Fix: read WASM bytes once at module load, then call fromBytes() to get a
// fresh WASM instance per operation (re-instantiation is ~0.06 ms, negligible).

const { ReedSolomonErasure: _RSClass } =
  require('@subspace/reed-solomon-erasure.wasm') as {
    ReedSolomonErasure: typeof import('@subspace/reed-solomon-erasure.wasm').ReedSolomonErasure;
  };

const _wasmBytes: ArrayBuffer = (() => {
  const indexPath = require.resolve(
    '@subspace/reed-solomon-erasure.wasm',
  ) as string;
  const wasmPath = indexPath.replace(
    /index\.js$/,
    'reed_solomon_erasure_bg.wasm',
  );
  return readFileSync(wasmPath).buffer as ArrayBuffer;
})();

/** Returns a fresh WASM instance. Must be called once per encode/decode/repair operation. */
function newRs(): ReedSolomonErasure {
  return _RSClass.fromBytes(_wasmBytes);
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Rounds `n` up to the nearest multiple of `SHARD_ALIGNMENT`. */
function alignUp(n: number): number {
  return Math.ceil(n / SHARD_ALIGNMENT) * SHARD_ALIGNMENT;
}

/**
 * Calculates the payload size (bytes) for each shard when encoding `dataLen` bytes
 * across `dataShards` shards.
 */
export function calcShardPayloadSize(
  dataLen: number,
  dataShards: number,
): number {
  return alignUp(Math.ceil(dataLen / dataShards));
}

function validateParams(dataShards: number, parityShards: number): void {
  if (dataShards < 2)
    throw new BfsError(`dataShards must be >= 2, got ${dataShards}`);
  if (parityShards < 1)
    throw new BfsError(`parityShards must be >= 1, got ${parityShards}`);
  if (dataShards + parityShards > 256)
    throw new BfsError(`N+K must be <= 256, got ${dataShards + parityShards}`);
}

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Encodes a data blob into N+K Reed-Solomon shards.
 *
 * @param data         - input blob (any length)
 * @param dataShards   - N: number of data shards (>= 2)
 * @param parityShards - K: number of parity shards (>= 1)
 * @returns array of N+K Buffers — each is one shard payload
 * @throws BfsError on invalid parameters
 */
export function rsEncode(
  data: Buffer,
  dataShards: number,
  parityShards: number,
): Buffer[] {
  validateParams(dataShards, parityShards);

  const rs = newRs();
  const totalShards = dataShards + parityShards;
  const shardSize = calcShardPayloadSize(data.length, dataShards);

  // Flat array: first N*shardSize bytes = data (padded), rest = parity (zeros)
  const flat = new Uint8Array(totalShards * shardSize);
  flat.set(data); // copy data into beginning; remaining bytes stay 0 (padding)

  const result = rs.encode(flat, dataShards, parityShards);
  if (result !== 0) {
    throw new BfsError(`Reed-Solomon encode failed with code ${result}`);
  }

  // Split flat into individual shard Buffers
  const shards: Buffer[] = [];
  for (let i = 0; i < totalShards; i++) {
    shards.push(Buffer.from(flat.subarray(i * shardSize, (i + 1) * shardSize)));
  }
  return shards;
}

/**
 * Decodes the original blob from N+K shard slots (null = missing shard).
 * Requires at least N non-null shards.
 *
 * @param shards       - array of N+K slots; null marks a missing shard
 * @param dataShards   - N
 * @param parityShards - K
 * @param originalSize - exact blob size before encoding (blob_size from shard header)
 * @returns reconstructed blob (padding removed)
 * @throws BfsError when fewer than N shards are available or RS fails
 */
export function rsDecode(
  shards: (Buffer | null)[],
  dataShards: number,
  parityShards: number,
  originalSize: number,
): Buffer {
  validateParams(dataShards, parityShards);

  const present = shards.filter((s) => s !== null);
  if (present.length < dataShards) {
    throw new BfsError(
      `Not enough shards to reconstruct: need ${dataShards}, got ${present.length}`,
    );
  }

  const shardSize = present[0]?.length;
  const flat = buildFlat(shards, shardSize);
  const available = shards.map((s) => s !== null);

  // Only call reconstruct if some shards are actually missing
  const anyMissing = available.some((a) => !a);
  if (anyMissing) {
    const rs = newRs();
    const result = rs.reconstruct(flat, dataShards, parityShards, available);
    if (result !== 0) {
      throw new BfsError(`Reed-Solomon reconstruct failed with code ${result}`);
    }
  }

  // Concatenate data shards and strip padding
  const dataSection = flat.subarray(0, dataShards * shardSize);
  return Buffer.from(dataSection.subarray(0, originalSize));
}

/**
 * Repairs missing shards (null slots) using the available shards.
 * Requires at least N non-null shards. Does not reconstruct the original blob.
 *
 * @param shards       - array of N+K slots; null marks a missing shard
 * @param dataShards   - N
 * @param parityShards - K
 * @returns complete array of N+K Buffers (originals + repaired nulls)
 * @throws BfsError when fewer than N shards are available or RS fails
 */
export function rsRepair(
  shards: (Buffer | null)[],
  dataShards: number,
  parityShards: number,
): Buffer[] {
  validateParams(dataShards, parityShards);

  const present = shards.filter((s) => s !== null);
  if (present.length < dataShards) {
    throw new BfsError(
      `Not enough shards to repair: need ${dataShards}, got ${present.length}`,
    );
  }

  const shardSize = present[0]?.length;
  const flat = buildFlat(shards, shardSize);
  const available = shards.map((s) => s !== null);

  const rs = newRs();

  // Step 1: reconstruct missing DATA shards (library only recovers data, not parity)
  const anyDataMissing = available.slice(0, dataShards).some((a) => !a);
  if (anyDataMissing) {
    const r1 = rs.reconstruct(flat, dataShards, parityShards, available);
    if (r1 !== 0) {
      throw new BfsError(`Reed-Solomon repair failed with code ${r1}`);
    }
  }

  // Step 2: re-encode to rebuild all parity shards (whether they were missing or not)
  const r2 = rs.encode(flat, dataShards, parityShards);
  if (r2 !== 0) {
    throw new BfsError(`Reed-Solomon parity rebuild failed with code ${r2}`);
  }

  const totalShards = dataShards + parityShards;
  const repaired: Buffer[] = [];
  for (let i = 0; i < totalShards; i++) {
    repaired.push(
      Buffer.from(flat.subarray(i * shardSize, (i + 1) * shardSize)),
    );
  }
  return repaired;
}

// ─── Internal helper ───────────────────────────────────────────────────────

/**
 * Builds a flat Uint8Array from a shard slot array.
 * Missing (null) slots are left as zeros.
 */
function buildFlat(shards: (Buffer | null)[], shardSize: number): Uint8Array {
  const flat = new Uint8Array(shards.length * shardSize);
  for (let i = 0; i < shards.length; i++) {
    const s = shards[i];
    if (s !== null) {
      flat.set(s, i * shardSize);
    }
  }
  return flat;
}
