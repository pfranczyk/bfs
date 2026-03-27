/** A file that was skipped during pack (unreadable) or unpack (unwritable). */
export interface SkippedFile {
  /** Relative path of the file (in rootDir for push; in blob for pull). */
  path: string;
  /** Human-readable reason (Node.js error message). */
  reason: string;
}

/** Base error class for all BFS-specific errors. */
export class BfsError extends Error {
  constructor(message: string) {
    super(message);
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
  constructor(message: string) {
    super(message);
    this.name = 'ProviderError';
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
 * Thrown by push() when one or more source files could not be read.
 * The partially-built blob is saved to cachePath so the user can resume
 * with `bfs push --cache` without re-packing.
 */
export class PushSkippedError extends BfsError {
  readonly skipped: SkippedFile[];
  readonly cachePath: string;
  constructor(skipped: SkippedFile[], cachePath: string) {
    super(
      `${skipped.length} file(s) could not be read and were excluded from the blob.`,
    );
    this.name = 'PushSkippedError';
    this.skipped = skipped;
    this.cachePath = cachePath;
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
