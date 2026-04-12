# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

[Unreleased]: https://github.com/pfranczyk/bfs/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/pfranczyk/bfs/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/pfranczyk/bfs/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/pfranczyk/bfs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pfranczyk/bfs/releases/tag/v0.1.0
