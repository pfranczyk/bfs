# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.9.1] - 2026-07-03

### Fixed
- **Damaged (not just missing) backup data on one storage device no longer blocks
  a restore when the redundancy to recover it is intact.** If the data on a device
  was silently corrupted — bit rot, an interrupted transfer, a partial write —
  rather than the device being unreachable, `bfs pull` previously aborted the
  entire restore, even though the remaining devices plus the parity were enough to
  rebuild the backup. BFS now detects the damaged data, sets that device aside,
  and reconstructs the backup from the healthy ones — exactly as it already did
  for a device that is gone. Corrupting up to the parity count of devices is now
  as survivable as losing that many. A wrong decryption password is still reported
  clearly, not mistaken for corruption.

## [0.9.0] - 2026-07-02

### Added
- **`bfs push` now flags files that change on disk while it runs.** After packing,
  push compares each file's size and modification time against a snapshot taken
  before packing and reports anything that changed, disappeared, or was added
  mid-run. In an interactive terminal you choose whether to accept the backup
  (still fully restorable, just not current for those files) or retry without
  touching them; a non-interactive push stops by default, and the new
  `--allow-drift` flag accepts the drift instead. Accepting never sacrifices
  recoverability — only how up-to-date the backup is.

### Fixed
- **A large uncompressed backup can no longer become unrestorable if a file
  changes while the backup is being written.** With compression turned off and a
  backup too large to build in memory, a file modified mid-run could leave the
  backup's stored checksum out of step with its stored data, so a later
  `bfs pull` refused to restore it. Backups written this way are now always
  restorable.

## [0.8.1] - 2026-07-01

### Changed
- **Polish CLI uses everyday storage wording.** In the Polish locale, storage
  devices are now consistently called „nośnik" across every command and prompt.
  Wording only — no change in behavior.

### Fixed
- **A warning during `bfs push` no longer scrambles the progress line.** When a
  storage device reports a warning while a push is running, the progress
  indicator is paused for the message instead of the two overwriting each other
  in the terminal. `bfs pull` and `bfs recovery` already behaved this way.
- **Clearer `bfs recovery` messages.** When recovery cannot rebuild or read the
  latest backup version, the two messages now describe the problem in terms of
  your backup version instead of an internal term.

## [0.8.0] - 2026-06-28

### Added
- **`bfs provider edit <name>` command.** Change an existing provider's
  connection settings (path, host, port, user, password) locally, without
  contacting the storage. It works offline — when the medium is unplugged, or
  when its path differs between machines (e.g. a USB drive that is `E:/` on
  Windows and `/mnt/usb1` on Linux). Run it non-interactively with `--ci` and
  the adapter's own flags (`--path`, `--config-file`, …), or interactively to
  re-enter the configuration after seeing the current one (secrets masked).
  Rotating a storage password is fully local: credentials live only in the
  local configuration and are never written into your backup. After changing a
  non-secret coordinate (host, path, …), BFS notes that the next `bfs push`
  updates the stored backup headers to match. The provider's name and type are
  unchanged, and the redundancy scheme is left intact.
- **Interactive `bfs init` checks each storage before accepting it.** When you
  set up a storage device during interactive setup, BFS now verifies it is
  reachable and usable (a full round-trip to the configured base path, not just
  a login) before moving on. If the check fails — a transient network error, or
  a typo in the host, port, password, or path — you can retry, re-enter the
  settings, or abort, without losing the rest of the setup. This catches a
  storage that would otherwise look fine at setup and only fail later on the
  first `bfs push`.

### Changed
- **A failed storage check in interactive `bfs provider add` is now
  recoverable.** When adding a provider interactively, a rejected configuration
  or a failed connection check no longer abandons the operation — you can retry,
  re-enter the settings, or abort in place, the same as during interactive
  setup. The non-interactive (`--ci`) path is unchanged.

## [0.7.0] - 2026-06-22

### Added
- **Warning when a backup is not encrypted.** `bfs init --no-enc` and every
  `bfs push` of an unencrypted backup now print a warning: part of your data
  is directly readable on a single storage device, and the addresses and
  usernames of all your storage are visible on every device. Encryption (the
  default) avoids both.
- **Encrypted backups that are too large are now refused with a clear error.**
  A single encryption key can only safely protect a limited amount of data, so
  `bfs push` on an encrypted backup now stops with an explanatory message when
  the per-unit data size would exceed that limit, suggesting you raise the data
  count in the scheme (`bfs scheme set`) or back up a smaller directory —
  instead of silently weakening the encryption.
- **Security policy published (`SECURITY.md`).** The repository now documents how
  to report a vulnerability privately, which versions receive security updates,
  and a threat model: what each storage provider can and cannot see with and
  without encryption, the metadata that stays in cleartext, how storage
  credentials are handled, the per-key encryption size limit, and the
  interactive nature of disaster recovery.
- **Provider adapter contract v2 (`bfs-vault/provider`) — BREAKING for third-party adapters.** `BFS_PROVIDER_API_VERSION` is now `2`. `StorageProvider` gained four required methods — `usesSidecar`, `uploadHeaderSidecar`, `downloadHeaderSidecar` and `verifyShard` — so an adapter compiled against version 1 no longer satisfies the interface: it must implement all four methods and declare `requiresApiVersion: 2`. An adapter missing the methods is rejected with a clear incompatibility error when BFS instantiates it — so even a precompiled adapter that slips past registration fails loudly rather than silently. The built-in local disk and FTP adapters are already updated. A provider whose medium cannot rewrite a shard header in place (append-only object stores, APIs without partial writes) returns `usesSidecar() === true` and stores the updated header in a sidecar file using the standard **BFSH** binary format (magic + version + serialized header + SHA-256); providers that rewrite in place (the built-in local disk and FTP adapters) return `false` and are otherwise unchanged. The sidecar read-path is already active in `bfs verify`: when an adapter reports `usesSidecar() === true`, a present sidecar is read in preference to the in-shard header, so its `downloadHeaderSidecar` must work from this release. `verifyShard` lets a provider confirm a shard's identity (vault id, index, version) on its own medium; it has no consumer yet and is wired into the upcoming repair and recovery flows.
- **Warning when a storage provider uses plain (unencrypted) FTP.** Every backup
  operation that connects to an FTP provider with FTPS disabled now prints a
  warning naming the server — the storage password and your backup data cross
  the network in cleartext. The warning appears once per operation (a multi-shard
  push warns once, not once per shard), so an unintended insecure transport is
  hard to miss. Enable the provider's `secure` (FTPS) option, or run BFS only
  over a network you trust.

### Changed
- **Backups created with `bfs init` are now encrypted by default.** Both the
  interactive setup and the non-interactive `bfs init --ci` enable encryption
  unless you pass the new `--no-enc` flag to store the backup unencrypted. The
  encryption password is still chosen on the first `bfs push`, so a
  non-interactive push on a default (encrypted) backup now fails loudly when no
  password is supplied, instead of silently writing plaintext. Existing backups
  are unaffected — their encryption setting is read from their own
  configuration. The `--enc` flag is still accepted for script compatibility
  but is no longer needed.
- **Storage passwords are no longer copied into your backup.** A provider's
  password (and any other credential it marks as secret) is now kept only in
  the local backup configuration and is no longer written into the data
  distributed to your storage. This takes effect from the next `bfs push`;
  data written by earlier versions keeps the old credentials until pushed
  again. When you recover a backup on a fresh machine, BFS asks for the
  storage password only when it is actually needed — and a shared password
  entered once via `--bootstrap` is reused for every storage location that
  uses it, so a typical single-server setup recovers without extra prompts.
- **More CLI messages respect `--lang`.** A range of errors and prompts that were
  previously English-only — across `bfs push`, `bfs pull` / restore, version
  selection, and `bfs provider remove` — are now shown in the configured
  language (e.g. "password required", "passwords do not match", "not enough
  storage pieces", "pull cancelled", "no versions available"). User-facing
  messages also now broadly avoid the internal term "vault".
- **Adapter contract (`bfs-vault/provider`): optional `connectForRecovery` hook.**
  Storage adapters may now implement `connectForRecovery(io, pool, options?)` to
  show the operator the destination host before any secret is sent during
  `bfs recovery` (the built-in FTP adapter does). Adapters that don't implement it
  fall back to the previous prompt flow and remain exposed to the recovery
  credential-phishing vector for unencrypted backups — implement the hook to opt
  into the defense. No `BFS_PROVIDER_API_VERSION` bump (the method is optional).

### Fixed
- **`bfs pull --allow-missing-adapters` now restores instead of crashing when a
  provider's adapter is missing.** With the flag set, a backup whose provider
  uses a third-party adapter that is no longer installed previously still aborted
  the restore with an "unknown provider type" error — even when enough other
  providers were reachable to rebuild the data. That provider's piece is now
  skipped and the backup is reconstructed from the remaining ones, matching how
  `bfs recovery` already behaves and what the flag promises.
- **`bfs init` now rejects duplicate provider names instead of silently
  accepting them.** Passing two `--provider` specs that share a name (or entering
  the same name twice during interactive setup) previously wrote both into the
  backup configuration, where later operations resolved the name to the first
  entry and quietly orphaned the other storage — skewing the redundancy scheme.
  `bfs init` now aborts with a clear error naming the duplicate, and no
  configuration is written.
- **Cancelling an interactive prompt no longer leaks a raw `User force closed
  the prompt` message in the installed CLI.** In the published package, pressing
  Ctrl+C at a prompt — or running an interactive command such as `bfs prune`
  with no terminal attached (piped or closed input) — could print Inquirer's
  internal force-close text to stderr instead of cancelling quietly. The
  cancellation is now recognized reliably across `bfs init`, `bfs prune`,
  `bfs recovery`, and `bfs provider remove`, so it always ends cleanly.
- **Rebuilding a removed provider's data no longer leaves an encrypted backup
  unrestorable.** `bfs provider remove --strategy rebuild` wrote the reconstructed
  piece in an outdated, unencrypted on-disk format incompatible with the rest of
  the backup. `bfs verify` still reported the version healthy, but a `bfs pull`
  that needed the rebuilt piece could not decrypt it — quietly cutting redundancy
  until the data could no longer be restored. Rebuilt pieces are now written in the
  same format as the rest of the backup and restore correctly.
- **Disaster recovery now succeeds for a backup whose storage was relocated or
  rebuilt.** After moving a provider to a new address (`bfs provider remove
  --strategy relocate`) or rebuilding a removed provider's data onto another one,
  the affected version's stored headers were rewritten in an outdated format. A
  normal `bfs pull` still restored the data, but if you then lost your local backup
  metadata and ran `bfs recovery`, the metadata was reconstructed incorrectly —
  every piece failed its integrity check and the version could not be restored.
  Recovery now reads the format correctly and restores these backups.

### Security
- **A tampered backup can no longer exhaust your memory while restoring.** When
  restoring a compressed backup, BFS now limits how much a single stored file —
  and the archive as a whole — is allowed to expand to, and stops with a clear
  error if a backup tries to expand far beyond the amount of data it actually
  holds. This protects against a "decompression bomb": a small, maliciously
  crafted backup that would otherwise unpack into enough data to crash the
  machine.
- **Local backup metadata and cached data are now owner-only.** In addition to
  `config.json`, BFS now writes `state.json`, the version manifests, and any
  cached backup data under `.bfs/cache/` with owner-only permissions (`0600`),
  and creates the cache directory `0700` — matching the protection already
  applied to the configuration. On POSIX this keeps a backup's metadata
  (including the storage coordinates recorded in each manifest) and any transient
  plaintext copy of your data readable only by the owning user. On Windows these
  POSIX mode bits are a no-op; the access control of the directory holding
  `.bfs/` remains the practical protection.
- **Backup names and FTP paths are rejected when they contain unsafe characters.**
  A backup name containing a path separator or `..` would otherwise become part of
  the folder path on every storage, so a careless or pasted name could place backup
  data — and later delete it — outside the intended directory, on local disks and
  over FTP alike; `bfs init` rejects such names with a clear error before any
  configuration is written. A backup name or FTP provider path that contains a
  control character (a line break or NUL byte) is likewise refused — when the
  provider is configured and again before any path is sent to the server — closing
  a control-channel injection vector on the FTP command stream.
- **A malformed backup header can no longer exhaust memory during `bfs pull` or
  `bfs recovery`.** A tampered or corrupted backup piece could declare an
  absurdly large internal chunk size that the restore path tried to allocate up
  front, aborting the operation — most dangerous when recovering from storage
  you do not fully control. Such headers are now rejected as corrupted with a
  clear error instead.
- **Recovery can no longer be tricked into sending your storage password to an
  attacker.** Restoring an unencrypted backup with `bfs recovery` trusted the
  recovered piece's record of where the other pieces live; a single tampered
  piece could redirect a provider to the attacker's host, so the password you
  typed went there — and it stuck in the rebuilt configuration, so your next push
  would ship data there too. Recovery now shows each destination before any
  password is sent and lets you decline, cross-checks the recovered locations
  across pieces and aborts on a mismatch, and the first write after recovery —
  whether a push or a `bfs provider remove` that relocates or rebuilds storage —
  confirms where data will go. Unattended recovery can opt out of the
  per-destination prompt with `bfs recovery --trust-locations`. (Encrypted
  backups were never exposed — their location record is authenticated.)
- **Rebuilding a removed provider now aborts if the remaining pieces disagree
  about the backup's identity.** `bfs provider remove --strategy rebuild` took
  the backup metadata from the first piece it read; a tampered piece in an
  unencrypted backup could feed it forged values unnoticed. It now cross-checks
  the available pieces and refuses to rebuild on a mismatch.

## [0.6.2] - 2026-06-07

### Security
- **A restore can no longer write files outside the directory you are restoring
  into.** When restoring or recovering a backup, BFS now rejects any stored file
  whose path would escape the target directory — an absolute path, a `..`
  traversal, or a path containing a NUL byte — and stops with a clear error
  instead of writing that file. This hardens restores against tampered storage:
  a modified backup can no longer drop a file into your home directory, an
  autostart location, or other system paths while you restore. Honest backups,
  encrypted or not, are unaffected. The protection applies to both compressed and
  uncompressed backups.
- **A tampered backup header is rejected instead of crashing the process.**
  Reading a backup whose internal size fields have been altered to implausible
  values now fails with a clear error rather than attempting an enormous memory
  allocation, so a malformed or malicious backup cannot take down BFS during a
  restore or health check.

## [0.6.1] - 2026-05-31

### Changed
- **`bfs push --cache` now works after a partial push even on small backups.**
  Previously, when a backup was small enough for `bfs push` to keep the
  backup data in memory during the pack stage, no cache file was ever
  written to disk. If one provider then failed mid-push, the resulting
  `push.lock` pointed at a cache file that never existed, and a follow-up
  `bfs push --cache --overwrite` refused with a misleading "missing file"
  message. The first upload failure during a partial push now writes the
  backup data to `.bfs/cache/push.blob.pending` as a safety net, so the
  resume command can heal the degraded version without re-packing.
- **Clearer error when `bfs push --cache` cannot resume.** When the safety
  net itself cannot land (e.g. the cache directory is on a disk that ran
  out of space), `push.lock` now records that no cached data is available.
  A subsequent `bfs push --cache` refuses with a new message stating that
  the cache was not persisted and pointing at `bfs clear`, instead of the
  generic "missing file" message that suggested the file was deleted.

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

[Unreleased]: https://github.com/pfranczyk/bfs/compare/v0.9.1...HEAD
[0.9.1]: https://github.com/pfranczyk/bfs/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/pfranczyk/bfs/compare/v0.8.1...v0.9.0
[0.8.1]: https://github.com/pfranczyk/bfs/compare/v0.8.0...v0.8.1
[0.8.0]: https://github.com/pfranczyk/bfs/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/pfranczyk/bfs/compare/v0.6.2...v0.7.0
[0.6.2]: https://github.com/pfranczyk/bfs/compare/v0.6.1...v0.6.2
[0.6.1]: https://github.com/pfranczyk/bfs/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/pfranczyk/bfs/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/pfranczyk/bfs/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/pfranczyk/bfs/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pfranczyk/bfs/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pfranczyk/bfs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pfranczyk/bfs/releases/tag/v0.1.0
