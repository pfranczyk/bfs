import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { ProviderError } from '../core/errors.js';
import { isEnoent } from '../core/fs-utils.js';
import { hashBuffer } from '../core/hash.js';
import { computeShardHeaderSize } from '../core/shard-io.js';
import type {
  ProviderConfig,
  ProviderIO,
  RemoteRef,
  StorageProvider,
} from '../types/index.js';
import { registerProvider } from './provider.js';

const CHECKSUM_SIZE = 32;

/**
 * StorageProvider backed by the local filesystem (disk, USB, mounted folder).
 *
 * Directory layout:
 *   {config.path}/{vault_name}/{filename}
 *
 * The provider is configured via ProviderConfig.config.path (base directory).
 * Call setVaultName() before any upload/download/list operations.
 */
export class LocalFsProvider implements StorageProvider {
  readonly id: string;
  readonly type = 'local';

  private readonly basePath: string;
  private readonly io: ProviderIO;
  private vaultName: string | null = null;

  constructor(config: ProviderConfig, io: ProviderIO) {
    this.id = config.id;
    this.io = io;
    const p = config.config.path;
    if (typeof p !== 'string' || p.length === 0) {
      throw new ProviderError(
        'LocalFsProvider requires config.path to be a non-empty string',
      );
    }
    this.basePath = p;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Returns the full vault directory path: {basePath}/{vaultName}.
   * @throws ProviderError if setVaultName() has not been called yet.
   */
  private vaultDir(): string {
    if (this.vaultName === null) {
      throw new ProviderError(
        'setVaultName() must be called before any file operation',
      );
    }
    return path.join(this.basePath, this.vaultName);
  }

  /**
   * Resolves a full filesystem path from a RemoteRef.
   * The ref.path is the bare filename (e.g. "shard_0.bfs.1") stored under vaultDir().
   */
  private refToPath(ref: RemoteRef): string {
    return path.join(this.vaultDir(), ref.path);
  }

  // ─── StorageProvider interface ────────────────────────────────────────────

  /**
   * Verifies that basePath exists and is writable.
   * If it does not exist, asks the user via io.confirm() whether to create it.
   *
   * @throws ProviderError if the path is not accessible or creation is refused/fails.
   */
  async authenticate(): Promise<void> {
    let exists = true;
    try {
      await fs.access(this.basePath, fs.constants.F_OK);
    } catch {
      exists = false;
    }

    if (!exists) {
      const create = await this.io.confirm(
        `Path "${this.basePath}" does not exist. Create it?`,
      );
      if (!create) {
        throw new ProviderError(
          `Path "${this.basePath}" does not exist and creation was refused`,
        );
      }
      try {
        await fs.mkdir(this.basePath, { recursive: true });
      } catch (err) {
        throw new ProviderError(
          `Failed to create directory "${this.basePath}": ${String(err)}`,
        );
      }
      return;
    }

    try {
      await fs.access(this.basePath, fs.constants.W_OK);
    } catch {
      throw new ProviderError(`Path "${this.basePath}" is not writable`);
    }
  }

  /**
   * Sets the vault sub-directory name. Must be called before any file operations.
   *
   * @param name - Vault name (used as subdirectory under basePath)
   */
  setVaultName(name: string): void {
    this.vaultName = name;
  }

  /**
   * Uploads a shard file to {basePath}/{vaultName}/{shardFilename}.
   * Creates the vault directory if it does not exist.
   *
   * @param shardFilename - Target filename, e.g. "shard_0.bfs.1"
   * @param data          - Full shard binary (header + payload + checksum)
   * @returns RemoteRef with the provider_id and the shard filename as path
   * @throws ProviderError on write failure
   */
  async upload(shardFilename: string, data: Buffer): Promise<RemoteRef> {
    const dir = this.vaultDir();
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new ProviderError(
        `Failed to create vault directory "${dir}": ${String(err)}`,
      );
    }

    const filePath = path.join(dir, shardFilename);
    try {
      await fs.writeFile(filePath, data);
    } catch (err) {
      throw new ProviderError(
        `Failed to write shard "${filePath}": ${String(err)}`,
      );
    }

    return {
      provider_id: this.id,
      path: shardFilename,
      hash: hashBuffer(data),
    };
  }

  /**
   * Downloads a shard file identified by ref.
   *
   * @param ref - RemoteRef returned by upload() or list()
   * @returns   Full shard binary
   * @throws ProviderError if the file cannot be read
   */
  async download(ref: RemoteRef): Promise<Buffer> {
    const filePath = this.refToPath(ref);
    try {
      return await fs.readFile(filePath);
    } catch (err) {
      throw new ProviderError(
        `Failed to read shard "${filePath}": ${String(err)}`,
      );
    }
  }

  /**
   * Deletes a shard file identified by ref.
   *
   * @param ref - RemoteRef of the shard to delete
   * @throws ProviderError if the file cannot be deleted
   */
  async delete(ref: RemoteRef): Promise<void> {
    const filePath = this.refToPath(ref);
    try {
      await fs.unlink(filePath);
    } catch (err) {
      throw new ProviderError(
        `Failed to delete shard "${filePath}": ${String(err)}`,
      );
    }
  }

  /**
   * Renames a shard file (used in overwrite mode: upload .tmp → delete old → rename .tmp).
   *
   * @param ref         - RemoteRef of the existing file
   * @param newFilename - New bare filename (not full path)
   * @returns New RemoteRef pointing to the renamed file
   * @throws ProviderError on failure
   */
  async rename(ref: RemoteRef, newFilename: string): Promise<RemoteRef> {
    const oldPath = this.refToPath(ref);
    const newPath = path.join(this.vaultDir(), newFilename);
    try {
      await fs.rename(oldPath, newPath);
    } catch (err) {
      throw new ProviderError(
        `Failed to rename "${oldPath}" → "${newPath}": ${String(err)}`,
      );
    }
    return { provider_id: this.id, path: newFilename };
  }

  /**
   * Replaces the binary header of an existing shard in-place, keeping the RS payload
   * unchanged and recomputing the trailing SHA-256 checksum.
   *
   * Strategy: full atomic rewrite via a .tmp file.
   *   1. Read the existing shard.
   *   2. Extract the payload (everything after the current header, before the 32-byte checksum).
   *   3. Write: newHeaderData + payload + SHA-256(newHeaderData + payload) → .tmp file.
   *   4. Rename .tmp → original path.
   *
   * The payload boundary is derived from the length of headerData (the caller passes the
   * complete serialized header from magic to end of location map).
   *
   * @param ref        - RemoteRef of the shard to update
   * @param headerData - New serialized header (magic … end of location map, no payload/checksum)
   * @returns Updated RemoteRef (same path, no hash — caller should re-verify if needed)
   * @throws ProviderError on read/write failure
   * @throws ProviderError if the existing shard is too short to contain a valid payload
   */
  async updateShardHeader(
    ref: RemoteRef,
    headerData: Buffer,
  ): Promise<RemoteRef> {
    const filePath = this.refToPath(ref);

    let existing: Buffer;
    try {
      existing = await fs.readFile(filePath);
    } catch (err) {
      throw new ProviderError(
        `Failed to read shard for header update "${filePath}": ${String(err)}`,
      );
    }

    // The existing shard layout: [old header][payload][32-byte checksum]
    // Compute old header size by walking the binary layout so we can extract
    // the payload even when the new header has a different length (e.g. shorter
    // location map after a heal operation).
    const oldHeaderSize = computeShardHeaderSize(existing);

    if (existing.length < oldHeaderSize + CHECKSUM_SIZE) {
      throw new ProviderError(
        `Shard "${filePath}" is too short to contain a valid payload after the header`,
      );
    }

    const payload = existing.subarray(
      oldHeaderSize,
      existing.length - CHECKSUM_SIZE,
    );
    const newBody = Buffer.concat([headerData, payload]);
    const newChecksum = Buffer.from(hashBuffer(newBody), 'hex');
    const newShard = Buffer.concat([newBody, newChecksum]);

    const tmpPath = `${filePath}.tmp`;
    try {
      await fs.writeFile(tmpPath, newShard);
      await fs.rename(tmpPath, filePath);
    } catch (err) {
      // Best-effort cleanup of the .tmp file
      await fs.unlink(tmpPath).catch(() => {});
      throw new ProviderError(
        `Failed to update shard header "${filePath}": ${String(err)}`,
      );
    }

    return { provider_id: this.id, path: ref.path };
  }

  /**
   * Lists shard files in the vault directory, optionally filtered by a filename prefix.
   *
   * @param prefix - Optional filename prefix filter (e.g. "shard_0")
   * @returns Array of RemoteRef (hash not populated — full read required for hash)
   * @throws ProviderError if the directory cannot be read
   */
  async list(prefix?: string): Promise<RemoteRef[]> {
    const dir = this.vaultDir();
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err: unknown) {
      if (isEnoent(err)) return []; // directory doesn't exist yet
      throw new ProviderError(
        `Failed to list vault directory "${dir}": ${String(err)}`,
      );
    }

    const filtered = prefix
      ? entries.filter((e) => e.startsWith(prefix))
      : entries;
    return filtered.map((filename) => ({
      provider_id: this.id,
      path: filename,
    }));
  }

  /**
   * Lists vault sub-directories under basePath.
   * Each subdirectory corresponds to one vault stored on this provider.
   *
   * @returns Array of vault names (directory names)
   * @throws ProviderError if basePath cannot be read
   */
  async listVaults(): Promise<string[]> {
    let entries: Dirent[];
    try {
      entries = await fs.readdir(this.basePath, { withFileTypes: true });
    } catch (err: unknown) {
      if (isEnoent(err)) return [];
      throw new ProviderError(
        `Failed to list vaults in "${this.basePath}": ${String(err)}`,
      );
    }
    return entries.filter((e) => e.isDirectory()).map((e) => e.name);
  }

  /**
   * Checks whether the basePath is accessible (existence + read access).
   *
   * @returns true if accessible, false otherwise
   */
  async healthCheck(): Promise<boolean> {
    try {
      await fs.access(this.basePath, fs.constants.F_OK | fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
}

// Register this provider in the global registry so createProvider("local", ...) works.
registerProvider('local', (config, io) => new LocalFsProvider(config, io));
