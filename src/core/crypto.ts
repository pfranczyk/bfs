import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';
import type { Readable, TransformCallback } from 'node:stream';
import { Transform } from 'node:stream';

import { Algorithm, hashRawSync } from '@node-rs/argon2';
import type { ShardLocation } from '../types/index.js';
import { DecryptionError } from './errors.js';

const NONCE_SIZE = 12;
const TAG_SIZE = 16;
const SALT_SIZE = 16;
const KEY_SIZE = 32;

// Argon2id KDF parameters (RFC 9106 recommended: 64 MiB, 3 iterations)
export const ARGON2_PARAMS = {
  memoryCost: 65536, // 64 MiB
  timeCost: 3,
  parallelism: 1,
} as const;

/** Generates a random 16-byte salt for use as Argon2id input (kdf_salt in shard header). */
export function generateSalt(): Buffer {
  return randomBytes(SALT_SIZE);
}

/**
 * Derives a 32-byte AES key from a password and salt using Argon2id.
 * @param password - plaintext password provided by the user
 * @param salt     - 16-byte random salt (from generateSalt or shard header kdf_salt)
 */
export async function deriveKey(
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  // hashRawSync avoids WASM worker-thread initialization, which fails on
  // Windows Server 2025 + Node.js v25 when the native .node addon cannot load
  // its DLL dependency and the WASM fallback tries to spawn pthreads.
  return hashRawSync(password, {
    salt,
    algorithm: Algorithm.Argon2id,
    outputLen: KEY_SIZE,
    memoryCost: ARGON2_PARAMS.memoryCost,
    timeCost: ARGON2_PARAMS.timeCost,
    parallelism: ARGON2_PARAMS.parallelism,
  });
}

/**
 * Encrypts a blob with AES-256-GCM using Argon2id KDF.
 * @returns encrypted = nonce(12B) + ciphertext + tag(16B), salt separate, key for reuse
 */
export async function encryptBlob(
  data: Buffer,
  password: string,
): Promise<{ encrypted: Buffer; salt: Buffer; key: Buffer }> {
  const salt = generateSalt();
  const key = await deriveKey(password, salt);
  const encrypted = encryptWithKey(data, key);
  return { encrypted, salt, key };
}

/**
 * Decrypts a blob encrypted with encryptBlob.
 * @param encrypted - nonce(12B) + ciphertext + tag(16B)
 * @param password  - original password
 * @param salt      - kdf_salt from shard header
 */
export async function decryptBlob(
  encrypted: Buffer,
  password: string,
  salt: Buffer,
): Promise<Buffer> {
  const key = await deriveKey(password, salt);
  return decryptWithKey(encrypted, key);
}

/**
 * Decrypts a blob using a pre-derived key (skips Argon2).
 * Used in Pull Mode B when key was already derived from shard header kdf_salt.
 */
export function decryptBlobWithKey(encrypted: Buffer, key: Buffer): Buffer {
  return decryptWithKey(encrypted, key);
}

/**
 * Encrypts a location map as JSON with AES-256-GCM.
 * @returns nonce(12B) + ciphertext + tag(16B)
 */
export function encryptLocationMap(map: ShardLocation[], key: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(map), 'utf8');
  return encryptWithKey(json, key);
}

/**
 * Decrypts a location map encrypted with encryptLocationMap.
 */
export function decryptLocationMap(data: Buffer, key: Buffer): ShardLocation[] {
  const json = decryptWithKey(data, key);
  let parsed: ShardLocation[];
  try {
    parsed = JSON.parse(json.toString('utf8')) as ShardLocation[];
  } catch {
    throw new DecryptionError('Location map JSON is invalid after decryption');
  }
  // Backward compat: shards serialized before adapterPackage was introduced
  // omit the field. Treat undefined as null — the correct semantics for
  // legacy shards, which were always produced by built-in providers (local,
  // ftp). See PLAN/binary-format.md for the full compatibility rule.
  return parsed.map((loc) => ({
    ...loc,
    adapterPackage: loc.adapterPackage ?? null,
  }));
}

// ─── Streaming per-shard crypto (FORMAT_VERSION=2) ────────────────────────

/**
 * Derives a deterministic 12-byte AES-GCM nonce for a specific shard.
 * Formula: HMAC-SHA256(key, "shard_nonce" || uint32LE(version) || uint8(shardIndex))[:12]
 * Uniqueness guaranteed: different version → different KDF salt → different key;
 *                        same version → different shardIndex → different nonce.
 * @param key        - 32-byte AES key derived by deriveKey()
 * @param version    - snapshot version number (from shard header)
 * @param shardIndex - shard index 0..N+K-1
 * @returns 12-byte nonce (NONCE_SIZE)
 */
export function deriveShardNonce(
  key: Buffer,
  version: number,
  shardIndex: number,
): Buffer {
  const label = Buffer.from('shard_nonce', 'utf8');
  const versionBuf = Buffer.allocUnsafe(4);
  versionBuf.writeUInt32LE(version, 0);
  const indexBuf = Buffer.allocUnsafe(1);
  indexBuf.writeUInt8(shardIndex, 0);
  const mac = createHmac('sha256', key)
    .update(Buffer.concat([label, versionBuf, indexBuf]))
    .digest();
  return mac.subarray(0, NONCE_SIZE);
}

/**
 * Creates a Readable stream that encrypts data from `input` with AES-256-GCM.
 * Output format: [ciphertext chunks...][auth tag 16B]
 * The 16-byte GCM auth tag is appended as the last bytes of the stream —
 * compatible with decryptStream which extracts it via tail-buffer.
 * @param input - plaintext Readable stream
 * @param key   - 32-byte AES-256 key
 * @param nonce - 12-byte nonce (use deriveShardNonce for per-shard encryption)
 * @returns Readable stream with encrypted data + trailing auth tag
 */
export function encryptStream(
  input: Readable,
  key: Buffer,
  nonce: Buffer,
): Readable {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const transform = new Transform({
    transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
      cb(null, cipher.update(chunk));
    },
    flush(cb: TransformCallback) {
      const remaining = cipher.final();
      const tag = cipher.getAuthTag();
      cb(null, Buffer.concat([remaining, tag]));
    },
  });
  input.on('error', (err) => transform.destroy(err));
  input.pipe(transform);
  return transform;
}

/**
 * Creates a Readable stream that decrypts AES-256-GCM data from `input`.
 * Input format: [ciphertext chunks...][auth tag 16B]
 * Uses a tail-buffer: last TAG_SIZE bytes of the stream are treated as the auth tag.
 * The tag is set via decipher.setAuthTag() and verified by decipher.final().
 * @param input - encrypted Readable stream (ciphertext + trailing tag)
 * @param key   - 32-byte AES-256 key
 * @param nonce - 12-byte nonce (same as used for encryption)
 * @returns Readable stream with decrypted plaintext
 * @throws DecryptionError if auth tag verification fails or stream too short
 */
export function decryptStream(
  input: Readable,
  key: Buffer,
  nonce: Buffer,
): Readable {
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  // tail holds the last TAG_SIZE bytes seen so far — may be the auth tag
  let tail = Buffer.alloc(0);

  const transform = new Transform({
    transform(chunk: Buffer, _enc: string, cb: TransformCallback) {
      const combined = Buffer.concat([tail, chunk]);
      if (combined.length > TAG_SIZE) {
        const toProcess = combined.subarray(0, combined.length - TAG_SIZE);
        tail = combined.subarray(combined.length - TAG_SIZE);
        cb(null, decipher.update(toProcess));
      } else {
        // Not enough data yet — accumulate in tail, nothing to emit yet
        tail = combined;
        cb();
      }
    },
    flush(cb: TransformCallback) {
      if (tail.length !== TAG_SIZE) {
        cb(
          new DecryptionError(
            'Encrypted stream too short — missing GCM auth tag',
          ),
        );
        return;
      }
      decipher.setAuthTag(tail);
      try {
        cb(null, decipher.final());
      } catch {
        cb(
          new DecryptionError(
            'Decryption failed — wrong key or corrupted data',
          ),
        );
      }
    },
  });
  input.on('error', (err) => transform.destroy(err));
  input.pipe(transform);
  return transform;
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Encrypts data with AES-256-GCM using the provided key.
 * Generates a random nonce per call.
 * @returns nonce(12B) + ciphertext + authTag(16B)
 */
function encryptWithKey(data: Buffer, key: Buffer): Buffer {
  const nonce = randomBytes(NONCE_SIZE);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

/**
 * Decrypts AES-256-GCM data produced by encryptWithKey.
 * @throws DecryptionError if the key is wrong or the data is corrupted (GCM auth tag mismatch).
 */
function decryptWithKey(encrypted: Buffer, key: Buffer): Buffer {
  if (encrypted.length < NONCE_SIZE + TAG_SIZE) {
    throw new DecryptionError('Encrypted data too short');
  }
  const nonce = encrypted.subarray(0, NONCE_SIZE);
  const tag = encrypted.subarray(encrypted.length - TAG_SIZE);
  const ciphertext = encrypted.subarray(
    NONCE_SIZE,
    encrypted.length - TAG_SIZE,
  );

  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new DecryptionError(
      'Decryption failed — wrong key or corrupted data',
    );
  }
}
