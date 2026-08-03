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

/** Result of opening one shard's location map: the map, its key, and the password. */
type MapDecryptResult = { location_map: ShardLocation[]; encKey: Buffer; password: string };

/**
 * Tries every pooled password (MRU order, most-recently-added first) against one
 * shard's encrypted location map, without prompting. Returns the map on the first
 * hit, or null when no pooled password opens it (or the shard is unencrypted).
 * Keys are memoized by (password, salt) in `keyCache` so a per-version salt shared
 * across siblings costs one Argon2id derivation, not one per candidate shard.
 *
 * @param header       parsed shard header (read for `encrypted` and `kdf_salt`)
 * @param headerBytes  raw header bytes, re-parsed with each candidate key
 * @param passwordPool shared MRU pool (not mutated here)
 * @param keyCache     optional (password,salt)→key memo shared across candidates
 * @returns the decrypted map, key, and password, or null
 */
export async function tryPooledPasswords(header: ShardHeader, headerBytes: Buffer, passwordPool: string[], keyCache?: Map<string, Buffer>): Promise<Nullable<MapDecryptResult>> {
  if (!header.encrypted || !header.kdf_salt) return null;
  const salt = header.kdf_salt;
  for (let i = passwordPool.length - 1; i >= 0; i--) {
    const pwd = passwordPool[i];
    if (pwd === undefined) continue;
    const resolved = await attempt(headerBytes, salt, pwd, keyCache);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Prompts the operator for one shard's vault password, retrying until a password
 * opens its map or they submit a blank entry. A successful password is appended
 * to the pool so sibling versions reuse it. Returns null on a blank entry or when
 * no interactive TTY is available (`askSecret` rejects). Does NOT emit the
 * pool-exhausted warning — the caller decides whether and when to warn.
 *
 * @param header       parsed shard header (read for `encrypted` and `kdf_salt`)
 * @param headerBytes  raw header bytes, re-parsed with each candidate key
 * @param passwordPool shared MRU pool, appended on a successful manual attempt
 * @param io           ProviderIO for the interactive prompt
 * @param prompts      localized prompt text (only `ask`/`retry` are used here)
 * @param keyCache     optional (password,salt)→key memo shared across candidates
 * @returns the decrypted map, key, and password, or null
 */
export async function promptForVaultPassword(header: ShardHeader, headerBytes: Buffer, passwordPool: string[], io: ProviderIO, prompts: PasswordPromptText, keyCache?: Map<string, Buffer>): Promise<Nullable<MapDecryptResult>> {
  if (!header.encrypted || !header.kdf_salt) return null;
  const salt = header.kdf_salt;
  // Unbounded on purpose: at this critical moment the operator keeps trying; a
  // blank entry (or no interactive TTY) gives up.
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
    const resolved = await attempt(headerBytes, salt, pwd, keyCache);
    if (resolved) {
      passwordPool.push(pwd);
      return resolved;
    }
  }
}

/**
 * Resolves the vault key for one shard by decrypting its location map, trying
 * pooled passwords first (MRU order) and falling back to an interactive prompt.
 * A successful manual password is appended to the pool. Returns null for an
 * unencrypted shard, a blank/absent password, or no TTY — the caller decides
 * whether that is fatal.
 *
 * @param header       parsed shard header (read for `encrypted` and `kdf_salt`)
 * @param headerBytes  raw header bytes, re-parsed with each candidate key
 * @param passwordPool shared MRU pool, mutated on a successful manual attempt
 * @param io           ProviderIO for the warning and the interactive prompt
 * @param prompts      localized prompt/warning text for the calling command
 * @returns the decrypted location map, derived key, and the working password, or null
 */
export async function tryDecryptLocationMap(header: ShardHeader, headerBytes: Buffer, passwordPool: string[], io: ProviderIO, prompts: PasswordPromptText): Promise<Nullable<MapDecryptResult>> {
  const pooled = await tryPooledPasswords(header, headerBytes, passwordPool);
  if (pooled) return pooled;
  if (!header.encrypted || !header.kdf_salt) return null;
  if (passwordPool.length > 0) io.warn(prompts.poolExhausted);
  return promptForVaultPassword(header, headerBytes, passwordPool, io, prompts);
}

/**
 * Derives a key from one password (memoized per (password, salt) when a cache is
 * given) and re-parses the header with it. Returns the decrypted location map and
 * key on success, or null when the password is wrong (a GCM auth-tag mismatch
 * surfaces as a thrown DecryptionError).
 */
async function attempt(headerBytes: Buffer, salt: Buffer, pwd: string, keyCache?: Map<string, Buffer>): Promise<Nullable<MapDecryptResult>> {
  try {
    const key = await deriveKeyCached(pwd, salt, keyCache);
    const { header, payloadStream } = await parseShardHeaderFromStream(Readable.from(headerBytes), key);
    payloadStream.on('error', () => {}).destroy();
    return { location_map: header.location_map, encKey: key, password: pwd };
  } catch {
    return null;
  }
}

/**
 * Derives an Argon2id key, reusing a cached result for the same (password, salt).
 * The salt hex is fixed-length, so `hex:pwd` is an unambiguous cache key.
 */
async function deriveKeyCached(pwd: string, salt: Buffer, keyCache?: Map<string, Buffer>): Promise<Buffer> {
  if (!keyCache) return deriveKey(pwd, salt);
  const cacheKey = `${salt.toString('hex')}:${pwd}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const key = await deriveKey(pwd, salt);
  keyCache.set(cacheKey, key);
  return key;
}
