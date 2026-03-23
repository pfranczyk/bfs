import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Algorithm, hashRaw } from '@node-rs/argon2';
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
  return hashRaw(password, {
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
  try {
    return JSON.parse(json.toString('utf8')) as ShardLocation[];
  } catch {
    throw new DecryptionError('Location map JSON is invalid after decryption');
  }
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
