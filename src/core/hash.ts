import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';

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
