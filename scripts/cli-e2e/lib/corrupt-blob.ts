// Length-preserving blob corrupter for cli-e2e - flips one bit inside a blob's
// DATA SECTION in place. The target is a cached pending blob
// (`.bfs/cache/push.blob.pending`), so a scenario can model a cache that rotted
// between two runs: an interrupted emergency dump, bit-rot on the working disk,
// an antivirus rewriting the file.
//
// Why the data section specifically: the resume path in `_loadOrPackBlob`
// (src/vault/push-pipeline.ts) separates a blob whose bytes stopped matching its
// seal from a file that never became a blob at all. A missing magic or a length
// below the header floor is the second case - unfinished work, which the resume
// answers by packing the directory again, not by refusing. Flipping a byte past
// the header keeps the file a valid-looking blob, so it lands squarely in the
// first case: usable-looking cache whose content no longer matches the checksum
// sealed at its end.
//
// The trailing SHA-256 is left stale by default, which is what models rot. With
// `--reseal` it is recomputed, which models the other thing entirely: damage
// that was sealed in as if it were sound, so every checksum agrees and the
// trouble only surfaces where the damaged bytes are finally parsed.
//
//   tsx corrupt-blob.ts <blobPath> [byteOffsetWithinDataSection] [--reseal]
//     <blobPath>                     path to the blob file to corrupt in place
//     [byteOffsetWithinDataSection]  optional offset from the data section start;
//                                    defaults to the middle of the data section
//     [--reseal]                     recompute the trailing SHA-256 afterwards
//
// Header field offsets follow the BFS blob header layout.

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';

const MAGIC = Buffer.from([0x42, 0x46, 0x53, 0x00]);
const HEADER_SIZE = 70;
const CHECKSUM_SIZE = 32;
const OFF_DATA_SECTION_OFFSET = 0x36;
const OFF_DATA_SECTION_LENGTH = 0x3e;

function main(): void {
  const blobPath = process.argv[2];
  if (!blobPath) {
    process.stderr.write('corrupt-blob: usage: tsx corrupt-blob.ts <blobPath> [byteOffsetWithinDataSection] [--reseal]\n');
    process.exit(2);
  }

  const blob = readFileSync(blobPath);
  if (blob.length < HEADER_SIZE + CHECKSUM_SIZE) {
    process.stderr.write(`corrupt-blob: file too short to be a blob (size=${blob.length})\n`);
    process.exit(1);
  }
  if (blob.subarray(0, 4).compare(MAGIC) !== 0) {
    process.stderr.write('corrupt-blob: missing BFS blob magic - refusing to touch this file\n');
    process.exit(1);
  }

  const dataStart = Number(blob.readBigUInt64LE(OFF_DATA_SECTION_OFFSET));
  const dataLength = Number(blob.readBigUInt64LE(OFF_DATA_SECTION_LENGTH));
  const dataEnd = dataStart + dataLength; // exclusive; trailing checksum left intact
  if (dataLength <= 0 || dataEnd > blob.length - CHECKSUM_SIZE) {
    process.stderr.write(`corrupt-blob: implausible data section [${dataStart}, ${dataEnd}) in a ${blob.length}B blob\n`);
    process.exit(1);
  }

  const args = process.argv.slice(3);
  const reseal = args.includes('--reseal');
  const explicit = args.find((a) => !a.startsWith('--'));
  const pos = explicit !== undefined ? dataStart + Number(explicit) : dataStart + Math.floor(dataLength / 2);
  if (pos < dataStart || pos >= dataEnd) {
    process.stderr.write(`corrupt-blob: offset ${pos} outside data section [${dataStart}, ${dataEnd})\n`);
    process.exit(1);
  }

  const before = blob.readUInt8(pos);
  const after = before ^ 0x01;
  blob.writeUInt8(after, pos);
  if (reseal) {
    createHash('sha256')
      .update(blob.subarray(0, blob.length - CHECKSUM_SIZE))
      .digest()
      .copy(blob, blob.length - CHECKSUM_SIZE);
  }
  writeFileSync(blobPath, blob);

  process.stdout.write(`CORRUPTED data@${pos} (0x${before.toString(16)}->0x${after.toString(16)}) blobSize=${blob.length}B dataSection=[${dataStart},${dataEnd})${reseal ? ' resealed' : ''}\n`);
}

main();
