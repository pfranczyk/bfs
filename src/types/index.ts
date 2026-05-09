import type { Readable } from 'node:stream';

import type { SkippedFile } from '../core/errors.js';

// ─── Enums ────────────────────────────────────────────────────

/** Bitfield constants for BlobHeader.flags (uint32 LE). */
export const BLOB_FLAGS = {
  ENCRYPTED: 0x01,
  COMPRESSED: 0x02,
} as const;

/** Tryb zachowania przy push — co robić z istniejącą wersją. */
export enum PushMode {
  NewVersion = 'new_version',
  Overwrite = 'overwrite',
  Ask = 'ask',
}

/** Stan zdrowia wersji backupu, ustalany przez verify. */
export enum VersionHealth {
  Healthy = 'healthy',
  Degraded = 'degraded',
  Damaged = 'damaged',
  Unknown = 'unknown',
}

// ─── Konfiguracja vaulta (.bfs/config.json) ──────────────────

export interface VaultConfig {
  vault_id: string; // UUID v4
  vault_name: string; // nazwa vaulta = podfolder na nośnikach (obowiązkowa przy init)
  version: number; // wersja formatu konfiguracji (1)
  scheme: {
    data_shards: number; // N (min. 2)
    parity_shards: number; // K (min. 1)
  };
  // INVARIANT: providers.length === scheme.data_shards + scheme.parity_shards
  // Każdy provider trzyma dokładnie 1 shard per wersja.
  // Walidowane przy init, push, provider-add, provider-remove.
  encryption: {
    enabled: boolean;
    algorithm: 'aes-256-gcm';
    kdf: 'argon2id';
  };
  compression: {
    enabled: boolean;
    algorithm: 'deflate';
  };
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
  id: string; // nazwa nadana przez usera przy init/provider-add, np. "backup-firma", "dysk-usb"
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

// ─── Stan vaulta (.bfs/state.json) ───────────────────────────

export interface VaultState {
  latest_version: number; // najwyższa wersja istniejąca na nośnikach (0 = brak pushów)
  working_version: number; // wersja aktualnie na dysku (0 = brak pull/push)
}

// ─── Manifest wersji (.bfs/manifests/vNNN.json) ─────────────
// Każda wersja ma osobny manifest — snapshot konfiguracji w momencie push.
// Umożliwia: różne schematy N/K per wersja, różne zestawy providerów,
// przeskakiwanie między wersjami bez pobierania shardów.

export interface VersionManifest {
  version: number;
  pushed_at: Nullable<string>; // ISO 8601; null po recovery (uzupełniane po pull)
  file_count: Nullable<number>; // null po recovery (uzupełniane po pull)
  total_size: Nullable<number>; // bajty (rozmiar katalogu); null po recovery (uzupełniane po pull)
  blob_hash: string; // SHA-256 bloba przed RS
  scheme: {
    data_shards: number; // N
    parity_shards: number; // K
  };
  encrypted: boolean;
  shards: ManifestShard[]; // N+K wpisów
  health: VersionHealth; // push: "healthy" (po weryfikacji uploadu); recovery: "degraded" (przed verify)
  // Pola streamingowego pipeline (FORMAT_VERSION=2 shards). Brak = stary format.
  rs_striped?: boolean; // true = striped RS encoding (zawsze przy nowym push)
  rs_stripe_size?: number; // rozmiar stripe w bajtach (tylko gdy rs_striped=true)
  encrypted_per_shard?: boolean; // true = szyfrowanie per shard (zamiast per blob)
  /** true = data section is a ZIP file (BLOB_FLAGS.COMPRESSED bit set). */
  compressed?: boolean;
  /** Sum of uncompressed file sizes before compression (bytes). Present when compressed=true. */
  blob_size_uncompressed?: number;
}

export interface ManifestShard {
  shard_index: number;
  provider_id: string; // referencja do providera z config.json
  provider_type: string; // "local" | "gdrive" | "ftp" | "ssh" | ...
  remote_path: string; // ścieżka na nośniku
  shard_hash: string; // SHA-256 PAYLOADU sharda (samych danych RS, bez nagłówka i trailing checksum)
  // Payload jest niezmienny — nagłówek może się zmienić (heal, relocate),
  // ale dane RS nie. Dlatego hash dotyczy tylko payloadu.
}

// ─── Skip results ─────────────────────────────────────────────

export type { SkippedFile };

/** Result returned by push() on success. */
export interface PushResult {
  version: number;
  file_count: number;
  total_size: number;
  /** Files skipped due to read errors (non-empty only in REPL interactive mode when user accepted). */
  skipped: SkippedFile[];
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

// ─── BFS Blob — format binarny ───────────────────────────────

export interface BlobHeader {
  magic: 'BFS\0'; // 4 bajty
  format_version: number; // 2 bajty (uint16, wartość: 1)
  vault_id: string; // 16 bajtów (UUID jako binary)
  flags: number; // 4 bajty (bitfield: bit 0 = encrypted, bit 1 = compressed)
  created_at: bigint; // 8 bajtów (unix timestamp ms, uint64 LE)
  file_count: number; // 4 bajty (uint32)
  file_table_offset: bigint; // 8 bajtów
  file_table_length: bigint; // 8 bajtów
  data_offset: bigint; // 8 bajtów
  data_length: bigint; // 8 bajtów
}
// Total header size: 70 bajtów

export interface FileEntry {
  path: string; // ścieżka relatywna (UTF-8, separatory /)
  size: bigint; // 8 bajtów
  data_offset: bigint; // offset w data section, 8 bajtów
  hash: string; // SHA-256, 32 bajty
  mode: number; // permissions, 4 bajty
  modified_at: bigint; // unix timestamp ms, 8 bajtów (uint64 LE)
}

// ─── Shard — format binarny ──────────────────────────────────

export interface ShardHeader {
  magic: 'BFSS'; // 4 bajty
  format_version: number; // 2 bajty (uint16)
  vault_id: string; // 16 bajtów (UUID binary)
  vault_name: string; // variable (length-prefixed)
  blob_size: bigint; // 8 bajtów — rozmiar danych wchodzących w RS-encode
  // (po encryption jeśli włączone, plain blob jeśli nie)
  // Służy do obcięcia paddingu po RS-decode
  blob_hash: string; // 32 bajty — SHA-256 PLAIN bloba (przed encryption/RS)
  // Weryfikowany po RS-decode + decrypt
  data_shards: number; // 2 bajty (uint16)
  parity_shards: number; // 2 bajty (uint16)
  shard_index: number; // 2 bajty (uint16)
  version: number; // 4 bajty (uint32) — numer wersji snapshota
  encrypted: boolean; // 1 bajt
  kdf_salt: Nullable<Buffer>; // 16 bajtów jeśli encrypted=true, brak jeśli false
  rs_stripe_size: Nullable<number>; // 4 bajty (uint32) — present when format_version >= 2; null for v1
  map_length: number; // 4 bajty (uint32)
  location_map: ShardLocation[]; // JSON (opcjonalnie AES-GCM encrypted)
}

export interface ShardLocation {
  shard_index: number;
  provider_id: string; // user-defined name, np. "NAS-piwnica", "FTP-ovh"
  provider_type: string;
  /**
   * Full npm spec of the adapter package for external providers (e.g.
   * "bfs-adapter-ssh@1.0.1"), null for built-in providers or for shards
   * serialized by BFS versions older than the adapterPackage field.
   */
  adapterPackage: Nullable<string>;
  // UWAGA: connection_config przechowuje dane połączenia (host, port, user, path).
  // Gdy encrypted=false, location map jest zapisana jako surowy JSON w nagłówku sharda.
  // Każdy kto ma dostęp do jednego sharda widzi connection_config WSZYSTKICH providerów.
  // Użytkownik świadomie akceptuje to ryzyko wybierając brak szyfrowania.
  // Rekomendacja: nie umieszczaj haseł ani kluczy prywatnych w connection_config —
  // sekrety powinny być podawane interaktywnie przez ProviderIO.askSecret().
  connection_config: Record<string, unknown>;
  remote_path: string;
  shard_hash: string; // SHA-256 PAYLOADU (danych RS, bez nagłówka sharda)
}

// ─── Provider I/O — abstrakcja interakcji z userem ───────────
// Provider NIE dotyka CLI bezpośrednio. Dostaje ProviderIO jako dependency injection.
// Dzięki temu ten sam provider działa w REPL, standalone CLI, a w przyszłości w GUI.
// W testach: mockowy ProviderIO z predefiniowanymi odpowiedziami.

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

  ask(prompt: string): Promise<string>; // "Podaj login:"
  askSecret(prompt: string): Promise<string>; // "Podaj hasło:" (ukryte)
  confirm(message: string): Promise<boolean>; // "Kontynuować? [y/N]"
  choose(message: string, options: string[]): Promise<string>; // "Wybierz katalog:" → lista
  info(message: string): void; // "Łączę z FTP..."
  /**
   * Diagnostic log emitted only when `bfs --debug` is active. Built-in
   * providers use it for connection chatter, retry attempts, and other
   * implementation noise that would pollute verify/push/pull output by
   * default. Output goes to stderr so stdout redirection stays clean.
   */
  debug(message: string): void;
  warn(message: string): void; // "Certyfikat niezaufany"
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
// Provider operuje w kontekście: {base_path}/{vault_name}/
// vault_name przekazywany przy inicjalizacji providera.
// ProviderIO przekazywany przy tworzeniu (factory/constructor).
//
// Logika authenticate():
//   1. Mam zapisany token/hasło && ważny → połącz cicho
//   2. Token wygasł && mam refresh token → odśwież cicho
//   3. Nic nie działa → ProviderIO: "Sesja wygasła, podaj hasło:"
// User nie jest pytany niepotrzebnie.

export interface StorageProvider {
  readonly id: string;
  readonly type: string;

  authenticate(): Promise<void>;
  setVaultName(name: string): void;
  /**
   * Przesyła shard na nośnik jako strumień.
   * @param shardFilename nazwa pliku na nośniku
   * @param data strumień danych sharda (nagłówek + payload + checksum)
   * @param size całkowity rozmiar strumienia w bajtach (do Content-Length / pre-alokacji)
   */
  upload(
    shardFilename: string,
    data: Readable,
    size: number,
  ): Promise<RemoteRef>;
  /**
   * Pobiera shard z nośnika jako strumień.
   * Caller odczytuje go porcjami (nagłówek, payload, checksum).
   */
  download(ref: RemoteRef): Promise<Readable>;
  delete(ref: RemoteRef): Promise<void>;
  // rename — używane w overwrite mode (push --overwrite):
  //   Upload nowego sharda jako .tmp → delete starego → rename .tmp na finalną nazwę.
  //   Providerzy bez natywnego rename (np. S3) implementują jako copy + delete.
  rename(ref: RemoteRef, newFilename: string): Promise<RemoteRef>;
  // updateShardHeader — używane w heal (provider-remove + heal):
  //   Aktualizuje nagłówek sharda po zmianie location map.
  //   Wynik: shard na nośniku ma nowy nagłówek, niezmieniony payload,
  //   przeliczony trailing checksum (SHA-256 całości: nowy nagłówek + payload).
  //   Implementacja zależy od adaptera (partial read, full rewrite, server-side, itp.)
  //   headerData to pełny zserializowany nagłówek
  //   (od magic do końca location map, bez payloadu i checksum)
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
   * Provider-declared secret field names (e.g. ['password']).
   * Used by describeConfig and any other consumer that wants to mask.
   */
  getSecretFields(): readonly string[];

  /**
   * Full read/write/verify round-trip against the configured remote.
   * Called after configureInteractive/configureFromFlags, BEFORE persisting
   * the provider to VaultConfig. Failure = no persist.
   * @throws ProviderError with step context (auth / ensureDir / upload / download / compare / delete)
   */
  probeConnection(): Promise<void>;
}

export interface RemoteRef {
  provider_id: string;
  path: string;
  hash?: string; // SHA-256 — dostępny po upload(); list() może go nie zwrócić (FTP, SSH)
}
