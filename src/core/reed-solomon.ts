import type { Hash } from 'node:crypto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { open } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { Readable } from 'node:stream';
import { PassThrough } from 'node:stream';

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

const { ReedSolomonErasure: _RSClass } = require('@subspace/reed-solomon-erasure.wasm') as { ReedSolomonErasure: typeof import('@subspace/reed-solomon-erasure.wasm').ReedSolomonErasure };

const _wasmBytes: ArrayBuffer = (() => {
  const indexPath = require.resolve('@subspace/reed-solomon-erasure.wasm') as string;
  const wasmPath = indexPath.replace(/index\.js$/, 'reed_solomon_erasure_bg.wasm');
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
export function calcShardPayloadSize(dataLen: number, dataShards: number): number {
  return alignUp(Math.ceil(dataLen / dataShards));
}

function validateParams(dataShards: number, parityShards: number): void {
  if (dataShards < 2) throw new BfsError(`dataShards must be >= 2, got ${dataShards}`);
  if (parityShards < 1) throw new BfsError(`parityShards must be >= 1, got ${parityShards}`);
  if (dataShards + parityShards > 256) throw new BfsError(`N+K must be <= 256, got ${dataShards + parityShards}`);
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
export function rsEncode(data: Buffer, dataShards: number, parityShards: number): Buffer[] {
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
export function rsDecode(shards: Nullable<Buffer>[], dataShards: number, parityShards: number, originalSize: number): Buffer {
  validateParams(dataShards, parityShards);

  const present = shards.filter((s) => s !== null);
  if (present.length < dataShards) {
    throw new BfsError(`Not enough shards to reconstruct: need ${dataShards}, got ${present.length}`);
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
export function rsRepair(shards: Nullable<Buffer>[], dataShards: number, parityShards: number): Buffer[] {
  validateParams(dataShards, parityShards);

  const present = shards.filter((s) => s !== null);
  if (present.length < dataShards) {
    throw new BfsError(`Not enough shards to repair: need ${dataShards}, got ${present.length}`);
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
    repaired.push(Buffer.from(flat.subarray(i * shardSize, (i + 1) * shardSize)));
  }
  return repaired;
}

// ─── Striped RS (FORMAT_VERSION=2 pipeline) ────────────────────────────────

/** Result of striped RS encoding with inline SHA-256 hashing. */
export interface RsEncodeStripedResult {
  /** SHA-256 hex hashes for N data shards. */
  dataShardHashes: string[];
  /** SHA-256 hex hashes for K parity shards. */
  parityShardHashes: string[];
}

/**
 * Encodes a blob stream into K parity shard files using striped Reed-Solomon,
 * computing SHA-256 hashes for all N+K shards inline (no extra I/O passes).
 * Data shards are slices of the original blob — not written by this function.
 * Parity shards are written stripe-by-stripe to `parityPaths` temp files.
 * Peak RAM: (N+K) × stripeSize bytes (e.g. 192 MiB for N=2, K=1, stripe=64 MiB).
 *
 * @param source      - Readable stream of the full blob
 * @param parityPaths - K output file paths for parity shards
 * @param N           - number of data shards
 * @param K           - number of parity shards
 * @param stripeSize  - bytes per shard per stripe (e.g. 64 MiB)
 * @returns SHA-256 hashes for all N data + K parity shards
 */
export async function rsEncodeStriped(source: Readable, parityPaths: string[], N: number, K: number, stripeSize: number): Promise<RsEncodeStripedResult> {
  validateParams(N, K);
  if (parityPaths.length !== K) {
    throw new BfsError(`parityPaths must have K=${K} entries, got ${parityPaths.length}`);
  }
  const flat = new Uint8Array((N + K) * stripeSize); // reused per stripe
  const inputBlock = Buffer.alloc(N * stripeSize); // preallocated input buffer
  let inputFilled = 0;

  // N+K hash contexts — mutation OK for performance (streaming hash)
  const hashers: Hash[] = Array.from({ length: N + K }, () => createHash('sha256'));

  const parityHandles = await Promise.all(parityPaths.map((p) => open(p, 'w')));
  try {
    for await (const rawChunk of source) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk as Uint8Array);
      let off = 0;
      while (off < chunk.length) {
        const space = inputBlock.length - inputFilled;
        const toCopy = Math.min(space, chunk.length - off);
        chunk.copy(inputBlock, inputFilled, off, off + toCopy);
        inputFilled += toCopy;
        off += toCopy;
        if (inputFilled === inputBlock.length) {
          await _encodeStripeWithHash({ inputBlock, flat, N, K, stripeSize, parityHandles, hashers });
          inputFilled = 0;
        }
      }
    }
    if (inputFilled > 0) {
      // Zero-pad the last partial stripe before encoding
      inputBlock.fill(0, inputFilled);
      await _encodeStripeWithHash({ inputBlock, flat, N, K, stripeSize, parityHandles, hashers });
    }
  } finally {
    await Promise.all(parityHandles.map((h) => h.close()));
  }

  return { dataShardHashes: hashers.slice(0, N).map((h) => h.digest('hex')), parityShardHashes: hashers.slice(N).map((h) => h.digest('hex')) };
}

/**
 * Decodes a blob from N+K striped shard streams.
 * Missing shards (null) are recovered by Reed-Solomon reconstruction.
 * Returns a Readable of the reconstructed blob, trimmed to `blobSize`.
 *
 * @param shardStreams - N+K decrypted shard payload streams (null = missing)
 * @param N           - number of data shards
 * @param K           - number of parity shards
 * @param stripeSize  - bytes per shard per stripe (must match encode)
 * @param blobSize    - exact blob size before RS encode (for padding removal)
 * @returns Readable stream of the reconstructed blob
 */
export function rsDecodeStriped(shardStreams: Nullable<Readable>[], N: number, K: number, stripeSize: number, blobSize: number, debugLog?: (msg: string) => void): Readable {
  validateParams(N, K);
  const totalShards = N + K;
  const shardSize = calcShardPayloadSize(blobSize, N);
  const numStripes = Math.ceil(shardSize / stripeSize);
  const output = new PassThrough();

  void _runStripedDecode(shardStreams, N, K, totalShards, stripeSize, numStripes, blobSize, output, debugLog);
  return output;
}

// ─── Internal helper ───────────────────────────────────────────────────────

/**
 * Builds a flat Uint8Array from a shard slot array.
 * Missing (null) slots are left as zeros.
 */
function buildFlat(shards: Nullable<Buffer>[], shardSize: number): Uint8Array {
  const flat = new Uint8Array(shards.length * shardSize);
  for (let i = 0; i < shards.length; i++) {
    const s = shards[i];
    if (s !== null) {
      flat.set(s, i * shardSize);
    }
  }
  return flat;
}

interface EncodeStripeCtx {
  inputBlock: Buffer;
  flat: Uint8Array;
  N: number;
  K: number;
  stripeSize: number;
  parityHandles: FileHandle[];
  hashers: Hash[];
}

/** Encodes one stripe: copies input into flat, RS-encodes, hashes, writes K parity slices. */
async function _encodeStripeWithHash(ctx: EncodeStripeCtx): Promise<void> {
  const { inputBlock, flat, N, K, stripeSize, parityHandles, hashers } = ctx;
  // Copy data into flat; zero parity portion before encode
  flat.set(new Uint8Array(inputBlock.buffer, inputBlock.byteOffset, N * stripeSize), 0);
  flat.fill(0, N * stripeSize); // zero parity region
  const rs = newRs();
  const result = rs.encode(flat, N, K);
  if (result !== 0) {
    throw new BfsError(`Reed-Solomon stripe encode failed with code ${result}`);
  }

  // Feed data shard slices to hashers (from inputBlock — original data incl. zero-padding)
  for (let i = 0; i < N; i++) {
    hashers[i].update(Buffer.from(inputBlock.buffer, inputBlock.byteOffset + i * stripeSize, stripeSize));
  }

  // Write parity and feed parity shard slices to hashers
  for (let j = 0; j < K; j++) {
    const paritySlice = Buffer.from(flat.buffer, flat.byteOffset + (N + j) * stripeSize, stripeSize);
    await parityHandles[j].write(paritySlice);
    hashers[N + j].update(paritySlice);
  }
}

/**
 * Async driver for rsDecodeStriped.
 * Runs in background; errors are forwarded to the output PassThrough.
 */
async function _runStripedDecode(
  shardStreams: Nullable<Readable>[],
  N: number,
  K: number,
  totalShards: number,
  stripeSize: number,
  numStripes: number,
  blobSize: number,
  output: PassThrough,
  debugLog: ((msg: string) => void) | undefined,
): Promise<void> {
  const readers = shardStreams.map((s) => (s !== null ? new _ShardReader(s) : null));
  const flat = new Uint8Array(totalShards * stripeSize);
  let bytesEmitted = 0;

  if (debugLog) {
    const readerInfo = readers.map((r, i) => `[${i}]=${r !== null ? 'active' : 'null'}`).join(' ');
    debugLog(`_runStripedDecode: blobSize=${blobSize} N=${N} K=${K}` + ` stripeSize=${stripeSize} numStripes=${numStripes} readers: ${readerInfo}`);
  }

  try {
    for (let stripe = 0; stripe < numStripes; stripe++) {
      flat.fill(0);
      const available: boolean[] = [];
      const gotValues: number[] = [];
      for (let i = 0; i < totalShards; i++) {
        const reader = readers[i];
        if (reader !== null) {
          const got = await reader.readInto(flat, i * stripeSize, stripeSize);
          gotValues.push(got);
          // got=0 means the shard returned no data for this stripe — mark it
          // unavailable so RS reconstructs it instead of emitting zeros.
          available.push(got > 0);
        } else {
          gotValues.push(-1);
          available.push(false);
        }
      }
      const present = available.filter(Boolean).length;
      // Log last 3 stripes, any stripe with a missing/empty reader, or any
      // stripe where a shard returned 0 bytes (helps diagnose stream issues)
      const anyZero = gotValues.some((g) => g === 0);
      if (debugLog && (stripe >= numStripes - 3 || present < totalShards || anyZero)) {
        const isLast = stripe === numStripes - 1;
        debugLog(`stripe ${stripe}/${numStripes - 1}${isLast ? ' (LAST)' : ''}:` + ` got=[${gotValues.join(',')}]` + ` avail=[${available.map((a) => (a ? 'T' : 'F')).join(',')}]` + ` present=${present}/${totalShards}`);
      }
      const anyMissing = available.some((a) => !a);
      if (anyMissing) {
        if (present < N) throw new BfsError(`Not enough shards for stripe ${stripe}: need ${N}, got ${present}`);
        const rs = newRs();
        const result = rs.reconstruct(flat, N, K, available);
        if (result !== 0) throw new BfsError(`RS stripe reconstruct failed: code ${result}`);
      }
      const remaining = blobSize - bytesEmitted;
      const toEmit = Math.min(N * stripeSize, remaining);
      if (toEmit > 0) {
        output.push(Buffer.from(flat.subarray(0, toEmit)));
        bytesEmitted += toEmit;
      }
    }
    output.push(null);
  } catch (err) {
    output.destroy(err instanceof Error ? err : new BfsError(String(err)));
  }
}

/** Buffered reader for a Readable stream — allows reading exactly N bytes per call. */
class _ShardReader {
  private readonly iter: AsyncIterator<Buffer | Uint8Array>;
  private leftover: Buffer = Buffer.alloc(0);

  constructor(stream: Readable) {
    this.iter = stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>;
  }

  /**
   * Reads up to `n` bytes into `outBuf` at `outOffset`.
   * @returns number of bytes actually read (< n only at end of stream)
   */
  async readInto(outBuf: Uint8Array, outOffset: number, n: number): Promise<number> {
    let filled = 0;
    if (this.leftover.length > 0) {
      const take = Math.min(this.leftover.length, n);
      outBuf.set(this.leftover.subarray(0, take), outOffset);
      filled += take;
      this.leftover = this.leftover.subarray(take);
    }
    while (filled < n) {
      const { done, value } = await this.iter.next();
      if (done) break;
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
      const take = Math.min(chunk.length, n - filled);
      chunk.copy(outBuf, outOffset + filled, 0, take);
      filled += take;
      if (take < chunk.length) {
        this.leftover = Buffer.from(chunk.subarray(take));
      }
    }
    return filled;
  }
}
