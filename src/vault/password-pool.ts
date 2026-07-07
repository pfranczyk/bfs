import { Readable } from 'node:stream';
import { deriveKey } from '../core/crypto.js';
import { parseShardHeaderFromStream } from '../core/shard-io.js';
import type { ProviderIO, ShardHeader, ShardLocation } from '../types/index.js';

/** Localized prompt/warning text for the interactive vault-password fallback. */
export interface PasswordPromptText {
  /** Warning emitted once when no pooled password decrypts the map. */
  readonly poolExhausted: string;
  /** Prompt for the first manual attempt. */
  readonly ask: string;
  /** Prompt shown after a wrong manual attempt. */
  readonly retry: string;
}

/**
 * Resolves the vault key for one shard by decrypting its location map, trying
 * pooled passwords in MRU order (most-recently-added first) and falling back to
 * an interactive prompt. A successful manual password is appended to the pool
 * so sibling versions reuse it. Returns null for an unencrypted shard, when the
 * operator submits a blank password (gives up), or when no TTY is available
 * (`askSecret` rejects) — the caller decides whether that is fatal.
 *
 * @param header       parsed shard header (read for `encrypted` and `kdf_salt`)
 * @param headerBytes  raw header bytes, re-parsed with each candidate key
 * @param passwordPool shared MRU pool, mutated on a successful manual attempt
 * @param io           ProviderIO for the warning and the interactive prompt
 * @param prompts      localized prompt/warning text for the calling command
 * @returns the decrypted location map, derived key, and the working password, or null
 */
export async function tryDecryptLocationMap(
  header: ShardHeader,
  headerBytes: Buffer,
  passwordPool: string[],
  io: ProviderIO,
  prompts: PasswordPromptText,
): Promise<Nullable<{ location_map: ShardLocation[]; encKey: Buffer; password: string }>> {
  if (!header.encrypted || !header.kdf_salt) return null;
  const salt = header.kdf_salt;

  // Try known passwords in MRU order (most-recently-added first).
  for (let i = passwordPool.length - 1; i >= 0; i--) {
    const pwd = passwordPool[i];
    if (pwd === undefined) continue;
    const resolved = await attempt(headerBytes, salt, pwd);
    if (resolved) return resolved;
  }

  if (passwordPool.length > 0) io.warn(prompts.poolExhausted);

  // Ask the operator, retrying until a password decrypts the map or they submit
  // a blank entry. Unbounded on purpose: at this critical moment they keep
  // trying; a blank entry (or no interactive TTY) skips this shard.
  let firstTry = true;
  for (;;) {
    let pwd: Nullable<string> = null;
    try {
      pwd = await io.askSecret(firstTry ? prompts.ask : prompts.retry);
    } catch {
      return null;
    }
    firstTry = false;
    if (!pwd) return null;

    const resolved = await attempt(headerBytes, salt, pwd);
    if (resolved) {
      passwordPool.push(pwd);
      return resolved;
    }
  }
}

/**
 * Derives a key from one password and re-parses the header with it. Returns the
 * decrypted location map and key on success, or null when the password is wrong
 * (a GCM auth-tag mismatch surfaces as a thrown DecryptionError).
 */
async function attempt(headerBytes: Buffer, salt: Buffer, pwd: string): Promise<Nullable<{ location_map: ShardLocation[]; encKey: Buffer; password: string }>> {
  try {
    const key = await deriveKey(pwd, salt);
    const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(headerBytes), key);
    payloadStream.on('error', () => {}).destroy();
    return { location_map: header.location_map, encKey: key, password: pwd };
  } catch {
    return null;
  }
}
