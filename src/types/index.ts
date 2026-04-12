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
  ask(prompt: string): Promise<string>; // "Podaj login:"
  askSecret(prompt: string): Promise<string>; // "Podaj hasło:" (ukryte)
  confirm(message: string): Promise<boolean>; // "Kontynuować? [y/N]"
  choose(message: string, options: string[]): Promise<string>; // "Wybierz katalog:" → lista
  info(message: string): void; // "Łączę z FTP..."
  warn(message: string): void; // "Certyfikat niezaufany"
  progress(label: string, percent: number): void; // progress bar
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
  listVaults(): Promise<string[]>;
  healthCheck(): Promise<boolean>;
}

export interface RemoteRef {
  provider_id: string;
  path: string;
  hash?: string; // SHA-256 — dostępny po upload(); list() może go nie zwrócić (FTP, SSH)
}
