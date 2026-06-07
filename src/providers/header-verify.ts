import { BfsError } from '../core/errors.js';
import { matchShardIdentity } from '../core/shard-io.js';
import { fmtFor } from '../i18n/index.js';
import type { ShardHeader, ShardIdentity, VerifyShardResult } from '../types/index.js';

/**
 * Throws the standard "this provider keeps no header sidecars" error. Built-in
 * providers that rewrite the header in place (usesSidecar() === false) call this
 * from uploadHeaderSidecar / downloadHeaderSidecar so the error type and message
 * stay identical across every provider that opts out of sidecars.
 *
 * @param lang - BCP-47 language for the message
 * @param type - Provider type string (e.g. "local", "ftp")
 * @throws BfsError always
 */
export function throwSidecarUnsupported(lang: string, type: string): never {
  throw new BfsError(fmtFor(lang, 'sidecar_not_supported', type));
}

/**
 * Completes verifyShard once the header has been read: compares the shard
 * identity and returns a classified mismatch or { ok: true }. Shared so the
 * VerifyShardResult shape and the mismatch message stay identical across
 * providers.
 *
 * @param header   - Parsed shard header
 * @param expected - Identity the shard must carry
 * @param lang     - BCP-47 language for the mismatch message
 * @returns { ok: true } when identity matches, else a classified mismatch
 */
export function finishVerifyShard(header: ShardHeader, expected: ShardIdentity, lang: string): VerifyShardResult {
  const mismatch = matchShardIdentity(header, expected);
  if (mismatch) {
    return { ok: false, reason: 'mismatch', detail: fmtFor(lang, 'verify_shard_mismatch', mismatch.field, mismatch.expected, mismatch.actual) };
  }
  return { ok: true };
}
