import type { CatalogDrift } from '../types/index.js';

/** A file that was skipped during pack (unreadable) or unpack (unwritable). */
export interface SkippedFile {
  /** Relative path of the file (in rootDir for push; in blob for pull). */
  path: string;
  /** Human-readable reason (Node.js error message). */
  reason: string;
}

/** Base error class for all BFS-specific errors. */
export class BfsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'BfsError';
  }
}

/** Thrown when a shard binary fails magic or checksum validation. */
export class ShardCorruptedError extends BfsError {
  constructor(message: string) {
    super(message);
    this.name = 'ShardCorruptedError';
  }
}

/** Thrown when a storage provider operation fails (I/O error, auth failure, etc.). */
export class ProviderError extends BfsError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ProviderError';
  }
}

/**
 * Thrown when the operator deliberately refuses a presented host key (declines
 * the interactive confirm, or the key is `@revoked` in known_hosts). Distinct
 * from a connection failure: a decline is a conscious "do not trust this server"
 * and must abort the flow, whereas an unreachable server may fall back to an
 * offline path. Extends ProviderError so existing `instanceof ProviderError`
 * catches still match.
 */
export class HostKeyDeclinedError extends ProviderError {
  constructor(message: string) {
    super(message);
    this.name = 'HostKeyDeclinedError';
  }
}

/** Thrown when AES-GCM decryption fails (wrong key or corrupted ciphertext). */
export class DecryptionError extends BfsError {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/** Thrown when consensus check detects mismatching shard headers across providers. */
export class TamperDetectedError extends BfsError {
  constructor(message: string) {
    super(message);
    this.name = 'TamperDetectedError';
  }
}

/**
 * Thrown when a blob entry's path is unsafe to write during unpack — absolute,
 * contains a `..` segment or NUL byte, or resolves outside the target directory.
 * This is the path-traversal / zip-slip guard for restoring a backup whose
 * contents may originate from an untrusted source.
 */
export class UnsafePathError extends BfsError {
  readonly entryPath: string;
  constructor(entryPath: string, reason: string) {
    super(`Unsafe path in backup (${reason}): ${JSON.stringify(entryPath)}`);
    this.name = 'UnsafePathError';
    this.entryPath = entryPath;
  }
}

/**
 * Thrown by push() when one or more source files could not be read.
 * The partially-built blob is saved to cachePath so the user can resume
 * with `bfs push --cache` without re-packing.
 */
export class PushSkippedError extends BfsError {
  readonly skipped: SkippedFile[];
  readonly cachePath: string;
  constructor(skipped: SkippedFile[], cachePath: string) {
    super(`${skipped.length} file(s) could not be read and were excluded from the blob.`);
    this.name = 'PushSkippedError';
    this.skipped = skipped;
    this.cachePath = cachePath;
  }
}

/**
 * Thrown by push() (non-interactive, without --allow-drift) when the source
 * directory changed during packing — one or more files were modified, removed,
 * or appeared inside the pack window. The blob is fully restorable; this signals
 * that it is not current with the directory. Carries the per-file drift breakdown.
 */
export class PushDriftError extends BfsError {
  readonly drift: CatalogDrift;
  constructor(drift: CatalogDrift) {
    const count = drift.changed.length + drift.vanished.length + drift.appeared.length;
    super(`${count} file(s) changed on disk during packing; the backup is restorable but not current.`);
    this.name = 'PushDriftError';
    this.drift = drift;
  }
}

/**
 * Thrown by pull() when one or more files could not be written to disk.
 * The decoded blob is saved to cachePath so the user can resume
 * with `bfs pull --cache` after fixing permissions.
 */
export class PullSkippedError extends BfsError {
  readonly skipped: SkippedFile[];
  readonly cachePath: string;
  constructor(skipped: SkippedFile[], cachePath: string) {
    super(`${skipped.length} file(s) could not be written to disk.`);
    this.name = 'PullSkippedError';
    this.skipped = skipped;
    this.cachePath = cachePath;
  }
}

/** Thrown when another live BFS operation already holds a lockfile for this vault. */
export class LockConcurrentActiveError extends BfsError {
  readonly operation: 'push' | 'repair';
  readonly pid: number;
  readonly started_at: string;
  constructor(operation: 'push' | 'repair', pid: number, started_at: string) {
    super(`another ${operation} operation is in progress (PID ${pid}, started ${started_at})`);
    this.name = 'LockConcurrentActiveError';
    this.operation = operation;
    this.pid = pid;
    this.started_at = started_at;
  }
}

/**
 * Thrown when push detects a leftover push.lock from a crashed/dead operation.
 * The vault is in partial state — user must `bfs repair --rebuild` (PR2) or
 * `bfs clear` to discard.
 */
export class LockPartialStatePushError extends BfsError {
  readonly version: number;
  constructor(version: number) {
    super(`push.lock exists from partial-state push of version ${version}; run \`bfs repair --version ${version} ... --rebuild\` or \`bfs clear\` to discard`);
    this.name = 'LockPartialStatePushError';
    this.version = version;
  }
}

/** Thrown when `bfs push --cache` is invoked without both push.lock and cache blob present. */
export class PushCacheNoLockError extends BfsError {
  readonly missing: string[];
  constructor(missing: string[]) {
    super(`\`--cache\` requires both .bfs/push.lock and cached blob; missing: ${missing.join(', ')}`);
    this.name = 'PushCacheNoLockError';
    this.missing = missing;
  }
}

/**
 * Thrown when `bfs push --cache` is invoked and the lock records
 * `blob_pending_path: null`. Distinct from PushCacheNoLockError (which
 * reports a missing file); this signals that the lock itself disowns the
 * cache, so resume is impossible and `bfs clear` is the only recovery.
 */
export class PushCacheUnavailableError extends BfsError {
  constructor() {
    super('`push.lock` indicates the cached blob was not persisted; run `bfs clear` to discard the leftover state');
    this.name = 'PushCacheUnavailableError';
  }
}
