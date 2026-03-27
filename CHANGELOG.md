# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/pfranczyk/bfs/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/pfranczyk/bfs/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/pfranczyk/bfs/releases/tag/v0.1.0
