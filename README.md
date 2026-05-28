# BFS — Backup File System

Distributed backup CLI tool for Node.js. Packs a directory into a binary blob,
compresses it with deflate, optionally encrypts with AES-256-GCM, splits using
Reed-Solomon erasure coding, and distributes shards across multiple storage providers. Any N of N+K
shards can reconstruct the original data — losing up to K providers does not
cause data loss.

```
bfs init photos
bfs push
bfs pull
```

## Features

- **Reed-Solomon erasure coding** — configurable N data + K parity shards
- **Deflate compression** — enabled by default, per-file ZIP with smart skip for already-compressed formats (images, video, archives)
- **AES-256-GCM encryption** — optional, Argon2id key derivation
- **Provider-agnostic** — local disk, USB drives, network mounts, FTP/FTPS (SSH — coming soon)
- **Versioned backups** — every push creates a new numbered version
- **Self-describing shards** — each shard contains the full location map; one shard is enough to discover the rest
- **Resilient pushes** — when a provider fails mid-push, BFS finishes with the rest and records which targets failed; retry just those without re-uploading the whole backup
- **Disaster recovery** — rebuild `.bfs/` config from a single shard when everything else is lost
- **Interactive REPL** — run `bfs` without arguments for a guided prompt
- **CI/cron support** — all commands support non-interactive flags

## Requirements

- Node.js >= 23
- Minimum 4 GB RAM (BFS uses ~25% of system memory for Reed-Solomon encoding)
- **Windows only:** [Microsoft Visual C++ Redistributable 2015–2022 (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) — required by the Argon2 native binding (Windows 11 desktop typically has this pre-installed; Windows Server usually does not)

## Installation

```bash
npm install -g bfs-vault
```

## Quick start

```bash
# 1. Go to the directory you want to back up
cd ~/documents

# 2. Initialize vault (interactive — asks for providers, scheme, encryption)
bfs init documents

# 3. Back up
bfs push

# 4. Restore
bfs pull
```

## Commands

| Command | Description |
|---|---|
| `bfs init [<name>]` | Initialize a new vault in the current directory (name is the subfolder created on each provider) |
| `bfs push` | Back up (new version or overwrite, based on config) |
| `bfs pull [--version N] [-y]` | Restore files from backup (default: latest version); `-y/--yes` auto-confirms overwrite |
| `bfs status` | Show vault status |
| `bfs versions` | List all backup versions with health status |
| `bfs verify` | Check shard availability and health across providers |
| `bfs prune [range] [--keep-last N]` | Delete old backup versions — pass an explicit range (`5`, `1-10`, `1,3,5`) or `--keep-last N` to keep the newest N |
| `bfs recovery` | Rebuild `.bfs/` from providers (disaster recovery) |
| `bfs clear` | Delete pending cache and stale lock files from an interrupted push or pull |
| `bfs scheme set <N> <K>` | Change the Reed-Solomon N/K scheme (minimum 2/1) |
| `bfs config [--cache-dir <path>] [--temp-dir <path>] [--max-ram <MB>] [--on <feature>] [--off <feature>]` | View or change per-backup settings (cache dir, temp dir, RAM limit, toggle compression/encryption) |
| `bfs provider add` | Add a new provider to the vault |
| `bfs provider list` | List configured providers |
| `bfs provider remove [name]` | Remove or replace a provider (with heal option) |

Global options:
- `--cwd <dir>` — vault working directory (overrides current directory)
- `--lang <code>` — set UI language permanently (`en`, `pl`)

## How it works

```
push:  scan dir → pack blob → [compress] → [encrypt] → Reed-Solomon encode → shards → upload × (N+K)
pull:  read manifest → download N shards → Reed-Solomon decode → [decrypt] → [decompress] → write files
```

Each provider holds exactly one shard per version. No single provider has
enough data to reconstruct the backup. The location map of all shards is
embedded in each shard header — one surviving shard is sufficient to locate
and download the rest.

## Reed-Solomon scheme

Configure N (data shards) and K (parity shards) during `bfs init`:

| Scheme | Providers needed | Can lose up to |
|---|---|---|
| 3+1 | 4 | 1 provider |
| 3+2 | 5 | 2 providers |
| 5+3 | 8 | 3 providers |

Minimum scheme is **2 data + 1 parity**. Anything lower is refused by `bfs init` / `bfs scheme set`, and `bfs status` warns when the live scheme drops below the floor (e.g. after a manual config edit) — further pushes are disabled until the scheme is restored.

## CI / cron usage

All modifying commands support non-interactive flags:

```bash
# Initialize
bfs init --ci docs --data-shards 3 --parity-shards 2 \
  --provider "local:nas1 --path /backup" \
  --provider "local:nas2 --path /backup" \
  --provider "local:usb1 --path /backup" \
  --provider "local:usb2 --path /backup" \
  --provider "local:usb3 --path /backup"

# Scheduled backup (crontab)
bfs push --new --password "$VAULT_PASS"

# Prune — keep last 14 versions
bfs prune --keep-last 14 --yes
```

## Providers

Currently supported:

| Type | Description |
|---|---|
| `local` | Local directory, USB drive, network mount |
| `ftp` | FTP/FTPS server (uses `basic-ftp`) |

Planned: SSH/SFTP.

## Versioning

BFS uses [Semantic Versioning](https://semver.org).

## License

[AGPL-3.0-or-later](LICENSE) © Paweł Franczyk
