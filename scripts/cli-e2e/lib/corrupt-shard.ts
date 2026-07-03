// Length-preserving shard corrupter for cli-e2e — flips one bit inside a
// shard's payload IN PLACE and does NOT re-seal the trailing SHA-256. This is
// the deliberate opposite of tamper-shard.ts (which recomputes the checksum so
// the forgery stays byte-valid): here we want the shard to read as CORRUPT.
//
// For an encrypted shard the flipped byte lands in the ciphertext, breaking the
// per-shard AES-256-GCM auth tag; for a --no-enc shard it breaks the trailing
// SHA-256. Either way BFS must detect the corruption, exclude the shard, and
// erasure-decode the blob from the remaining N healthy shards + parity.
//
//   tsx corrupt-shard.ts <shardPath> [byteOffsetWithinPayload]
//     <shardPath>              path to the shard file to corrupt in place
//     [byteOffsetWithinPayload] optional offset from payload start; defaults to
//                               the middle of the payload
//
// Reuses the project's own shard-io codec to locate the header/payload boundary
// (no new deps).

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { computeShardHeaderSize } from '../../../src/core/shard-io.js';

const SHA256_BYTES = 32;

function main(): void {
  const shardPath = process.argv[2];
  if (!shardPath) {
    process.stderr.write('corrupt-shard: usage: tsx corrupt-shard.ts <shardPath> [byteOffsetWithinPayload]\n');
    process.exit(2);
  }

  const shard = readFileSync(shardPath);
  const headerSize = computeShardHeaderSize(shard);
  const payloadStart = headerSize;
  const payloadEnd = shard.length - SHA256_BYTES; // exclusive; trailing checksum left intact
  if (payloadEnd <= payloadStart) {
    process.stderr.write(`corrupt-shard: shard too small to corrupt (header=${headerSize}, size=${shard.length})\n`);
    process.exit(1);
  }

  const explicit = process.argv[3];
  const pos = explicit !== undefined ? payloadStart + Number(explicit) : payloadStart + Math.floor((payloadEnd - payloadStart) / 2);
  if (pos < payloadStart || pos >= payloadEnd) {
    process.stderr.write(`corrupt-shard: offset ${pos} outside payload [${payloadStart}, ${payloadEnd})\n`);
    process.exit(1);
  }

  const before = shard.readUInt8(pos);
  const after = before ^ 0x01;
  shard.writeUInt8(after, pos);
  writeFileSync(shardPath, shard);

  process.stdout.write(`CORRUPTED payload@${pos} (0x${before.toString(16)}->0x${after.toString(16)}) shardSize=${shard.length}B header=${headerSize}B\n`);
}

main();
