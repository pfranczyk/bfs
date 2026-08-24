// Header-region shard corrupter for cli-e2e - flips one bit INSIDE a shard's
// HEADER in place and does NOT re-seal anything. It is the header-side sibling
// of corrupt-shard.ts (which damages the payload, invisible to any header-only
// reader) and the opposite of tamper-shard.ts (which forges a byte-VALID header
// by recomputing the trailing checksum, and only works with encryption off).
//
// The flipped byte lands in a region that carries no length field, so the header
// still PARSES - `computeShardHeaderSize` walks it, `buildShardHeaderFromBytes`
// returns the metadata - but its encrypted location map no longer opens:
//
//   tsx corrupt-shard-header.ts <shardPath> [--map | --kdf-salt]
//     --map        (default) last byte of the location-map payload. On an
//                  encrypted shard that is the last byte of the AES-256-GCM auth
//                  tag sealing the map, so every candidate key fails to decrypt.
//     --kdf-salt   first byte of the 16-byte Argon2id salt, so the key derived
//                  from the CORRECT password no longer opens the map.
//
// A version's kdf_salt and location map are the same across all of its shards
// (only the map ciphertext differs - a fresh random nonce per encryption), so a
// reader that hits this shard can still get the same map from a sibling.
//
// Reuses the project's own shard-io codec to locate the header fields (no new
// deps): only node:fs plus src/core/shard-io.ts.

import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import { buildShardHeaderFromBytes, computeShardHeaderSize } from '../../../src/core/shard-io.js';

const KDF_SALT_BYTES = 16;
const MAP_LENGTH_FIELD_BYTES = 4;
const RS_STRIPE_SIZE_FIELD_BYTES = 4; // present only for format_version >= 2

/** Prints a diagnostic and exits - the type is `never`, so callers narrow after it. */
function fail(message: string, code = 1): never {
  process.stderr.write(`corrupt-shard-header: ${message}\n`);
  process.exit(code);
}

function main(): void {
  const shardPath = process.argv[2];
  const mode = process.argv[3] ?? '--map';
  if (!shardPath) {
    fail('usage: tsx corrupt-shard-header.ts <shardPath> [--map|--kdf-salt]', 2);
  }
  if (mode !== '--map' && mode !== '--kdf-salt') {
    fail(`unknown mode "${mode}" (expected --map or --kdf-salt)`, 2);
  }

  const shard = readFileSync(shardPath);
  const headerSize = computeShardHeaderSize(shard);
  // Parsed WITHOUT a key: an encrypted map stays opaque, which is enough - only
  // map_length / kdf_salt / format_version are needed to locate the target byte.
  const header = buildShardHeaderFromBytes(shard.subarray(0, headerSize));

  let pos: number;
  if (mode === '--map') {
    if (header.map_length <= 0) {
      fail('shard header carries no location map to corrupt');
    }
    pos = headerSize - 1; // last byte of the map payload = last GCM tag byte when encrypted
  } else {
    const salt = header.kdf_salt;
    if (!header.encrypted || salt === null) {
      fail('shard is not encrypted - it has no KDF salt to corrupt');
    }
    const v2Fields = header.format_version >= 2 ? RS_STRIPE_SIZE_FIELD_BYTES : 0;
    pos = headerSize - header.map_length - MAP_LENGTH_FIELD_BYTES - v2Fields - KDF_SALT_BYTES;
    // Guard the offset arithmetic against a header layout change: the bytes at
    // the computed position must be exactly the salt the codec just parsed.
    if (pos < 0 || !shard.subarray(pos, pos + KDF_SALT_BYTES).equals(salt)) {
      fail(`kdf_salt offset ${pos} does not match the parsed salt - header layout changed`);
    }
  }

  const before = shard.readUInt8(pos);
  const after = before ^ 0x01;
  shard.writeUInt8(after, pos);
  writeFileSync(shardPath, shard);

  process.stdout.write(`HEADER-CORRUPTED mode=${mode.slice(2)} offset=${pos} (0x${before.toString(16)}->0x${after.toString(16)}) header=${headerSize}B map=${header.map_length}B\n`);
}

main();
