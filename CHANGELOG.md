# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.6.0] - 2026-05-28

### Added
- **`bfs push` partial-commit semantics.** When a storage provider becomes
  unreachable mid-push (auth failure, network drop, quota exhausted), the
  upload now continues with the remaining providers instead of aborting the
  whole transfer. The resulting backup version is committed with whatever
  providers succeeded:
  - **Healthy** — every provider received its piece. The success message
    now reports "X of N uploaded" so the count is explicit.
  - **Degraded** — at least N providers stored a piece (the backup is
    still fully restorable via `bfs pull`). Exit code is non-zero so CI
    scripts can detect partial state; a hint suggests how to complete it
    once the offending provider is fixed.
  - **Damaged** — fewer than N providers stored a piece. The version is
    written so the user can investigate, but `bfs pull` will refuse it.
    Exit code is non-zero with a hint suggesting `bfs prune --version <N>`.
  Previously every provider failure scrapped the entire push and left the
  already-uploaded pieces as orphans on the storage backends.
- **`.bfs/push.lock` forensic state file.** Each `bfs push` writes
  `.bfs/push.lock` recording every successful and failed upload
  (provider name, reason, timestamp). The file is kept after partial
  fails, crashes, or Ctrl+C so the user can inspect what happened, and
  is removed only on a fully healthy push. Stale locks from dead
  processes (PID gone, or lock older than 24 h) are detected on the
  next push and refused with a hint pointing at `bfs clear`. Concurrent
  `bfs push` invocations against the same backup are blocked while one
  is in progress.
- **`bfs push --cache` now requires both the cached backup data AND the
  lock file.** If either is missing the command refuses with a clear
  message listing what is gone. `bfs push` aborted due to skipped files
  also writes `push.lock`, so the resume path is consistent regardless
  of why the previous push stopped.
- **`bfs clear` removes lock files too.** In addition to clearing the
  cached backup data from previous interrupted operations, the command
  now also removes `.bfs/push.lock` and `.bfs/repair.lock`. Each
  removed file is reported individually on stdout.
- **`bfs status` warns when the redundancy scheme drops below the safe
  minimum.** If the scheme is below 2 data + 1 parity (e.g. after a
  manual config edit), status now prints
  "push disabled — scheme N/K below minimum 2/1" so the user knows new
  pushes will be refused until the scheme is restored.

### Changed
- `bfs pull` against an encrypted backup with the wrong password now reports
  a single clean "Decryption failed — wrong key or corrupted data" message.
  Previously duplicate decryption errors could bleed into stderr — one per
  internal data piece — looking like a crash even though the main error was
  the same. Adding `--debug` restores the per-piece diagnostics, useful for
  spotting partial corruption (where one piece fails differently from the
  rest); without `--debug` the output stays as a single error.
- Error messages for an invalid redundancy scheme (`data_shards < 2` or
  `parity_shards < 1`) now suggest both `bfs provider add` and
  `bfs scheme set` as recovery paths. Previously only `bfs scheme set` was
  mentioned, which omitted the natural option of restoring the missing
  provider instead of shrinking the scheme.

## [0.5.0] - 2026-05-08

### Added
- **FTP/FTPS provider** — `bfs init`, `bfs provider add`, `bfs recovery`, `bfs verify`,
  `bfs push`, and `bfs pull` now support FTP servers as storage providers. Configure host,
  port, credentials, base path, and optional TLS (FTPS). Each FTP connection is opened per
  operation and closed immediately — no persistent sessions. Notable design points:
  - **Post-upload verification.** Every `bfs push` queries the server for the stored file
    size after each upload and aborts with a clear error pointing at the FTP server's
    transfer mode if the size differs from what was sent — Alpine-based vsftpd builds and
    similar configurations are known to silently drop bytes during storage. A full
    byte-for-byte round-trip (upload + download + compare) runs once during
    `bfs provider add` so a misconfigured server is caught the moment it is registered,
    before any shard ever lands on it.
  - **Automatic retry up to 3× on sporadic truncation.** Some vsftpd / Docker deployments
    occasionally truncate the data connection on a single upload (verified independently
    with Windows Explorer — environmental, not BFS-specific). Persistent truncation (e.g.
    ASCII mode silently rewriting bytes) still fails after the last attempt with the same
    clear diagnostic.
  - **Binary mode (`TYPE I`) explicitly requested on every login** as a second line of
    defence against ASCII-mode corruption.
  - **Partial header reads.** `bfs recovery` and `bfs verify` pull only the first ~16 KB
    of each shard from FTP, so disaster recovery against multi-MB shards finishes in
    seconds instead of minutes.
  - **Password masking everywhere.** `bfs provider add` shows `*` characters while typing
    the FTP password; `bfs provider list` masks the password in the displayed configuration
    so credentials never appear in plaintext terminal output.
  - **Connection diagnostic silenced by default.** Internal `FTP connecting to host:port`
    chatter is only visible when the hidden `--debug` flag is passed (in which case it
    prints to stderr, keeping stdout redirection clean).
- `bfs recovery --provider ftp` — recover a backup from an FTP server. Without
  `--bootstrap`, the CLI prompts for full FTP configuration (host, port, user, password,
  path, secure) interactively.
- `bfs init --ci --provider "ftp:<name> --host <h> --port <p> --user <u> --password <pw> --path <abs-path> --secure <b>"` —
  FTP providers can be specified in non-interactive mode via inline flags. JSON config
  files are supported via `--config-file`, and inline flags can override individual JSON
  fields (useful when the password comes from CI secrets).
- **Public entry point for provider adapters** (`bfs-vault/provider`). Third-party packages
  (e.g. `bfs-adapter-ssh`) can install BFS as a dependency and import the full provider
  contract to publish their own storage backends. See `docs/adapter-guide.md` (shipped
  inside the npm package). Adapters declare the minimum contract version they need via
  `requiresApiVersion`; BFS refuses to register an adapter requiring a newer contract than
  the installed version supports, with a clear error message. Provider type prompts in
  `bfs init`, `bfs provider add`, `bfs provider remove`, and `bfs recovery` enumerate every
  registered type — installing a third-party adapter automatically adds it to the choices,
  no CLI rebuild required.
- `bfs provider add` now runs a full write / read / verify round-trip against the new
  provider BEFORE saving it to the vault configuration. Invalid credentials or
  insufficient permissions are caught immediately, and the vault's N+K scheme stays
  untouched until the probe succeeds.
- **`bfs provider -h` aggregates help for every registered provider** (built-in and
  external alike) into an "Available providers:" section. Each block shows `Usage`,
  description, `Options`, and examples with a consistent layout, and respects `--lang` —
  built-in providers (`local`, `ftp`) translate their description and flag descriptions
  when the UI is set to Polish. Provider names (`Local filesystem`, `FTP/FTPS`) and CLI
  examples stay in English as proper nouns and copy-pasteable commands. External adapters
  can optionally translate their own help by reading `factory.lang` (BFS sets it from
  `--lang`); adapters that don't ship translations stay English-only. Installing a
  third-party adapter automatically adds its block.
- **`bfs provider add --ci` pass-through mode.** BFS recognizes exactly three flags:
  `--ci`, `--name`, `--type`. Every other CLI token — including `--config-file`,
  `--private-key`, `--bucket` — is forwarded verbatim to the provider so adapters can
  define their own grammar without BFS core needing to know about them. The FTP and
  LocalFS built-in adapters accept a `--config-file <path>` pointing at a JSON file whose
  shape each adapter documents.
- **`bfs init --ci --provider` pass-through grammar.** The `--provider` flag accepts
  `type:name [adapter-flags]` tokenized shell-style, e.g.
  `--provider "local:usb1 --path /mnt/usb"` or
  `--provider "ftp:nas --config-file ./ftp.json"`. Values with embedded spaces are
  supported via single or double quotes; backslash is literal outside quotes, so Windows
  paths inline (`--provider "local:vol1 --path D:\backup\vol1"`) work without
  double-escaping. BFS splits only `type:name` and forwards every remaining token to the
  provider, so adapters with their own flags (`--bucket`, `--region`, `--private-key`, …)
  work without any BFS changes. Credentials can live in a config file read by the adapter
  instead of on the shell command line, keeping passwords out of `ps` output and shell
  history.
- **Inline flags for built-in adapters.** `local` accepts `--path <path>` (absolute or
  resolved relative to the BFS working directory). `ftp` accepts `--host`, `--port`,
  `--user`, `--password`, `--path`, `--secure` (`true|false|1|0|yes|no`). Both still
  accept `--config-file <path>`; inline flags override fields loaded from JSON.
- **Provider name charset enforced.** `bfs init` and `bfs provider add` now reject names
  containing whitespace, colons, slashes, or other punctuation — only letters, digits,
  `.`, `_` and `-` are allowed. The name is a technical identifier that appears in the
  backup config, folder layout on providers, and error messages, so it needs to be
  unambiguous to split and quote. Existing backups with older names continue to load
  unchanged; the rule applies only to newly created or newly added providers.
- **Disaster-recovery preflight** — `bfs pull` and `bfs recovery` now list every missing
  external adapter before touching any shard, with ready-to-copy
  `npm install -g <package@version>` commands. Missing built-in providers abort with a
  "BFS installation broken" diagnostic. `--allow-missing-adapters` allows Reed-Solomon
  decoding to proceed with whichever providers remain reachable.
- **Adapter version mismatch warnings** — when the recorded adapter version differs from
  the installed one, BFS warns (soft for patch/minor deltas, strong with an install hint
  for major ones) so users can pin the original version if recovery fails.

### Changed
- `bfs verify` now performs a real integrity check on every shard: it confirms that the
  file is present, has a non-zero size, and carries a header consistent with the local
  backup (vault id, version, scheme, and original data hash). Tampered or stale shards
  are reported with a precise reason instead of silently passing.
- `bfs recovery` non-interactive (CI) configuration now uses a single `--bootstrap "<adapter
  flags>"` spec instead of the previous `--path <path>` shortcut. Adapter flags follow the
  same grammar as `bfs init --ci --provider` (after the `type:name`) and reach the
  adapter's own `configureFromFlags` parser, so every provider — built-in or external —
  accepts its full flag set, including `--config-file <path>` for adapters that read JSON.
  Examples:
    bfs recovery --provider local --name picture --bootstrap "--path /mnt/usb"
    bfs recovery --provider ftp   --name temp    --bootstrap "--host x --user u --password p --path /a"
    bfs recovery --provider ftp   --name temp    --bootstrap "--config-file ./nas.json"
  The `--config-file` form is the recommended approach for any provider whose credentials
  don't fit cleanly on a command line (private keys, OAuth tokens, multi-line secrets) —
  the JSON file stays on disk with restricted permissions, never appears in shell history.
  The interactive REPL flow (no `--bootstrap`) is unchanged — recovery still prompts for
  each field one by one.
- `bfs provider remove --strategy relocate|rebuild` no longer accepts `--new-path <path>`.
  Every adapter now declares its own flag grammar for new connection details, in symmetry
  with `bfs provider add --ci` and `bfs init --ci --provider`. Use `--config-file ./new.json`
  for the built-in FTP/LocalFS adapters, or whatever flags the adapter documents in
  `bfs provider -h`. For `relocate`, `--new-type <type>` is optional (defaults to the
  current provider type). For `rebuild` to a brand-new target, `--new-type <type>` is
  required and `--target <new-id>` names the newly-registered provider — BFS detects
  "new target vs. existing" by checking whether the id already exists in the vault config.
  Interactive `relocate` and `rebuild`-new-location prompts now offer a separate
  "Change provider type?" confirm, so the adapter can collect its own configuration via
  `configureInteractive` regardless of the chosen type.
- `bfs provider list` column previously labelled `ID` is now `Name` (EN) / `Nazwa` (PL).
- `bfs provider add --ci` now requires `--type` explicitly; the previous implicit default
  of `local` has been removed so CI invocations declare their storage backend
  intentionally. The `--id` flag has been renamed to `--name` to match the prompt wording.
- Backups produced by earlier BFS versions remain fully recoverable. The location map
  inside shard headers now carries adapter package information for every entry, but BFS
  falls back to a safe default when reading shards written before this field existed — no
  migration, no flags, no format-version bump.
- When a shard checksum fails to verify, the error now reports the shard's total size and
  the expected/computed hash prefixes. This makes it easy to compare shard sizes across
  providers and spot a truncated transfer without having to open each file manually.
- **`bfs init --ci` now refuses incomplete argument sets instead of creating a broken
  backup.** Previously `bfs init --ci myvault` (without `--data-shards` / `--parity-shards`
  / enough `--provider` flags) silently produced a configuration with a null scheme, then
  `bfs push` crashed later with an internal Reed-Solomon error. `--ci` now requires the
  backup name as a positional argument, `--data-shards >= 2`, `--parity-shards >= 1`, and
  exactly N+K `--provider` flags — missing or invalid values abort with a clear message
  and no configuration file is written. `bfs init --ci` without a name no longer falls
  back to an interactive prompt.
- `bfs push`, `bfs pull`, and `bfs prune` now detect a corrupted `.bfs/config.json`
  (missing or invalid scheme, provider count that does not match N+K) and stop with a
  user-level message pointing at `bfs scheme set` or `bfs provider add`, instead of
  surfacing an internal `dataShards must be >= 2, got null` error deep inside the encoder.

### Removed
- The legacy colon-separated `--provider` shorthand (`local:id:/path`,
  `ftp:id:host:port:user:password:/path:secure`) is no longer accepted. The dispatcher is
  now pass-through-only: every `--provider` value must follow `type:name [adapter-flags]`.
  Migrate by replacing `local:p1:/mnt/usb` with `local:p1 --path /mnt/usb`, and the FTP
  8-segment form with `ftp:nas --host <h> --port <p> --user <u> --password <pw> --path <p>
  --secure <b>` (or `--config-file ./nas.json`). Existing backups created with the legacy
  CLI continue to load — the path/host/etc. is persisted in `.bfs/config.json` and
  manifests, not derived from the original spec.

## [0.4.0] - 2026-04-12

### Added
- **ZIP compression** — `bfs push` now compresses backup data using deflate before uploading.
  Compression is enabled by default for new backups. For text-heavy projects (code, logs,
  configs) this typically reduces backup size by 50–80 %.
- `bfs init` now analyses directory contents before asking about compression. When most files
  are already compressed (images, videos, archives), the prompt defaults to `[y/N]` (off) and
  shows which file types were detected. For code and text-heavy directories the prompt defaults
  to `[Y/n]` (on). In CI mode (`--ci`) compression is enabled or disabled automatically based
  on the same analysis when no explicit flag is given.
- `bfs init --compress` — explicitly enable compression, skipping the auto-detect analysis.
  Useful in CI scripts that always want compression regardless of directory contents.
- `bfs init --no-compress` — disable compression when initializing a new backup (CI/scripted
  mode). In interactive mode skips the auto-detect analysis and defaults the prompt to off.
- `bfs push --compress` — enable compression for a single push, overriding the backup
  configuration (useful when compression was disabled at init time).
- `bfs push --no-compress` — disable compression for a single push, overriding the backup
  configuration.
- `bfs config --on <feature>` / `bfs config --off <feature>` — toggle compression or
  encryption for an existing backup without re-running `bfs init`. Accepted values:
  `compress` (or `compression`) and `encryption` (or `encrypt`). The change takes effect
  on the next `bfs push`.
- `bfs config` (no arguments) now also shows the current compression and encryption status
  alongside the existing cache/temp/RAM settings.
- `bfs recovery` now asks for the password interactively when the backup is encrypted and
  `--password` is not given. Previously this was a hard error ("provide --password to bootstrap").
- `bfs recovery` now supports multiple `--password` flags for vaults where the password was
  changed between versions: `bfs recovery --password oldpass --password newpass`.
- Wrong password entry during recovery now allows up to 3 retries per version instead of
  immediately skipping. Each prompt shows the version number it applies to.

### Changed
- `bfs recovery` now processes versions from newest to oldest. When a password changes between
  versions, the user only needs to enter the old password once — it is reused automatically
  for all earlier versions that share it.
- `bfs push` now always asks to confirm the encryption password when entering it interactively,
  not only on the first push. Previously a typo during a subsequent push silently uploaded the
  backup with the wrong key and the failure was only visible later during `bfs pull`.

### Fixed
- `bfs push` could fail with `ENOENT` for temporary parity files on some Linux environments
  (including GitHub Actions CI runners). Temporary files are now stored in the backup's cache
  directory (`.bfs/cache/`) instead of the system temp directory.
- `bfs recovery` appeared to hang at "Scanning providers…" when the backup was encrypted
  and no `--password` was given. The spinner was covering the password prompt, so the user
  could not see the app was waiting for input. Interactive prompts now pause the spinner.
- `bfs recovery` downloaded entire shard files (multi-GB each) just to read their headers
  (~1 KB). For a 10 GB backup with 2 versions and 3 providers, recovery would copy ~20 GB
  of data to cache before finishing. Now only the first few kilobytes of each shard are read,
  making recovery nearly instant regardless of backup size.

## [0.3.0] - 2026-04-03

### Changed
- `bfs push` and `bfs pull` now use a streaming pipeline — backups of any size are supported
  (tested up to 100 GB+). Small backups (< 50 MiB) are still packed in memory for speed;
  larger ones are automatically streamed through disk. Peak memory usage is ~200-500 MB
  regardless of backup size.
- `bfs push` is significantly faster — shard hashes are now computed during encoding
  instead of re-reading all data afterwards. For a 200 GB backup this eliminates ~500 GB
  of redundant disk reads, cutting push time roughly in half.
- The in-memory threshold for small backups is now dynamic: based on the configured RAM
  limit minus encoding overhead, capped at 4 GB. Previously it was a fixed 50 MiB.

### Added
- Interactive prompts (e.g. `bfs prune`, `bfs provider remove`, `bfs recovery`) now support
  pressing **Esc** to cancel cleanly — no error message, treated as empty selection or decline.
  **Ctrl+C** still works as a force close with a visible message.
  The `bfs prune` version picker also shows `esc anuluj` in the keyboard shortcuts bar.
- `bfs config` — new command to view and persistently configure per-backup settings.
  Use `bfs config --cache-dir <path>` to set a custom cache directory and
  `bfs config --temp-dir <path>` to set a custom temp directory.
  Use `bfs config --cache-dir --reset` (or `--temp-dir --reset`) to restore the default.
  Running `bfs config` with no arguments displays the current settings.
- `bfs push --cache-dir <path>` / `bfs pull --cache-dir <path>` — override the cache
  directory for a single operation (takes priority over the value stored in `bfs config`).
- `bfs clear --cache-dir <path>` — delete cache files from a custom directory instead of
  the default. Respects the `cache_dir` set via `bfs config` when no flag is given.
- `bfs config --max-ram <MB>` — set a persistent RAM limit for encoding operations.
  Controls how much memory is used for in-memory packing and stripe size calculation.
  Use `bfs config --max-ram --reset` to restore the default (auto: 25% of system RAM).
  Running `bfs config` with no arguments now also displays the current RAM limit.
- `bfs push --max-ram <MB>` — override the RAM limit for a single push operation.
- `bfs init` now asks for a RAM limit during interactive setup (auto-detected from
  system memory, configurable). In CI mode use `--max-ram <MB>`.
- Pressing Ctrl+C during `bfs push` or `bfs pull` now automatically removes any
  in-flight temporary files, leaving no partial data on disk.
- `bfs push --temp-dir <path>` — specify a custom directory for temporary files during push
  (blob packing and parity shard generation).
- `bfs pull --temp-dir <path>` — specify a custom directory for temporary files during pull
  (shard download and decoding).
- All status and progress messages shown during `bfs push`, `bfs pull`, and `bfs recovery`
  are now fully translated. Previously these messages always appeared in English regardless
  of the configured language. Running `bfs --lang pl` now applies to the entire operation.

### Fixed
- Typing `bfs push` (or any command with the `bfs` prefix) in the interactive REPL no longer
  fails with "unknown command 'bfs'". The prefix is now silently stripped so that `bfs push`
  and `push` behave identically inside the REPL.
- `bfs push --password <pass>` now encrypts the backup even when encryption is disabled
  in the backup configuration. Previously the password was silently ignored and data was
  stored unencrypted. The configuration itself is not changed — this is a one-time override.

## [0.2.0] - 2026-03-27

### Changed
- Replaced internal technical terms "blob" and "vault" in all user-facing messages
  with plain language: "backup data" / "backup" (EN) and "dane kopii" / "kopia zapasowa" (PL).
  Internal code names (`blob-pack.ts`, `packBlob()`, `VaultConfig`, etc.) are unchanged.
- All CLI option descriptions (`--cache`, `--name`, `--password`, `--force`, `--version`,
  `--keep-last`, `--strategy`, and others) are now fully translated — visible when running
  `bfs <command> --help` with `--lang pl`.

### Added
- `bfs pull -y` / `bfs pull --yes` — auto-confirms the overwrite prompt without clearing
  the working directory (unlike `--force`, which deletes all files before unpacking).
- `bfs push` now aborts **before upload** when files cannot be read, caches the blob to
  `.bfs/cache/push.blob.pending`, and lists the inaccessible files.
  Use `bfs push --cache` to upload the cached blob without re-packing.
- `bfs pull` now aborts **before unpacking** when files cannot be written, caches the decoded
  blob to `.bfs/cache/pull.blob.pending`, and lists the inaccessible paths.
  Use `bfs pull --cache` to retry the unpack from cache after fixing permissions.
- Interactive REPL mode: instead of aborting, shows up to 10 skipped files and asks
  whether to continue (push) or retry (pull).
- `bfs clear` deletes both cache files (`push.blob.pending`, `pull.blob.pending`).
- New error types `PushSkippedError` and `PullSkippedError` in `src/core/errors.ts`.
- New types `SkippedFile`, `PushResult`, and `PullResult` in `src/types/index.ts`.
- New `packBlob()` return value includes a `skipped` array of unreadable files.
- New `unpackBlob()` return value includes `extracted` and `skipped` arrays.

### Fixed
- `.bfsignore` was not created during `bfs init` when installed from npm. The default
  content was previously read from `.bfsignore.default` on disk via `fileURLToPath`,
  which is not included in the bundled `dist/`. Content is now inlined as
  `DEFAULT_BFSIGNORE_CONTENT` in `src/core/ignore-defaults.ts`.

## [0.1.0] - 2026-03-23

Initial release.

[Unreleased]: https://github.com/pfranczyk/bfs/compare/v0.6.0...HEAD
[0.6.0]: https://github.com/pfranczyk/bfs/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pfranczyk/bfs/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/pfranczyk/bfs/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pfranczyk/bfs/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pfranczyk/bfs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pfranczyk/bfs/releases/tag/v0.1.0
