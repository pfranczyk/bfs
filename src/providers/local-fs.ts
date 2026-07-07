import { createHash } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { createReadStream, createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Readable, TransformCallback } from 'node:stream';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ProviderError, ShardCorruptedError } from '../core/errors.js';
import { assertSafeVaultName, isEnoent } from '../core/fs-utils.js';
import { hashBuffer, SHA256_BYTES } from '../core/hash.js';
import { computeShardHeaderSize, readShardHeader, sidecarFilename } from '../core/shard-io.js';
import { fmt, fmtFor, t, tFor } from '../i18n/index.js';
import type { CliProviderInput, ProviderConfig, ProviderHelp, ProviderIO, RemoteRef, ShardHeader, ShardIdentity, StorageProvider, VerifyShardResult } from '../types/index.js';
import { findStringFlag, readJsonObjectFile } from './flags.js';
import { finishVerifyShard } from './header-verify.js';
import { type ProviderFactory, providerRegistry } from './provider.js';

const CHECKSUM_SIZE = SHA256_BYTES;

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
  private vaultName: Nullable<string> = null;

  constructor(config: ProviderConfig, io: ProviderIO) {
    // Lazy init — an incomplete config is allowed so CLI can construct a
    // placeholder instance and call configureInteractive/configureFromFlags
    // on it before persisting. Structural validation happens in
    // validateConfig(); runtime checks happen in the actual operation.
    this.id = config.id;
    this.io = io;
    const p = config.config.path;
    this.basePath = typeof p === 'string' ? p : '';
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Returns the full vault directory path: {basePath}/{vaultName}.
   * @throws ProviderError if setVaultName() has not been called yet.
   */
  private vaultDir(): string {
    if (this.vaultName === null) {
      throw new ProviderError('setVaultName() must be called before any file operation');
    }
    assertSafeVaultName(this.vaultName);
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
      const create = await this.io.confirm(fmt('provider_local_path_not_exist_confirm', this.basePath));
      if (!create) {
        throw new ProviderError(fmt('provider_local_path_not_exist_error', this.basePath));
      }
      try {
        await fs.mkdir(this.basePath, { recursive: true });
      } catch (err) {
        throw new ProviderError(`Failed to create directory "${this.basePath}": ${String(err)}`);
      }
      return;
    }

    try {
      await fs.access(this.basePath, fs.constants.W_OK);
    } catch {
      throw new ProviderError(fmt('provider_local_path_not_writable', this.basePath));
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
   * Uploads a shard stream to {basePath}/{vaultName}/{shardFilename}.
   * Creates the vault directory if it does not exist.
   * Hash is computed incrementally during the stream write.
   *
   * @param shardFilename - Target filename, e.g. "shard_0.bfs.1"
   * @param data          - Readable stream of the full shard (header + payload + checksum)
   * @param _size         - Total byte size (unused by LocalFs, required by StorageProvider interface)
   * @returns RemoteRef with the provider_id, shard filename, and SHA-256 hash
   * @throws ProviderError on write failure
   */
  async upload(shardFilename: string, data: Readable, _size: number): Promise<RemoteRef> {
    const dir = this.vaultDir();
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new ProviderError(`Failed to create vault directory "${dir}": ${String(err)}`);
    }

    const filePath = path.join(dir, shardFilename);
    const hasher = createHash('sha256');
    const hashTransform = new Transform({
      transform(chunk: Buffer | Uint8Array, _enc: string, cb: TransformCallback) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        hasher.update(buf);
        cb(null, buf);
      },
    });

    try {
      await pipeline(data, hashTransform, createWriteStream(filePath));
    } catch (err) {
      throw new ProviderError(`Failed to write shard "${filePath}": ${String(err)}`);
    }

    // A fresh shard carries a fresh in-shard header, so a stale sidecar for this
    // filename (from a prior relocate) must go — else it would shadow the new
    // header on the sidecar-aware read-path.
    await fs.unlink(path.join(dir, sidecarFilename(shardFilename))).catch(() => {});

    return { provider_id: this.id, path: shardFilename, hash: hasher.digest('hex') };
  }

  /**
   * Downloads a shard as a Readable stream.
   *
   * @param ref - RemoteRef returned by upload() or list()
   * @returns   Readable stream of the full shard binary
   * @throws ProviderError if the file is not accessible
   */
  async download(ref: RemoteRef): Promise<Readable> {
    const filePath = this.refToPath(ref);
    try {
      await fs.access(filePath, fs.constants.R_OK);
    } catch (err) {
      throw new ProviderError(`Failed to read shard "${filePath}": ${String(err)}`);
    }
    return createReadStream(filePath);
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
      throw new ProviderError(`Failed to delete shard "${filePath}": ${String(err)}`);
    }
    // Remove the header sidecar too so pruning leaves no orphan behind.
    await fs.unlink(path.join(this.vaultDir(), sidecarFilename(ref.path))).catch(() => {});
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
      throw new ProviderError(`Failed to rename "${oldPath}" → "${newPath}": ${String(err)}`);
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
  async updateShardHeader(ref: RemoteRef, headerData: Buffer): Promise<RemoteRef> {
    const filePath = this.refToPath(ref);

    let existing: Buffer;
    try {
      existing = await fs.readFile(filePath);
    } catch (err) {
      throw new ProviderError(`Failed to read shard for header update "${filePath}": ${String(err)}`);
    }

    // The existing shard layout: [old header][payload][32-byte checksum]
    // Compute old header size by walking the binary layout so we can extract
    // the payload even when the new header has a different length (e.g. shorter
    // location map after a heal operation).
    const oldHeaderSize = computeShardHeaderSize(existing);

    if (existing.length < oldHeaderSize + CHECKSUM_SIZE) {
      throw new ProviderError(fmtFor(this.io.lang, 'provider_short_shard', filePath));
    }

    const payload = existing.subarray(oldHeaderSize, existing.length - CHECKSUM_SIZE);
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
      throw new ProviderError(`Failed to update shard header "${filePath}": ${String(err)}`);
    }

    return { provider_id: this.id, path: ref.path };
  }

  /**
   * Returns the size of a shard via `fs.stat()` — no content read.
   *
   * @param ref - RemoteRef of the shard
   * @returns   Size in bytes
   * @throws ProviderError if the file is missing or stat fails
   */
  async getSize(ref: RemoteRef): Promise<number> {
    const filePath = this.refToPath(ref);
    try {
      const st = await fs.stat(filePath);
      return st.size;
    } catch (err) {
      throw new ProviderError(fmtFor(this.io.lang, 'provider_stat_failed', filePath, String(err)));
    }
  }

  /**
   * Reads at most `maxBytes` bytes from the start of the shard via
   * `createReadStream({ start: 0, end: maxBytes - 1 })` — enough to read just
   * the header (~16 KB) without buffering the full payload.
   *
   * @param ref      - RemoteRef of the shard
   * @param maxBytes - Maximum byte count to return (must be > 0)
   * @returns          Buffer of `min(file_size, maxBytes)` bytes
   * @throws ProviderError on read failure or missing shard
   */
  async downloadHeader(ref: RemoteRef, maxBytes: number): Promise<Buffer> {
    const lang = this.io.lang;
    if (maxBytes <= 0) {
      throw new ProviderError(fmtFor(lang, 'provider_download_header_invalid_max_bytes', String(maxBytes)));
    }
    const filePath = this.refToPath(ref);
    try {
      await fs.access(filePath, fs.constants.R_OK);
    } catch (err) {
      throw new ProviderError(fmtFor(lang, 'local_read_shard_failed', filePath, String(err)), { cause: err });
    }
    return new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      const stream = createReadStream(filePath, { start: 0, end: maxBytes - 1 });
      stream.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
      });
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', (err) => reject(new ProviderError(fmtFor(lang, 'provider_header_read_failed', filePath, String(err)), { cause: err })));
    });
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
      throw new ProviderError(`Failed to list vault directory "${dir}": ${String(err)}`);
    }

    const filtered = prefix ? entries.filter((e) => e.startsWith(prefix)) : entries;
    return filtered.map((filename) => ({ provider_id: this.id, path: filename }));
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
      throw new ProviderError(`Failed to list vaults in "${this.basePath}": ${String(err)}`);
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

  // ─── Header storage strategy + verification ───────────────────────────────

  /** LocalFS keeps a relocated shard's header in an `hdr_` sidecar next to it. */
  usesSidecar(): boolean {
    return true;
  }

  /**
   * Writes the header sidecar (BFSH bytes) to `hdr_i.bfs.V` next to the shard,
   * atomically (.tmp + rename), replacing any previous sidecar.
   *
   * @param ref          - RemoteRef of the shard the sidecar belongs to
   * @param sidecarBytes - Sidecar payload in BFSH format (see buildSidecarBytes)
   * @throws ProviderError on write failure
   */
  async uploadHeaderSidecar(ref: RemoteRef, sidecarBytes: Buffer): Promise<void> {
    const dir = this.vaultDir();
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (err) {
      throw new ProviderError(`Failed to create vault directory "${dir}": ${String(err)}`);
    }
    const sidecarPath = path.join(dir, sidecarFilename(ref.path));
    const tmpPath = `${sidecarPath}.tmp`;
    try {
      await fs.writeFile(tmpPath, sidecarBytes);
      await fs.rename(tmpPath, sidecarPath);
    } catch (err) {
      await fs.unlink(tmpPath).catch(() => {});
      throw new ProviderError(`Failed to write header sidecar "${sidecarPath}": ${String(err)}`);
    }
  }

  /**
   * Reads the header sidecar `hdr_i.bfs.V` next to the shard, or null when none
   * exists yet. A sidecar is header-only, so it is read in full (bounded by its
   * own size, not the payload).
   *
   * @param ref       - RemoteRef of the shard
   * @param _maxBytes - Byte cap (a sidecar is inherently small; the whole file is read)
   * @returns Sidecar bytes (BFSH format) or null when absent
   * @throws ProviderError on a read failure other than "not found"
   */
  async downloadHeaderSidecar(ref: RemoteRef, _maxBytes: number): Promise<Buffer | null> {
    const sidecarPath = path.join(this.vaultDir(), sidecarFilename(ref.path));
    try {
      return await fs.readFile(sidecarPath);
    } catch (err) {
      if (isEnoent(err)) return null;
      throw new ProviderError(`Failed to read header sidecar "${sidecarPath}": ${String(err)}`);
    }
  }

  /**
   * Verifies the shard identity by reading only its header window and comparing
   * the plaintext vault_id / shard_index / version.
   *
   * @param ref      - RemoteRef of the shard
   * @param expected - Identity the shard is expected to carry
   * @returns { ok: true } or a classified failure (not_found / corrupted / mismatch / unverifiable)
   */
  async verifyShard(ref: RemoteRef, expected: ShardIdentity): Promise<VerifyShardResult> {
    const lang = this.io.lang;
    let header: ShardHeader;
    try {
      header = await readShardHeader(this, ref);
    } catch (err) {
      if (err instanceof ShardCorruptedError) {
        return { ok: false, reason: 'corrupted', detail: fmtFor(lang, 'verify_shard_corrupted', ref.path, err.message) };
      }
      // Classify from the read failure itself, not a second stat (no TOCTOU
      // window). downloadHeader wraps the fs error in a ProviderError but keeps
      // the original as `cause`, so ENOENT — whether raw or wrapped — means the
      // shard is gone; anything else (permissions, I/O) means present-but-unreadable.
      const cause = err instanceof Error ? err.cause : undefined;
      return isEnoent(err) || isEnoent(cause)
        ? { ok: false, reason: 'not_found', detail: fmtFor(lang, 'verify_shard_not_found', ref.path) }
        : { ok: false, reason: 'unverifiable', detail: fmtFor(lang, 'verify_shard_unverifiable', this.id, ref.path) };
    }
    return finishVerifyShard(header, expected, lang);
  }

  // ─── Configuration lifecycle ──────────────────────────────────────────────

  /**
   * Interactively prompts for the base directory path via ProviderIO.
   * Retries on empty input, non-directory, or non-existent path — surfaces
   * the reason via `io.warn()` so the user understands why the prompt
   * re-asked.
   * @returns config fragment `{ path }` to persist in VaultConfig
   */
  async configureInteractive(io: ProviderIO): Promise<Record<string, unknown>> {
    for (;;) {
      const basePath = (await io.ask(t('local_path_prompt'))).trim();
      if (basePath.length === 0) {
        io.warn(t('path_required'));
        continue;
      }
      try {
        const stat = await fs.stat(basePath);
        if (!stat.isDirectory()) {
          io.warn(t('path_not_dir'));
          continue;
        }
      } catch {
        io.warn(fmt('dir_not_exist', basePath));
        continue;
      }
      return { path: basePath };
    }
  }

  /**
   * Builds a config fragment from the BFS CLI pass-through input. Three
   * grammars are accepted, in priority order:
   *
   *   1. `--path <path>` — inline. Absolute paths used verbatim; relative
   *      paths resolve against `io.workDir`. Wins over `--config-file`.
   *   2. `--config-file <path>` — JSON `{ "path": "<absolute>" }`.
   *   3. neither — defaults to `~/.bfs-local/<name>/`.
   *
   * Empty-string values from the shell (e.g. `--path ""`) are treated as
   * absent so scripts can safely forward an unset variable.
   *
   * @throws ProviderError when the JSON file is unreadable, malformed, or
   *         lacks a non-empty `path` field
   */
  async configureFromFlags(input: CliProviderInput): Promise<Record<string, unknown>> {
    const inlinePath = findStringFlag(input.rawArgs, '--path');
    if (inlinePath !== null && inlinePath.length > 0) {
      const resolved = path.isAbsolute(inlinePath) ? inlinePath : path.resolve(this.io.workDir, inlinePath);
      return { path: resolved };
    }

    const rawFlag = findStringFlag(input.rawArgs, '--config-file');
    if (rawFlag === null || rawFlag.length === 0) {
      return { path: path.join(os.homedir(), '.bfs-local', input.name) };
    }
    const absolutePath = path.isAbsolute(rawFlag) ? rawFlag : path.resolve(this.io.workDir, rawFlag);
    const obj = await readJsonObjectFile(absolutePath, 'Local adapter');
    const p = typeof obj.path === 'string' ? obj.path : '';
    if (p.length === 0) {
      throw new ProviderError(tFor(this.io.lang, 'local_config_path_missing'));
    }
    return { path: p };
  }

  /**
   * Structural validation: `path` must be a non-empty string.
   * Runtime checks (exists, writable) happen in probeConnection().
   */
  validateConfig(config: Record<string, unknown>): string[] {
    const errors: string[] = [];
    const p = config.path;
    if (typeof p !== 'string' || p.length === 0) {
      errors.push(tFor(this.io.lang, 'local_validate_path_required'));
    }
    return errors;
  }

  /** Renders a one-line summary of the config for display. */
  describeConfig(config: Record<string, unknown>): string {
    const p = typeof config.path === 'string' ? config.path : '';
    return fmtFor(this.io.lang, 'local_describe_config', p);
  }

  /** Local FS has no secrets. */
  getSecretFields(): readonly string[] {
    return [];
  }

  /**
   * Full write/read/compare/cleanup round-trip against the configured path.
   * Must be called after setVaultName() so the probe file lands in the
   * correct sub-dir.
   *
   * @throws ProviderError with a step context when any stage fails
   */
  async probeConnection(): Promise<void> {
    const lang = this.io.lang;
    if (this.basePath.length === 0) {
      throw new ProviderError(tFor(lang, 'local_probe_incomplete'));
    }
    const vaultDir = this.vaultDir();
    const nonce = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const probeName = `__bfs_probe_${nonce}.tmp`;
    const probePath = path.join(vaultDir, probeName);
    const probeData = Buffer.from(`bfs-probe-${nonce}`);

    try {
      await fs.mkdir(vaultDir, { recursive: true });
    } catch (err) {
      throw new ProviderError(fmtFor(lang, 'local_probe_step_mkdir', err instanceof Error ? err.message : String(err)));
    }

    try {
      await fs.writeFile(probePath, probeData);
    } catch (err) {
      throw new ProviderError(fmtFor(lang, 'local_probe_step_write', err instanceof Error ? err.message : String(err)));
    }

    let readBack: Buffer;
    try {
      readBack = await fs.readFile(probePath);
    } catch (err) {
      await fs.rm(probePath, { force: true }).catch(() => undefined);
      throw new ProviderError(fmtFor(lang, 'local_probe_step_read', err instanceof Error ? err.message : String(err)));
    }

    if (Buffer.compare(probeData, readBack) !== 0) {
      await fs.rm(probePath, { force: true }).catch(() => undefined);
      throw new ProviderError(tFor(lang, 'local_probe_step_compare_local'));
    }

    try {
      await fs.unlink(probePath);
    } catch (err) {
      throw new ProviderError(fmtFor(lang, 'local_probe_step_cleanup', err instanceof Error ? err.message : String(err)));
    }
  }
}

// ─── Factory + registry ──────────────────────────────────────────────────────

const localFsFactory: ProviderFactory = {
  lang: 'en',
  displayName: 'Local filesystem',
  requiresApiVersion: 2,
  create: (config, io) => new LocalFsProvider(config, io),
  help(): ProviderHelp {
    return {
      usage: '[--path <path> | --config-file <path>]',
      description: tFor(this.lang, 'local_help_description'),
      flags: [
        { flag: '--path <path>', description: tFor(this.lang, 'local_help_flag_path_desc') },
        { flag: '--config-file <path>', description: tFor(this.lang, 'local_help_flag_config_file_desc') },
      ],
      examples: [
        'bfs provider add --ci --name usb --type local --path /mnt/usb/backup',
        '',
        'bfs provider add --ci --name vol1 --type local --config-file ./usb.json',
        '# usb.json: { "path": "/mnt/usb/backup" }',
        '',
        'bfs provider add --ci --name default --type local',
        '# Uses ~/.bfs-local/default/ as base path',
      ],
    };
  },
};

providerRegistry.register('local', localFsFactory);
