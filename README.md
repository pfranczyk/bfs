# BFS — Backup File System

Distributed backup CLI tool for Node.js. Packs a directory into a binary blob,
optionally encrypts it with AES-256-GCM, splits it using Reed-Solomon erasure
coding, and distributes shards across multiple storage providers. Any N of N+K
shards can reconstruct the original data — losing up to K providers does not
cause data loss.

```
bfs init --name photos
bfs push
bfs pull
```

## Features

- **Reed-Solomon erasure coding** — configurable N data + K parity shards
- **AES-256-GCM encryption** — optional, Argon2id key derivation
- **Provider-agnostic** — local disk, USB drives, NAS (Google Drive, FTP, SSH — coming soon)
- **Versioned backups** — every push creates a new numbered version
- **Self-describing shards** — each shard contains the full location map; one shard is enough to discover the rest
- **Disaster recovery** — rebuild `.bfs/` config from a single shard when everything else is lost
- **Interactive REPL** — run `bfs` without arguments for a guided prompt
- **CI/cron support** — all commands support non-interactive flags

## Requirements

- Node.js >= 23

## Installation

```bash
npm install -g bfs-vault
```

## Quick start

```bash
# 1. Go to the directory you want to back up
cd ~/documents

# 2. Initialize vault (interactive — asks for providers, scheme, encryption)
bfs init --name documents

# 3. Back up
bfs push

# 4. Restore
bfs pull
```

## Commands

| Command | Description |
|---|---|
| `bfs init [--name <name>]` | Initialize a new vault in the current directory |
| `bfs push` | Back up (new version or overwrite, based on config) |
| `bfs pull [--version N] [-y]` | Restore files from backup (default: latest version); `-y/--yes` auto-confirms overwrite |
| `bfs status` | Show vault status |
| `bfs versions` | List all backup versions with health status |
| `bfs verify` | Check shard availability and health across providers |
| `bfs prune [--keep-last N]` | Delete old backup versions from providers |
| `bfs recovery` | Rebuild `.bfs/` from providers (disaster recovery) |
| `bfs clear` | Delete pending cache from an interrupted push or pull |
| `bfs scheme set <N> <K>` | Change the Reed-Solomon N/K scheme |
| `bfs provider add` | Add a new provider to the vault |
| `bfs provider list` | List configured providers |
| `bfs provider remove [name]` | Remove or replace a provider (with heal option) |

Global options:
- `--cwd <dir>` — vault working directory (overrides current directory)
- `--lang <code>` — set UI language permanently (`en`, `pl`)

## How it works

```
push:  scan dir → pack blob → [encrypt] → Reed-Solomon encode → shards → upload × (N+K)
pull:  read manifest → download N shards → Reed-Solomon decode → [decrypt] → write files
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

## CI / cron usage

All modifying commands support non-interactive flags:

```bash
# Initialize
bfs init --ci --name docs --data-shards 3 --parity-shards 2 \
  --provider local:nas1:/backup \
  --provider local:nas2:/backup \
  --provider local:usb1:/backup \
  --provider local:usb2:/backup \
  --provider local:usb3:/backup

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

Planned: Google Drive, FTP/FTPS, SSH/SFTP.

## Versioning

BFS uses [Semantic Versioning](https://semver.org).

## License

[AGPL-3.0-or-later](LICENSE) © Paweł Franczyk
