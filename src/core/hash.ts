import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { Readable } from 'node:stream';

/**
 * Width in bytes of a SHA-256 digest. Used both for hash fields inside the
 * binary formats and for the trailing checksum that protects each blob/shard.
 */
export const SHA256_BYTES = 32;

/** Computes the SHA-256 hash of a Buffer and returns it as a hex string. */
export function hashBuffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** Computes the SHA-256 hash of a Readable stream and returns it as a hex string. */
export function hashStream(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    stream.on('data', (chunk: Buffer) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}

/** Collects all chunks from a Readable stream into a single Buffer. */
export async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Computes SHA-256 of a file, excluding the last `tailBytes` bytes.
 * Streams the file in chunks — does not load the whole file into memory.
 * Used for blob hash verification without buffering the full blob.
 *
 * @param filePath  - Path to the file to hash
 * @param tailBytes - Number of trailing bytes to exclude from the digest
 * @returns Hex-encoded SHA-256 digest
 */
export async function hashFileExcludingTail(filePath: string, tailBytes: number): Promise<string> {
  const fileStat = await stat(filePath);
  const hashLen = Math.max(0, fileStat.size - tailBytes);
  const hash = createHash('sha256');
  if (hashLen === 0) return hash.digest('hex');
  // `end` in createReadStream is inclusive, so last byte is hashLen-1
  const stream = createReadStream(filePath, { start: 0, end: hashLen - 1 });
  for await (const chunk of stream) {
    hash.update(chunk as Buffer);
  }
  return hash.digest('hex');
}
