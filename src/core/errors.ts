import type { CatalogDrift, ExcludedEntry } from '../types/index.js';

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

/**
 * Thrown when BFS cannot create or write one of its own scratch files - a parity
 * part during push, a downloaded part during pull. That is the local temp
 * volume refusing (full, unwritable, a name already taken), never the medium
 * the part comes from, and the two must not be confused: the fix for one is
 * `bfs config --temp-dir`, for the other a look at the storage. Names the
 * offending path and keeps the operating system's error as `cause`, so the
 * caller can name the directory and the errno survives.
 */
export class ScratchWriteError extends BfsError {
  constructor(path: string, cause: unknown) {
    super(`Cannot write scratch file ${path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.name = 'ScratchWriteError';
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

/**
 * Control-flow signal raised when the operator asks to return to the connection
 * prompts instead of deciding about a server identity they were shown. Refusing
 * an identity usually means "I aimed at the wrong server", not "I distrust this
 * one", and without a way back that mistake costs every field already entered.
 *
 * Absorbed by the configure entry point that offered the way back, so it never
 * reaches BFS-core or a command; it is deliberately NOT part of the public
 * adapter contract (`src/lib.ts`).
 */
export class ConfigureRestartRequested extends BfsError {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigureRestartRequested';
  }
}

/** Thrown when AES-GCM decryption fails (wrong key or corrupted ciphertext). */
export class DecryptionError extends BfsError {
  constructor(message: string) {
    super(message);
    this.name = 'DecryptionError';
  }
}

/**
 * Thrown by the write-path guards (init / provider add / push) when the target
 * location on a provider already holds a DIFFERENT backup of the same name - a
 * shard whose header carries a foreign vault_id, or (for a fresh `init`, which
 * has no vault_id yet) any shard at all in the freshly-named vault sub-directory.
 * Aborts before any upload so a second machine's backup never silently
 * overwrites the first machine's shards. Distinct from TamperDetectedError: this
 * is a configuration collision (two independent backups aimed at one location),
 * not an attack on shards we already claim to own.
 */
export class VaultCollisionError extends BfsError {
  readonly providerId: string;
  constructor(message: string, providerId: string) {
    super(message);
    this.name = 'VaultCollisionError';
    this.providerId = providerId;
  }
}

/** Thrown when `init` is asked to set up a backup in a directory that already describes one. */
export class VaultAlreadyInitializedError extends BfsError {
  constructor(message: string) {
    super(message);
    this.name = 'VaultAlreadyInitializedError';
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
 * Thrown when a blob entry's path is unsafe to write during unpack - absolute,
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
 * Thrown by push() (non-interactive, without --allow-excluded) when the source
 * directory contains entries that cannot be backed up - symbolic links or
 * special files (socket/FIFO/block/char device). Unlike unreadable files, this
 * is a permanent, by-design exclusion: the entry can never be represented in a
 * blob, so retrying is pointless. The user should add them to .bfsignore or pass
 * --allow-excluded to back up everything else. Carries the excluded entries for
 * reporting; the CLI maps it to exit code 3.
 */
export class PushExcludedError extends BfsError {
  readonly excluded: ExcludedEntry[];
  constructor(excluded: ExcludedEntry[]) {
    super(`${excluded.length} entr(y/ies) cannot be backed up (symbolic links or special files).`);
    this.name = 'PushExcludedError';
    this.excluded = excluded;
  }
}

/**
 * Thrown by push() (non-interactive, without --allow-drift) when the source
 * directory changed during packing - one or more files were modified, removed,
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
 * Thrown when a lockfile is present but carries no readable owner: the exclusive
 * create that reserves it returns before the JSON payload is written, so a peer
 * that just won the race is briefly visible as a zero-byte file. Both ways out
 * are executable in the state where this prints - retrying picks up the peer's
 * payload (or takes the file over once it is old enough to be abandoned), and
 * `bfs clear` discards it outright.
 */
export class LockReservationUnreadableError extends BfsError {
  readonly operation: 'push' | 'repair';
  constructor(operation: 'push' | 'repair') {
    super(`${operation}.lock is reserved but carries no readable owner yet - another ${operation} may be starting right now. Retry in a moment; if none is running, run \`bfs clear\` to discard the leftover.`);
    this.name = 'LockReservationUnreadableError';
    this.operation = operation;
  }
}

/**
 * Thrown when push detects a leftover push.lock from a crashed/dead operation.
 * The vault is in partial state - user must run `bfs repair --rebuild` or
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

/**
 * Thrown when `bfs push --cache` finds the cached blob's content no longer
 * matching the SHA-256 sealed at its end, or carrying a file table that will not
 * parse. Distinct from PushCacheNoLockError (a file that is absent) and
 * PushCacheUnavailableError (a cache the lock disowns): here the cache is a blob
 * that contradicts itself. Also distinct from a file that never became a blob at
 * all - no magic, or shorter than a header plus checksum - which is unfinished
 * packing and gets re-packed rather than refused. Uploading a self-contradicting
 * blob would seal every part over content that cannot be unpacked, so the backup
 * would read as healthy until the first restore.
 *
 * The advice is ordered, not a choice: the refusal leaves push.lock in place, so
 * a bare `bfs push` would stop on the leftover state (LockPartialStatePushError)
 * and send the operator to `bfs clear` anyway.
 */
export class PushCacheCorruptedError extends BfsError {
  readonly cachePath: string;
  constructor(cachePath: string) {
    super(
      `The cached backup data in ${cachePath} no longer matches its checksum - the file was damaged or left incomplete, so it cannot be uploaded. Run \`bfs clear\` to discard the leftover state, then \`bfs push\` to back up the directory again.`,
    );
    this.name = 'PushCacheCorruptedError';
    this.cachePath = cachePath;
  }
}
