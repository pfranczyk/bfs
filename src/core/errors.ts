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
