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
- **Deflate compression** — on by default; the whole backup is packed into a single deflate-compressed ZIP. At `bfs init` a directory scan suggests whether to enable it, defaulting to off when the data is mostly already-compressed (images, video, archives). Override per push with `--compress` / `--no-compress`
- **AES-256-GCM encryption** — on by default (opt out with `bfs init --no-enc`), Argon2id key derivation
- **Provider-agnostic** — local disk, USB drives, network mounts, FTP/FTPS, SSH/SFTP (WebDAV and SMB coming soon; cloud storage via external adapters)
- **Versioned backups** — by default every push creates a new numbered version; can be configured to overwrite the current version instead
- **Self-describing shards** — each shard contains the full location map; one shard is enough to discover the rest
- **Resilient pushes** — when a provider fails mid-push, BFS finishes with the rest and records which targets failed; retry just those without re-uploading the whole backup
- **Disaster recovery** — rebuild `.bfs/` config from a single shard when everything else is lost
- **Interactive REPL** — run `bfs` without arguments for a guided prompt
- **CI/cron support** — all commands support non-interactive flags

## Requirements

- Node.js >= 24
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

# 2. Initialize vault (interactive — asks for providers, scheme, encryption, compression, and RAM limit)
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
| `bfs verify` | Check part availability and health across providers; flag missing or damaged header files |
| `bfs prune [range] [--keep-last N]` | Delete old backup versions — pass an explicit range (`5`, `1-10`, `1,3,5`) or `--keep-last N` to keep the newest N |
| `bfs recovery` | Rebuild `.bfs/` from providers (disaster recovery) |
| `bfs repair` | Fix a backup's storage locations without re-uploading — repoint a moved device, rebuild a lost part, or restore missing/damaged header files (`--restore-headers`) |
| `bfs clear` | Delete pending cache and stale lock files from an interrupted push or pull |
| `bfs scheme set <N> <K>` | Change the Reed-Solomon N/K scheme (minimum 2/1) |
| `bfs config [--cache-dir <path>] [--temp-dir <path>] [--max-ram <MB>] [--on <feature>] [--off <feature>]` | View or change per-backup settings (cache dir, temp dir, RAM limit, toggle compression/encryption) |
| `bfs provider add` | Add a new provider to the vault |
| `bfs provider list` | List configured providers |
| `bfs provider edit [name]` | Edit a provider's connection settings locally (offline — no storage contact) |
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

All modifying commands support non-interactive flags.

**Initialize** — keep credentials in config files so they never appear on the command line:

`ftp-remote1.json` (secure with `chmod 600`):
```json
{ "host": "192.168.1.10", "user": "backup", "password": "secret", "path": "/bfs" }
```

`ssh-vps1.json` (key auth — the private key stays a path, never inline):
```json
{ "host": "vps.example.com", "user": "backup", "private_key_path": "/home/me/.ssh/id_ed25519", "path": "/srv/bfs", "host_key_fingerprint": "SHA256:…" }
```

Mix local disks, FTP, and SSH/SFTP in one backup — each provider holds one part (3 data + 2 parity = 5 providers):

```bash
bfs init --ci docs --data-shards 3 --parity-shards 2 \
  --provider "local:nas1 --path /mnt/nas1/backup" \
  --provider "local:usb --path /media/usb/backup" \
  --provider "ftp:remote1 --config-file ./ftp-remote1.json" \
  --provider "ssh:vps1 --config-file ./ssh-vps1.json" \
  --provider "ssh:pi --host 192.168.1.20 --user backup --private-key ~/.ssh/id_ed25519 --path /srv/bfs --accept-new-host-key"
```

**Scheduled backup and maintenance (crontab):**

```bash
# Back up — new version
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
| `ssh` | SSH/SFTP server (uses `ssh2`) |

Coming soon (built into BFS core): `webdav` (WebDAV —
Nextcloud, ownCloud, Apache/nginx), `smb` (SMB/CIFS network shares).

Cloud storage (Google Drive, OneDrive, Dropbox, S3/Backblaze B2, …) ships as
**external adapters**, not built-in — installed on demand and updated
independently of BFS, so a provider's API change never forces a BFS upgrade.

### FTP provider

Provider details can be given as inline flags, a JSON config file, or both — inline flags override file values.

**Inline flags:**

```bash
bfs init --ci docs --data-shards 2 --parity-shards 1 \
  --provider "ftp:nas1 --host ftp.example.com --user backup --password secret --path /backup" \
  --provider "ftp:nas2 --host ftp2.example.com --user backup --password secret --path /backup" \
  --provider "local:usb --path /media/usb"
```

**Config file** — recommended when credentials come from environment variables or a secrets manager:

`nas.json` (secure with `chmod 600`):
```json
{
  "host": "ftp.example.com",
  "port": 21,
  "user": "backup",
  "password": "secret",
  "path": "/backup"
}
```

```bash
bfs init --ci docs --data-shards 2 --parity-shards 1 \
  --provider "ftp:nas1 --config-file ./nas.json" \
  --provider "ftp:nas2 --config-file ./nas2.json" \
  --provider "local:usb --path /media/usb"
```

FTP flag reference:

| Flag | Default | Description |
|---|---|---|
| `--host <hostname>` | — | FTP server hostname or IP (required) |
| `--port <number>` | `21` | FTP server port |
| `--user <username>` | — | FTP login user |
| `--password <password>` | — | FTP login password |
| `--path </absolute/path>` | — | Absolute base path on server, must start with `/` (required) |
| `--secure <bool>` | `false` | Enable FTPS/TLS — accepts `true`/`false`/`yes`/`no` |
| `--config-file <path>` | — | JSON file with any of the above fields; inline flags override file values |

### SSH/SFTP provider

Store parts on any SSH server (NAS, VPS, Raspberry Pi) over SFTP. Authenticate with a password **or** an SSH key — the private key is always given as a **file path**, never pasted into the terminal. With no password and no `--private-key`, BFS falls back to your default key in `~/.ssh` (`id_ed25519`, then `id_rsa`).

**Inline flags (password auth):**

```bash
bfs init --ci docs --data-shards 2 --parity-shards 1 \
  --provider "ssh:nas1 --host nas.example.com --user backup --password secret --path /backup" \
  --provider "ssh:nas2 --host nas2.example.com --user backup --password secret --path /backup" \
  --provider "local:usb --path /media/usb"
```

**Key auth + config file** — recommended when credentials come from environment variables or a secrets manager:

`nas.json` (secure with `chmod 600`):
```json
{
  "host": "nas.example.com",
  "port": 22,
  "user": "backup",
  "private_key_path": "/home/backup/.ssh/id_ed25519",
  "path": "/backup",
  "host_key_fingerprint": "SHA256:…"
}
```

```bash
bfs init --ci docs --data-shards 2 --parity-shards 1 \
  --provider "ssh:nas1 --config-file ./nas.json" \
  --provider "ssh:nas2 --config-file ./nas2.json" \
  --provider "local:usb --path /media/usb"
```

The server's host key is verified on first connection: accepted interactively, pinned with `--known-host <fingerprint>` (or `host_key_fingerprint` in the config), or trusted for scripted runs with `--accept-new-host-key`. A later host-key change is then flagged.

SSH flag reference:

| Flag | Default | Description |
|---|---|---|
| `--host <hostname>` | — | SSH server hostname or IP (required) |
| `--port <number>` | `22` | SSH server port |
| `--user <username>` | — | SSH login user |
| `--password <password>` | — | Password auth (mutually exclusive with `--private-key`) |
| `--private-key <path>` | — | Path to an SSH private key file for key auth |
| `--passphrase <passphrase>` | — | Passphrase for the private key, if it is encrypted |
| `--path </absolute/path>` | — | Absolute base path on server, must start with `/` (required) |
| `--known-host <fingerprint>` | — | Pin the server's host key (`SHA256:…`) |
| `--accept-new-host-key` | — | Trust a new host key without prompting (for `--ci`) |
| `--config-file <path>` | — | JSON file with any of the above fields; inline flags override file values |

**Adding a provider to an existing vault:**

```bash
# Interactive
bfs provider add

# Non-interactive — inline
bfs provider add --ci --name nas --type ftp \
  --host ftp.example.com --user backup --password secret --path /backup

# Non-interactive — config file
bfs provider add --ci --name nas --type ftp \
  --config-file ./nas.json
```

## Platform notes

BFS runs on Linux, macOS, and Windows, and a backup created on one platform
restores on any other — shards and the on-disk format are byte-identical across
operating systems.

**Windows — protection of local credentials.** On Linux and macOS, BFS creates
`.bfs/` as `0700` and files holding provider secrets as `0600`, so other local
users cannot read them. On Windows these POSIX mode bits are a **no-op** — NTFS
uses ACLs, not Unix permissions — so BFS cannot restrict `.bfs/` that way. The
practical protection on Windows is the access control of the directory that
holds `.bfs/`: keep your vault under a per-user profile path (e.g. inside your
own `C:\Users\<you>\…`) rather than a world-readable shared location. See
[SECURITY.md](SECURITY.md) for the full threat model.

## Versioning

BFS uses [Semantic Versioning](https://semver.org).

## License

[AGPL-3.0-or-later](LICENSE) © Paweł Franczyk
