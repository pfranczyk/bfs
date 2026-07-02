import type { Readable } from 'node:stream';

import type { SkippedFile } from '../core/errors.js';
import type { PushLockFailedEntry } from '../vault/lockfile.js';

// ─── Enums ────────────────────────────────────────────────────

/** Bitfield constants for BlobHeader.flags (uint32 LE). */
export const BLOB_FLAGS = { ENCRYPTED: 0x01, COMPRESSED: 0x02 } as const;

/** Push behavior mode — what to do with the existing version. */
export enum PushMode {
  NewVersion = 'new_version',
  Overwrite = 'overwrite',
  Ask = 'ask',
}

/** Backup version health state, determined by verify. */
export enum VersionHealth {
  Healthy = 'healthy',
  Degraded = 'degraded',
  Damaged = 'damaged',
  Unknown = 'unknown',
}

// ─── Vault configuration (.bfs/config.json) ──────────────────

export interface VaultConfig {
  vault_id: string; // UUID v4
  vault_name: string; // vault name = subfolder on providers (required at init)
  version: number; // config format version (1)
  scheme: {
    data_shards: number; // N (min. 2)
    parity_shards: number; // K (min. 1)
  };
  // INVARIANT: providers.length === scheme.data_shards + scheme.parity_shards
  // Each provider holds exactly 1 shard per version.
  // Validated at init, push, provider-add, provider-remove.
  encryption: { enabled: boolean; algorithm: 'aes-256-gcm'; kdf: 'argon2id' };
  compression: { enabled: boolean; algorithm: 'deflate' };
  push_mode: PushMode;
  providers: ProviderConfig[];
  /** Overrides default .bfs/cache directory. Defaults to {rootDir}/.bfs/cache when null/absent. */
  cache_dir?: string | null;
  /** Overrides default os.tmpdir() for temporary files. Defaults to os.tmpdir() when null/absent. */
  temp_dir?: string | null;
  /** RAM limit for RS encoding (MB). null/undefined = auto (25% os.totalmem()). */
  max_ram_mb?: Nullable<number>;
}

export interface ProviderConfig {
  id: string; // user-assigned name from init/provider-add, e.g. "backup-firma", "dysk-usb"
  type: string; // "local" | "gdrive" | "onedrive" | "ftp" | "ssh" | "smb"
  /**
   * Full npm spec of the adapter package for external adapters (e.g.
   * "bfs-adapter-ssh@1.0.1" or "@corp/bfs-adapter-x@2.0.0"). null for
   * built-in providers (local, ftp) — they ship with BFS itself.
   *
   * Persisted in .bfs/config.json, manifest and shard header location map.
   * Recovery preflight reads this to tell the user which `npm install -g`
   * commands are needed to reconstruct a backup on a fresh machine.
   *
   * Backward compat: when parsing legacy data that lacks this field, it is
   * set to null. Legacy backups were always produced with built-in providers,
   * so null is the correct semantics for them.
   */
  adapterPackage: Nullable<string>;
  config: Record<string, unknown>; // type-specific config
}

// ─── Vault state (.bfs/state.json) ───────────────────────────

export interface VaultState {
  latest_version: number; // highest version present on providers (0 = no pushes)
  working_version: number; // version currently on disk (0 = no pull/push)
  // false after `bfs recovery` rebuilt the config from an untrusted location
  // map, until the first push/heal shows the operator the provider locations and
  // they confirm. Absent = legacy / never recovered = treated as confirmed.
  locations_confirmed?: boolean;
}

// ─── Version manifest (.bfs/manifests/vNNN.json) ─────────────
// Each version has its own manifest — a snapshot of the configuration at
// push time. This allows: different N/K schemes per version, different
// provider sets, jumping between versions without downloading shards.

export interface VersionManifest {
  version: number;
  pushed_at: Nullable<string>; // ISO 8601; null after recovery (filled in by next pull)
  file_count: Nullable<number>; // null after recovery (filled in by next pull)
  total_size: Nullable<number>; // bytes (directory size); null after recovery (filled in by next pull)
  blob_hash: string; // SHA-256 of blob before RS
  scheme: {
    data_shards: number; // N
    parity_shards: number; // K
  };
  encrypted: boolean;
  shards: ManifestShard[]; // 1..N+K entries (partial-committed versions hold fewer)
  health: VersionHealth; // push: healthy/degraded/damaged from uploaded vs N+K; recovery: degraded (until verify)
  // Streaming pipeline fields (FORMAT_VERSION=2 shards). Absent = legacy format.
  rs_striped?: boolean; // true = striped RS encoding (always for new pushes)
  rs_stripe_size?: number; // stripe size in bytes (only when rs_striped=true)
  encrypted_per_shard?: boolean; // true = encryption per shard (instead of per blob)
  /** true = data section is a ZIP file (BLOB_FLAGS.COMPRESSED bit set). */
  compressed?: boolean;
  /** Sum of uncompressed file sizes before compression (bytes). Present when compressed=true. */
  blob_size_uncompressed?: number;
}

export interface ManifestShard {
  shard_index: number;
  provider_id: string; // reference to a provider in config.json
  provider_type: string; // "local" | "gdrive" | "ftp" | "ssh" | ...
  remote_path: string; // path on the provider
  shard_hash: string; // SHA-256 of the shard PAYLOAD (RS data only, no header, no trailing checksum)
  // The payload is immutable — the header can change (heal, relocate)
  // but the RS data cannot. Hence the hash covers payload only.
}

// ─── Skip results ─────────────────────────────────────────────

export type { SkippedFile };

// ─── Catalog drift (blob ↔ directory currency) ────────────────

/** One file's identity in a catalog snapshot: byte size + rounded mtime. */
export interface CatalogSnapshotEntry {
  size: number;
  mtimeMs: number;
}

/** Relative path (forward-slash) → file identity, capturing a directory at one instant. */
export type CatalogSnapshot = Map<string, CatalogSnapshotEntry>;

/**
 * Files that diverged between two catalog snapshots bracketing the pack window.
 * Empty arrays mean the packed blob still matches the directory 1:1.
 */
export interface CatalogDrift {
  /** Present in both snapshots but size or mtime differs. */
  readonly changed: readonly string[];
  /** Present in the earlier snapshot, absent in the later one. */
  readonly vanished: readonly string[];
  /** Absent in the earlier snapshot, present in the later one. */
  readonly appeared: readonly string[];
}

/** Result returned by push() — successful, partial, or damaged. */
export interface PushResult {
  version: number;
  file_count: number;
  total_size: number;
  /** Files skipped due to read errors (non-empty only in REPL interactive mode when user accepted). */
  skipped: SkippedFile[];
  /** Count of shards uploaded successfully (manifest.shards.length). */
  uploaded_count: number;
  /** Shards whose upload failed; mirrors .bfs/push.lock.failed for callers that need detail without re-reading the lock. */
  failed: PushLockFailedEntry[];
  /** Healthy when uploaded_count === N+K; Degraded when >= N; Damaged when < N (and ≥ 1). */
  health: VersionHealth;
}

/** Options for push() — pack, encrypt, RS-encode, and upload to all providers. */
export interface PushOptions {
  /** Overrides config.push_mode. If absent, config.push_mode is used. */
  mode?: PushMode.NewVersion | PushMode.Overwrite;
  /**
   * Override compression for this push only.
   * true  = force compress (even if config.compression.enabled=false)
   * false = force skip compression (even if config.compression.enabled=true)
   * undefined = use config.compression.enabled
   */
  compressOverride?: boolean;
  /** Pre-provided encryption password (skips interactive prompt). */
  password?: string;
  /**
   * When true, loads the blob from `.bfs/cache/push.blob.pending` instead of re-packing.
   * Falls back to a fresh pack if the cache file does not exist.
   */
  fromCache?: boolean;
  /**
   * When true (REPL mode), prompts the user on skipped files instead of aborting.
   * Defaults to false (standalone CLI: abort with PushSkippedError).
   */
  interactive?: boolean;
  /**
   * When true, accepts a detected blob↔directory drift (files changed on disk
   * during packing) and proceeds with the upload. The blob stays fully
   * restorable regardless; the flag waives only currency, never recoverability.
   * When false/absent: interactive mode prompts, non-interactive mode throws
   * PushDriftError.
   */
  allowDrift?: boolean;
  /** Directory for temporary parity files during push. Defaults to cacheDir. */
  tempDir?: string;
  /** Overrides cache directory for push.blob.pending. Defaults to {rootDir}/.bfs/cache. */
  cacheDir?: string;
  /** Overrides config.max_ram_mb for this push operation. */
  maxRamMb?: number;
  io: ProviderIO;
}

/** Result returned by pull() on success. */
export interface PullResult {
  version: number;
  extracted: number;
  /** Files skipped due to write errors (non-empty only in REPL interactive mode when user accepted). */
  skipped: SkippedFile[];
}

// ─── Ignore filter ────────────────────────────────────────────

export type IgnoreFilter = (relativePath: string) => boolean;

// ─── BFS Blob — binary format ────────────────────────────────

export interface BlobHeader {
  magic: 'BFS\0'; // 4 bytes
  format_version: number; // 2 bytes (uint16, value: 1)
  vault_id: string; // 16 bytes (UUID as binary)
  flags: number; // 4 bytes (bitfield: bit 0 = encrypted, bit 1 = compressed)
  created_at: bigint; // 8 bytes (unix timestamp ms, uint64 LE)
  file_count: number; // 4 bytes (uint32)
  file_table_offset: bigint; // 8 bytes
  file_table_length: bigint; // 8 bytes
  data_offset: bigint; // 8 bytes
  data_length: bigint; // 8 bytes
}
// Total header size: 70 bytes

export interface FileEntry {
  path: string; // relative path (UTF-8, / separators)
  size: bigint; // 8 bytes
  data_offset: bigint; // offset into data section, 8 bytes
  hash: string; // SHA-256, 32 bytes
  mode: number; // permissions, 4 bytes
  modified_at: bigint; // unix timestamp ms, 8 bytes (uint64 LE)
}

// ─── Shard — binary format ───────────────────────────────────

export interface ShardHeader {
  magic: 'BFSS'; // 4 bytes
  format_version: number; // 2 bytes (uint16)
  vault_id: string; // 16 bytes (UUID binary)
  vault_name: string; // variable (length-prefixed)
  blob_size: bigint; // 8 bytes — size of the data fed into RS-encode
  // (post-encryption when enabled, plain blob otherwise)
  // Used to trim padding after RS-decode
  blob_hash: string; // 32 bytes — SHA-256 of the PLAIN blob (before encryption/RS)
  // Verified after RS-decode + decrypt
  data_shards: number; // 2 bytes (uint16)
  parity_shards: number; // 2 bytes (uint16)
  shard_index: number; // 2 bytes (uint16)
  version: number; // 4 bytes (uint32) — snapshot version number
  encrypted: boolean; // 1 byte
  kdf_salt: Nullable<Buffer>; // 16 bytes when encrypted=true, absent otherwise
  rs_stripe_size: Nullable<number>; // 4 bytes (uint32) — present when format_version >= 2; null for v1
  map_length: number; // 4 bytes (uint32)
  location_map: ShardLocation[]; // JSON (optionally AES-GCM encrypted)
}

export interface ShardLocation {
  shard_index: number;
  provider_id: string; // user-defined name, e.g. "NAS-basement", "FTP-ovh"
  provider_type: string;
  /**
   * Full npm spec of the adapter package for external providers (e.g.
   * "bfs-adapter-ssh@1.0.1"), null for built-in providers or for shards
   * serialized by BFS versions older than the adapterPackage field.
   */
  adapterPackage: Nullable<string>;
  // NOTE: connection_config stores only NON-SECRET connection coordinates
  // (host, port, user, path). Adapter-declared secret fields (FTP password,
  // SSH private key/passphrase) are stripped before the map is embedded —
  // see splitLocationSecrets in vault/location-map.ts. This matters because
  // when encrypted=false the location map is raw JSON inside the shard header,
  // so anyone holding a single shard reads every provider's coordinates. The
  // secret is supplied from the local config.json during normal use, or
  // interactively via ProviderIO.askSecret() during disaster recovery.
  connection_config: Record<string, unknown>;
  // Names of inputs this resource requires at connection time but that are NOT
  // stored here — stripped secrets the operator must supply during recovery.
  // [] = nothing required (e.g. anonymous FTP). null = shard written before
  // this field existed (legacy): the secret is still inline in connection_config,
  // so recovery uses it directly instead of prompting. The map parser
  // normalizes an absent field to null; builders (push/heal) always set an array.
  required_inputs: Nullable<string[]>;
  remote_path: string;
  shard_hash: string; // SHA-256 of the PAYLOAD (RS data, without the shard header)
}

// ─── Provider I/O — abstraction over user interaction ────────
// Providers do NOT touch the CLI directly. They receive ProviderIO via
// dependency injection. The same provider therefore works in the REPL, in
// the standalone CLI, and in a future GUI.
// In tests: a mock ProviderIO with predefined answers.

export interface ProviderIO {
  /**
   * Active user language (BCP-47 tag, e.g. 'en', 'pl').
   *
   * Informational-only — built-in providers ignore this because they use
   * the global `t()` translator. External plugin adapters may read it to
   * decide how (or whether) to localize their own prompts. BFS does NOT
   * prescribe a translation mechanism for plugins.
   */
  readonly lang: string;

  /**
   * Working directory of the BFS invocation (absolute). Mirrors the same
   * cwd BFS itself uses — i.e. respects `bfs --cwd <dir>` and falls back
   * to `process.cwd()` when the flag is absent. Provider is free to
   * resolve any relative path its own flags or prompts accept against
   * this value (typical: `path.resolve(io.workDir, userInput)`).
   *
   * Informational-only context — BFS never inspects what providers do
   * with it.
   */
  readonly workDir: string;

  ask(prompt: string): Promise<string>; // "Enter login:"
  askSecret(prompt: string): Promise<string>; // "Enter password:" (hidden)
  confirm(message: string): Promise<boolean>; // "Continue? [y/N]"
  choose(message: string, options: string[]): Promise<string>; // "Pick a directory:" → list
  info(message: string): void; // "Connecting to FTP..."
  /**
   * Diagnostic log emitted only when `bfs --debug` is active. Built-in
   * providers use it for connection chatter, retry attempts, and other
   * implementation noise that would pollute verify/push/pull output by
   * default. Output goes to stderr so stdout redirection stays clean.
   */
  debug(message: string): void;
  warn(message: string): void; // "Untrusted certificate"
  progress(label: string, percent: number): void; // progress bar
}

// ─── CLI Provider Input (pass-through) ───────────────────────
// BFS recognizes exactly two fields of a provider invocation: `type` (which
// selects the adapter) and `name` (the id). Every other CLI token flows
// verbatim to the provider as `rawArgs`. BFS does NOT look for
// `--config-file`, `--private-key`, `--bucket`, or any other flag — those
// belong to whatever grammar the adapter chooses to implement.
//
// The adapter interprets rawArgs however it documents in `help()`: its own
// commander subinstance, hand-written parsing, reading a file, fetching a
// URL, combining several flags, or ignoring them entirely. If the adapter
// needs a working directory to resolve relative paths, it reads
// `io.workDir`.

export interface CliProviderInput {
  /** Value of --name after trimming — non-empty; BFS validates before calling. */
  readonly name: string;

  /**
   * Every CLI token that followed `--ci`, `--name <value>` and `--type <value>`
   * on the command line, in the original order. BFS does NOT interpret them.
   *
   * Example for
   *   `bfs provider add --ci --name ssh1 --type ssh \
   *     --private-key /home/alice/.ssh/id_rsa --passphrase-env PASS`
   * rawArgs = ['--private-key', '/home/alice/.ssh/id_rsa',
   *            '--passphrase-env', 'PASS']
   *
   * For the `init --ci --provider "<type>:<name> [flags]"` grammar BFS
   * tokenizes the spec shell-style and puts every token after `type:name`
   * into rawArgs, unchanged.
   */
  readonly rawArgs: readonly string[];
}

// ─── Provider Help (structured) ──────────────────────────────
// Each provider factory exposes a structured help object. BFS renders
// these uniformly under `bfs provider -h` — adapters fill fields, not
// free-form text, so layout stays consistent across built-ins and plugins.

export interface ProviderHelpFlag {
  /** Flag as it appears on the CLI, e.g. "--private-key <path>". */
  readonly flag: string;
  /** One-line description shown next to the flag. */
  readonly description: string;
}

export interface ProviderHelp {
  /**
   * Suffix appended after `bfs provider add --name <name> --type <type>`.
   * Example: "--config-file <path>"
   * Example: "--host <h> --user <u> --private-key <path> [--port 22]"
   * Empty string when the provider takes no extra flags.
   */
  readonly usage: string;

  /** Multi-line human-readable description of the provider. */
  readonly description: string;

  /**
   * Provider-specific flags parsed from rawArgs, plus any note about
   * --config-file support. Empty array when the provider has no flags
   * beyond the fixed BFS four.
   */
  readonly flags: readonly ProviderHelpFlag[];

  /** Example invocations or config-file snippets. Rendered verbatim. */
  readonly examples: readonly string[];

  /**
   * Optional custom installation hint for external adapters. When absent
   * and the registry has adapter meta, BFS falls back to
   * "npm install -g <packageName>". Built-in providers leave undefined.
   */
  readonly installation?: string;
}

// ─── Adapter registration metadata ───────────────────────────
// External adapters MUST pass this when registering so BFS can persist
// `ProviderConfig.adapterPackage` as "<packageName>@<packageVersion>"
// for disaster-recovery reproducibility. Built-in providers omit it.

export interface AdapterRegistrationMeta {
  /** npm package name, e.g. "bfs-adapter-ssh" or "@corp/bfs-adapter-x". */
  readonly packageName: string;
  /** Package version from the adapter's own package.json (e.g. "1.0.1"). */
  readonly packageVersion: string;
}

// ─── Storage Provider ────────────────────────────────────────
// A provider operates in the context: {base_path}/{vault_name}/
// vault_name is supplied when the provider is initialized.
// ProviderIO is supplied at construction (factory/constructor).
//
// authenticate() logic:
//   1. Stored token/password && still valid → connect silently
//   2. Token expired && refresh token available → refresh silently
//   3. Nothing works → ProviderIO: "Session expired, enter password:"
// The user is not asked unnecessarily.

export interface StorageProvider {
  readonly id: string;
  readonly type: string;

  authenticate(): Promise<void>;
  setVaultName(name: string): void;
  /**
   * Uploads a shard to the provider as a stream.
   * @param shardFilename filename on the provider
   * @param data shard data stream (header + payload + checksum)
   * @param size total stream size in bytes (for Content-Length / pre-allocation)
   */
  upload(shardFilename: string, data: Readable, size: number): Promise<RemoteRef>;
  /**
   * Fetches a shard from the provider as a stream.
   * The caller reads it in chunks (header, payload, checksum).
   */
  download(ref: RemoteRef): Promise<Readable>;
  delete(ref: RemoteRef): Promise<void>;
  // rename — used in overwrite mode (push --overwrite):
  //   Upload the new shard as .tmp → delete the old one → rename .tmp to the final name.
  //   Providers without native rename (e.g. S3) implement this as copy + delete.
  rename(ref: RemoteRef, newFilename: string): Promise<RemoteRef>;
  // updateShardHeader — used by heal (provider-remove + heal):
  //   Updates the shard header after the location map changes.
  //   Result: the shard on the provider has a new header, the original payload,
  //   and a recomputed trailing checksum (SHA-256 of new header + payload).
  //   Implementation depends on the adapter (partial read, full rewrite, server-side, etc.)
  //   headerData is the fully serialized header
  //   (from magic to the end of the location map, without payload or checksum)
  updateShardHeader(ref: RemoteRef, headerData: Buffer): Promise<RemoteRef>;
  list(prefix?: string): Promise<RemoteRef[]>;
  /**
   * Returns the byte size of a shard on the remote without downloading it.
   * Implementations MUST use a lightweight metadata call:
   *   - LocalFS: `fs.stat(path).size`
   *   - FTP:     `client.size(remotePath)` (SIZE)
   *   - SFTP:    `sftp.stat(path).size`
   *   - S3/HTTP: HEAD / `Content-Length`
   * Used by `bfs verify` to detect truncated/corrupt shards without
   * pulling content, and by callers that need to preallocate buffers.
   * @throws ProviderError if the shard does not exist or stat fails.
   */
  getSize(ref: RemoteRef): Promise<number>;
  /**
   * Downloads only the first `maxBytes` bytes of a shard for header parsing.
   * Implementations SHOULD avoid pulling more than `maxBytes` over the wire
   * (FTP: ABOR after maxBytes; LocalFS: `createReadStream({ end: maxBytes-1 })`;
   * S3/HTTP: `Range` header). If the file is shorter than `maxBytes`, the
   * returned buffer contains the entire file. Used by `bfs recovery` to read
   * only the shard header (~16 KB) instead of the full multi-MB payload.
   * @throws ProviderError on transport failure or missing shard.
   */
  downloadHeader(ref: RemoteRef, maxBytes: number): Promise<Buffer>;
  listVaults(): Promise<string[]>;
  healthCheck(): Promise<boolean>;

  // ─── Configuration lifecycle ──────────────────────────────────────────────
  // Provider owns its own configuration flow. CLI/core code is blind to
  // provider-specific fields — it only calls these methods polymorphically.

  /**
   * Interactive configuration — provider prompts the user via ProviderIO.
   * Called by CLI when the user runs `bfs provider add <type>` without flags.
   * @returns config object to persist in VaultConfig.providers[].config
   * @throws BfsError on invalid input or user cancellation
   */
  configureInteractive(io: ProviderIO): Promise<Record<string, unknown>>;

  /**
   * Non-interactive configuration from the minimal BFS pass-through input.
   * Receives:
   *   - `name`    — value of --name (already validated non-empty)
   *   - `rawArgs` — every CLI token that followed `--ci`, `--name <v>` and
   *                 `--type <v>`, in the original order. BFS does NOT
   *                 inspect or interpret them.
   *
   * Provider defines its own grammar: may parse specific flags from
   * rawArgs, may read a file whose path came from a flag, may fetch a URL,
   * may require no flags at all. If the adapter needs a working directory
   * to resolve relative paths, it reads `io.workDir` (set by BFS to the
   * same cwd BFS itself uses).
   *
   * @returns config object to persist in VaultConfig.providers[].config
   * @throws ProviderError when the input cannot satisfy the provider
   */
  configureFromFlags(input: CliProviderInput): Promise<Record<string, unknown>>;

  /**
   * Validate a persisted config before use.
   * @returns array of human-readable errors; empty when valid
   */
  validateConfig(config: Record<string, unknown>): string[];

  /**
   * Render the config for display (e.g. `bfs provider list`).
   * Implementations MUST mask fields listed in getSecretFields().
   */
  describeConfig(config: Record<string, unknown>): string;

  /**
   * Config field names the adapter treats as secret (e.g. ['password']).
   * BFS strips their values from the shard location map and records the names
   * in ShardLocation.required_inputs, so disaster recovery knows what to ask
   * the operator for. describeConfig also masks these when rendering.
   */
  getSecretFields(): readonly string[];

  /**
   * Full read/write/verify round-trip against the configured remote.
   * Called after configureInteractive/configureFromFlags, BEFORE persisting
   * the provider to VaultConfig. Failure = no persist.
   * @throws ProviderError with step context (auth / ensureDir / upload / download / compare / delete)
   */
  probeConnection(): Promise<void>;

  // ─── Header storage strategy + verification ───────────────────────────────
  // Built-in providers (local, ftp) rewrite the header in place inside the
  // shard file. Providers whose medium cannot do an atomic in-file rewrite
  // (append-only object stores, APIs without partial writes) keep the updated
  // header in a separate sidecar file next to the shard. usesSidecar() tells
  // BFS which write-path and read-path to take.

  /**
   * Reports whether this provider stores an updated header in a sidecar file
   * instead of rewriting it in place inside the shard.
   *   - false → BFS calls updateShardHeader(); the sidecar methods are never
   *     called and MUST throw if invoked.
   *   - true  → BFS calls uploadHeaderSidecar() on write; the read-path fetches
   *     the sidecar first and, when present, it wins over the in-shard header.
   * @returns true when the provider keeps the header in a sidecar file
   */
  usesSidecar(): boolean;

  /**
   * Stores the header sidecar bytes (BFSH format) next to the shard, replacing
   * any previous sidecar atomically. Only called when usesSidecar() === true.
   * Like every write method, it MUST confirm the bytes landed on the medium
   * before resolving (download-back / ETag / metadata check).
   * @param ref          - RemoteRef of the shard the sidecar belongs to
   * @param sidecarBytes - Sidecar payload in BFSH format (see buildSidecarBytes)
   * @throws BfsError when usesSidecar() === false (contract violation)
   * @throws ProviderError when the bytes cannot be persisted
   */
  uploadHeaderSidecar(ref: RemoteRef, sidecarBytes: Buffer): Promise<void>;

  /**
   * Fetches the header sidecar (up to maxBytes) for a shard, or null when no
   * sidecar exists yet. Only called when usesSidecar() === true.
   * @param ref      - RemoteRef of the shard
   * @param maxBytes - Maximum byte count to return (must be > 0)
   * @returns          Sidecar bytes (BFSH format) or null when absent
   * @throws BfsError when usesSidecar() === false (contract violation)
   * @throws ProviderError on transport failure
   */
  downloadHeaderSidecar(ref: RemoteRef, maxBytes: number): Promise<Buffer | null>;

  /**
   * Checks whether the shard under `ref` has the expected identity (vault_id,
   * shard_index, version). The provider picks a strategy that fits its medium
   * (bounded header read, sidecar fetch, metadata API, full download). The
   * identity fields live in the plaintext part of the header, so no vault key
   * is needed. Returns a structured verdict rather than throwing for the
   * common, expected outcomes (missing / mismatched / unauthenticated).
   * @param ref      - RemoteRef of the shard to verify
   * @param expected - Identity the shard is expected to carry
   * @returns          { ok: true } or { ok: false, reason, detail }
   */
  verifyShard(ref: RemoteRef, expected: ShardIdentity): Promise<VerifyShardResult>;

  // ─── Recovery credential handling (optional) ────────────────
  /**
   * Recovery-only hook: connect to this provider during `bfs recovery`, owning
   * the entire credential interaction. The provider MUST show the operator the
   * connection target (host/endpoint) BEFORE collecting or reusing any secret —
   * BFS-core is blind to which config field is the destination vs the secret, so
   * only the provider can present a meaningful target (see
   * architecture/decisions.md → "Provider jest właścicielem sekretu i weryfikacji
   * celu"). It may reuse a secret from `pool` (collected for other providers,
   * each labelled with its origin) or collect a fresh one via io.askSecret, MUST
   * let the operator decline, then connect + authenticate.
   *
   * Optional: when a provider does not implement it, BFS falls back to prompting
   * for the location map's `required_inputs` via io.askSecret — the legacy path,
   * which cannot show the host and stays vulnerable to a redirected location map.
   *
   * @param io   - ProviderIO for showing the target and collecting the secret
   * @param pool - secrets already collected this recovery, offered for reuse
   * @param options.trustLocation - when true, the operator has pre-approved the
   *   recovered locations (unattended recovery, `bfs recovery --trust-locations`),
   *   so the provider connects WITHOUT blocking on a host confirmation. It may
   *   still surface the target for the log. Default/false: confirm before
   *   sending the secret. Interactive recovery — the 99% case — leaves it false.
   * @returns the secret to add to the pool (reusable across siblings), or null
   *          when the provider uses no reusable secret (anonymous / token)
   * @throws when the operator declines or the connection/authentication fails —
   *         BFS treats it as a degraded skip of this provider
   */
  connectForRecovery?(io: ProviderIO, pool: readonly RecoverySecret[], options?: { trustLocation?: boolean }): Promise<string | null>;
}

export interface RemoteRef {
  provider_id: string;
  path: string;
  hash?: string; // SHA-256 — available after upload(); list() may not return it (FTP, SSH)
}

/** Identity a shard must carry, used by StorageProvider.verifyShard(). */
export interface ShardIdentity {
  vault_id: string; // vault UUID — detects a foreign shard
  shard_index: number; // 0..N+K-1 — detects a wrong shard index
  version: number; // shard version — detects a wrong version
}

/**
 * A transport secret collected during recovery, labelled with the provider it
 * was first supplied for. BFS carries these between providers as a blind courier
 * (StorageProvider.connectForRecovery) — it never inspects the value.
 */
export interface RecoverySecret {
  readonly value: string;
  readonly origin: string; // provider id the secret was collected for
}

/**
 * Result of StorageProvider.verifyShard(). `ok: true` means the shard under
 * the ref carries the expected identity. Otherwise `reason` classifies the
 * failure and `detail` carries a human-readable explanation.
 */
export type VerifyShardResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        | 'not_found' // no file under ref
        | 'mismatch' // header parsed but identity differs
        | 'auth_failed' // provider could not authenticate
        | 'corrupted' // header does not parse (truncated / bad magic)
        | 'unverifiable'; // provider cannot verify on its medium
      detail: string;
    };

// ─── Heal operation options ───────────────────────────────────

export interface UpdateLocationMapsOptions {
  newLocationMap: ShardLocation[];
  io: ProviderIO;
  password?: string;
}

export interface RebuildVersionOptions {
  removedProviderId: string;
  targetProviderId: string;
  io: ProviderIO;
  password?: string;
}

export interface RebuildAllVersionsOptions {
  removedProviderId: string;
  targetProviderId: string;
  scope: number[] | 'all' | 'latest';
  io: ProviderIO;
  password?: string;
}

export interface RelocateProviderOptions {
  newConnectionConfig: Record<string, unknown>;
  io: ProviderIO;
  password?: string;
  newType?: string;
}
