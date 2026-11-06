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

/** One shard header a password can be tried against. */
export interface PasswordCandidate {
  readonly header: ShardHeader;
  readonly headerBytes: Buffer;
}

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
 * @param keyCache     optional (password,salt)->key memo shared across candidates
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
 * to the pool so sibling versions reuse it. Returns null on a blank entry, or
 * without asking at all when the run has nobody to answer (`io.interactive ===
 * false`) - this version then counts as one whose password was not supplied, and
 * the caller carries on with the versions it can open. Does NOT emit the
 * pool-exhausted warning - the caller decides whether and when to warn.
 *
 * @param header       parsed shard header (read for `encrypted` and `kdf_salt`)
 * @param headerBytes  raw header bytes, re-parsed with each candidate key
 * @param passwordPool shared MRU pool, appended on a successful manual attempt
 * @param io           ProviderIO for the interactive prompt
 * @param prompts      localized prompt text (only `ask`/`retry` are used here)
 * @param keyCache     optional (password,salt)->key memo shared across candidates
 * @returns the decrypted map, key, and password, or null
 */
export async function promptForVaultPassword(header: ShardHeader, headerBytes: Buffer, passwordPool: string[], io: ProviderIO, prompts: PasswordPromptText, keyCache?: Map<string, Buffer>): Promise<Nullable<MapDecryptResult>> {
  return promptAgainstCandidates(new CandidateSet([{ header, headerBytes }], null), passwordPool, io, { prompts, keyCache: keyCache ?? null });
}

/** How {@link tryDecryptAnyLocationMap} asks, caches and widens its search. */
export interface AnyLocationMapOptions {
  readonly prompts: PasswordPromptText;
  /** (password,salt)->key memo shared with earlier attempts; null starts a fresh one. */
  readonly keyCache: Nullable<Map<string, Buffer>>;
  /**
   * Further parts of the same version, read only after a password has been tried
   * and failed on the candidates in hand - so a version whose first part opens,
   * or a run that never gets to try one, reads nothing more.
   */
  readonly moreCandidates: Nullable<() => Promise<readonly PasswordCandidate[]>>;
}

/** The candidates in hand, plus the deferred ones loaded at most once. */
class CandidateSet {
  private loaded = false;
  constructor(
    private readonly current: PasswordCandidate[],
    private readonly more: Nullable<() => Promise<readonly PasswordCandidate[]>>,
  ) {}

  /** The candidates read so far. */
  get list(): readonly PasswordCandidate[] {
    return this.current;
  }

  /** Reads the deferred candidates once; returns the newly added ones. */
  async widen(): Promise<readonly PasswordCandidate[]> {
    if (this.loaded || !this.more) return [];
    this.loaded = true;
    const added = await this.more();
    this.current.push(...added);
    return added;
  }
}

/**
 * Prompts until a typed password opens the map of ANY of the candidates, or a
 * blank entry gives up. A typed password that opens none of the candidates in
 * hand is tried on the deferred ones before the operator hears "wrong", so one
 * part whose header no longer opens (a damaged salt) does not turn the correct
 * password into a "wrong password".
 */
async function promptAgainstCandidates(candidates: CandidateSet, passwordPool: string[], io: ProviderIO, opts: { prompts: PasswordPromptText; keyCache: Nullable<Map<string, Buffer>> }): Promise<Nullable<MapDecryptResult>> {
  const { prompts } = opts;
  const keyCache = opts.keyCache ?? undefined;
  if (!candidates.list.some(isSealed)) return null;
  // A run with no operator (`--bootstrap`, cron, closed stdin) cannot be asked:
  // the question would never be answered, and the wait ends the process rather
  // than the prompt. Treat the password as unavailable and let the caller skip
  // what it cannot open. `=== false` on purpose - an absent field means an
  // interactive terminal, per the ProviderIO contract.
  if (io.interactive === false) return null;
  // Unbounded on purpose: at this critical moment the operator keeps trying; a
  // blank entry gives up.
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
    const resolved = (await attemptOnAny(candidates.list, pwd, keyCache)) ?? (await attemptOnAny(await candidates.widen(), pwd, keyCache));
    if (resolved) {
      passwordPool.push(pwd);
      return resolved;
    }
  }
}

/** True for a shard whose location map is sealed under a password. */
function isSealed(c: PasswordCandidate): boolean {
  return c.header.encrypted && c.header.kdf_salt !== null;
}

/** Tries one password on each candidate in turn; the first map it opens wins. */
async function attemptOnAny(candidates: readonly PasswordCandidate[], pwd: string, keyCache?: Map<string, Buffer>): Promise<Nullable<MapDecryptResult>> {
  for (const c of candidates) {
    if (!c.header.encrypted || !c.header.kdf_salt) continue;
    const resolved = await attempt(c.headerBytes, c.header.kdf_salt, pwd, keyCache);
    if (resolved) return resolved;
  }
  return null;
}

/**
 * Resolves the vault key for one shard by decrypting its location map, trying
 * pooled passwords first (MRU order) and falling back to an interactive prompt.
 * A successful manual password is appended to the pool. Returns null for an
 * unencrypted shard, a blank/absent password, or no TTY - the caller decides
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
  return tryDecryptAnyLocationMap([{ header, headerBytes }], passwordPool, io, { prompts, keyCache: null, moreCandidates: null });
}

/**
 * Resolves the vault key from any of several shards of ONE version. The pool is
 * tried on the candidates in hand; when it opens none of them, the deferred
 * candidates (`moreCandidates`) are read and the pool tried on those too, before
 * the operator is asked. A typed password is tried the same way. The parts of a
 * version share one salt and one password, so a part whose own header no longer
 * opens - a damaged salt - must not decide the password for the rest; and since
 * the further parts are read only after a password failed, a version whose first
 * part opens costs no extra read. The pool-exhausted warning is emitted once,
 * and only when a non-empty pool opened nothing. Keys are memoized per
 * (password, salt), so a wrong password costs one derivation per distinct salt,
 * not one per part.
 *
 * @param candidates   headers in hand, in probe order
 * @param passwordPool shared MRU pool, mutated on a successful manual attempt
 * @param io           ProviderIO for the warning and the interactive prompt
 * @param opts         prompt text, key memo and the deferred candidates
 * @returns the decrypted location map, derived key, and the working password, or null
 */
export async function tryDecryptAnyLocationMap(candidates: readonly PasswordCandidate[], passwordPool: string[], io: ProviderIO, opts: AnyLocationMapOptions): Promise<Nullable<MapDecryptResult>> {
  const keyCache = opts.keyCache ?? new Map<string, Buffer>();
  const set = new CandidateSet([...candidates], opts.moreCandidates);
  if (passwordPool.length > 0) {
    const pooled = (await tryPoolOn(set.list, passwordPool, keyCache)) ?? (await tryPoolOn(await set.widen(), passwordPool, keyCache));
    if (pooled) return pooled;
  }
  if (!set.list.some(isSealed)) return null;
  if (passwordPool.length > 0) io.warn(opts.prompts.poolExhausted);
  return promptAgainstCandidates(set, passwordPool, io, { prompts: opts.prompts, keyCache });
}

/** Tries the whole pool on each candidate in turn; the first map it opens wins. */
async function tryPoolOn(candidates: readonly PasswordCandidate[], passwordPool: string[], keyCache: Map<string, Buffer>): Promise<Nullable<MapDecryptResult>> {
  for (const c of candidates) {
    const pooled = await tryPooledPasswords(c.header, c.headerBytes, passwordPool, keyCache);
    if (pooled) return pooled;
  }
  return null;
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
