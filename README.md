# BFS - Backup File System

Distributed backup CLI tool for Node.js. Packs a directory into a binary blob,
compresses it with deflate, splits using Reed-Solomon erasure coding, encrypts
every shard with AES-256-GCM (on by default), and distributes the shards across
multiple storage providers. Any N of N+K
shards can reconstruct the original data - losing up to K providers does not
cause data loss.

The flip side is worth knowing before you commit: **a restore needs N providers
reachable at the same time.** Tools that replicate a whole repository (restic,
borg, kopia) need just one working copy, so they fare better when the question is
"my disk died". BFS trades that for a different property - no single storage ever
holds enough to read your data, so it fares better when the question is "I don't
trust any one place with all of it". See
[When BFS fits](#when-bfs-fits) before choosing it as your only backup.

```
bfs init photos
bfs push
bfs pull
```

## Features

- **Reed-Solomon erasure coding** - configurable N data + K parity shards
- **Deflate compression** - the whole backup is packed into a single deflate-compressed ZIP. No fixed default: at `bfs init` a directory scan settles it per backup, proposing off when the data is mostly already-compressed (images, video, archives), while `bfs init --compress` / `--no-compress` decide it outright. Override per push with `--compress` / `--no-compress`
- **AES-256-GCM encryption** - on by default (opt out with `bfs init --no-enc`), Argon2id key derivation
- **Provider-agnostic** - local disk, USB drives, network mounts, FTP/FTPS, SSH/SFTP (WebDAV and SMB coming soon; cloud storage via external adapters)
- **Versioned backups** - by default every push creates a new numbered version; can be configured to overwrite the current version instead
- **Self-describing shards** - each shard contains the full location map, so one shard is enough to *find* the others (reading the data still needs N of them)
- **Resilient pushes** - when a provider fails mid-push, BFS finishes with the rest and records which targets failed; retry just those without re-uploading the whole backup
- **Disaster recovery** - rebuild the `.bfs/` configuration from a single shard when everything else is lost, then restore once N providers are reachable. A version whose password you did not have at hand is recorded rather than skipped: `bfs versions` lists it as present but not recovered, and `bfs pull --version <n> --password <its password>` fetches it later without a second recovery run
- **Interactive REPL** - run `bfs` without arguments for a guided prompt
- **CI/cron support** - all commands support non-interactive flags

## Requirements

- Node.js >= 24 - newer than what Debian stable and Ubuntu LTS ship, so install it
  from [NodeSource](https://github.com/nodesource/distributions) or a version
  manager (nvm, fnm) rather than your distribution's package manager
- Minimum 4 GB RAM (BFS uses ~25% of system memory for Reed-Solomon encoding)
- **Windows only:** [Microsoft Visual C++ Redistributable 2015-2022 (x64)](https://aka.ms/vs/17/release/vc_redist.x64.exe) - required by the Argon2 native binding (Windows 11 desktop typically has this pre-installed; Windows Server usually does not)

## Installation

```bash
npm install -g bfs-vault
```

## Quick start

```bash
# 1. Go to the directory you want to back up
cd ~/documents

# 2. Initialize vault (interactive - asks for providers, scheme, encryption, compression, and RAM limit)
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
| `bfs verify [--deep]` | Check part availability and health across providers; flag missing or damaged header files. Exits **0** healthy, **4** degraded, **5** damaged (**1** = the check itself could not run). `--deep` additionally downloads every part and re-checks its checksum, catching silent bit-rot the header check cannot see |
| `bfs prune [range] [--keep-last N]` | Delete old backup versions - pass an explicit range (`5`, `1-10`, `1,3,5`) or `--keep-last N` to keep the newest N |
| `bfs recovery` | Rebuild `.bfs/` from providers (disaster recovery) |
| `bfs repair` | Fix a backup's storage locations without re-uploading - repoint a moved device, rebuild a lost part, or restore missing/damaged header files (`--restore-headers`) |
| `bfs clear` | Delete pending cache and stale lock files from an interrupted push or pull |
| `bfs scheme set <N> <K>` | Change the Reed-Solomon N/K scheme (minimum 2/1) |
| `bfs config [--cache-dir <path>] [--temp-dir <path>] [--max-ram <MB>] [--on <feature>] [--off <feature>]` | View or change per-backup settings (cache dir, temp dir, RAM limit, toggle compression/encryption) |
| `bfs provider add` | Add a new provider to the vault |
| `bfs provider list` | List configured providers |
| `bfs provider edit [name]` | Edit a provider's connection settings - writes only local config, never the backup |
| `bfs provider remove [name]` | Remove or replace a provider (with heal option) |

Global options:
- `--cwd <dir>` - vault working directory (overrides current directory)
- `--lang <code>` - set UI language permanently (`en`, `pl`)

## How it works

```
push:  scan dir -> pack blob [+compress] -> Reed-Solomon encode -> [encrypt each shard] -> upload x (N+K)
pull:  read manifest -> download N shards -> [decrypt each shard] -> Reed-Solomon decode -> [decompress] -> write files
```

Each provider holds exactly one shard per version. No single provider has
enough data to reconstruct the backup. The location map of all shards is
embedded in each shard header - one surviving shard is sufficient to locate
and download the rest.

Symbolic links and special files (sockets, FIFOs, devices) are never stored in a
backup - a link may point outside the directory or form a loop, and a device is
not a file. `bfs push` does not drop them silently: it lists them and stops, so
you can add them to `.bfsignore` (interactively it offers to do this and retry)
or re-run with `--allow-excluded` to back up everything else. A scripted push
exits with code **3** when it finds such entries and `--allow-excluded` was not
given.

## Reed-Solomon scheme

Configure N (data shards) and K (parity shards) during `bfs init`:

| Scheme | Providers needed | Can lose up to | Needed to restore |
|---|---|---|---|
| 3+1 | 4 | 1 provider | 3 reachable at once |
| 3+2 | 5 | 2 providers | 3 reachable at once |
| 5+3 | 8 | 3 providers | 5 reachable at once |

Minimum scheme is **2 data + 1 parity**. Anything lower is refused by `bfs init` / `bfs scheme set`, and `bfs status` warns when the live scheme drops below the floor (e.g. after a manual config edit) - further pushes are disabled until the scheme is restored.

## When BFS fits

BFS is not a replacement for a conventional backup tool; it answers a different
question. Deciding which question is yours matters more than any feature list.

**It fits when no single storage should hold a complete copy.** Every provider
keeps one shard - never a whole backup. With encryption on (the default), a
shard is unreadable without your password. That is the property restic, borg,
kopia and duplicati do not have: they replicate a whole repository, so anyone who
obtains one copy obtains everything in it. If your worry is an untrusted cloud, a
borrowed server or a drive that may leave your control, this is the trade you
want. Note that **without encryption a single shard is not opaque** - it holds
verbatim slices of the packed data and the file list; see
[SECURITY.md](SECURITY.md#what-a-single-storage-provider-can-see) for exactly
what one provider can read in each mode.

**It fits poorly when data changes often, or when there is a lot of it.** Every
push writes a full new snapshot - there is no incremental mode and no
deduplication, so changing a few bytes in one file re-uploads everything. The
space each version occupies is roughly `packed size x (N+K)/N`, and versions
accumulate until you `bfs prune` them. For tens of gigabytes that change daily,
an incremental tool will cost far less time and space. For data that rarely
changes - documents, photo archives, keys, configuration - the difference is
academic.

**Restoring needs N providers at once**, as the table above shows. A tool holding
complete copies needs one of them alive; BFS needs a quorum. Weigh that against
what it buys you, rather than discovering it during a restore.

**Prior art.** Splitting data across independent storages with erasure coding is
a well-established idea - Tahoe-LAFS (2007), RACS, Cleversafe, and later Storj
and Sia all build on it. What BFS does differently is scope, not mathematics: it
applies that model to storage you already own, from a single-user CLI, with no
grid to deploy and no provider network to join.

## CI / cron usage

All modifying commands support non-interactive flags.

**Initialize** - keep credentials in config files so they never appear on the command line:

`ftp-remote1.json` (secure with `chmod 600`):
```json
{ "host": "192.168.1.10", "user": "backup", "password": "secret", "path": "/bfs", "accept_new_cert": true }
```

FTPS is on by default, and a scripted run has nobody to ask about an unknown
certificate - so it must say up front which certificate to trust: pin it with
`"cert_fingerprint": "AA:BB:..."` (or `--cert-fingerprint`), or accept the one the
server presents on first connection with `"accept_new_cert": true` (or
`--accept-new-cert`). Without either, BFS refuses instead of trusting silently.
A server that offers only plain FTP needs `"secure": false`.

`ssh-vps1.json` (key auth - the private key stays a path, never inline):
```json
{ "host": "vps.example.com", "user": "backup", "private_key_path": "/home/me/.ssh/id_ed25519", "path": "/srv/bfs", "host_key_fingerprint": "SHA256:..." }
```

Mix local disks, FTP, and SSH/SFTP in one backup - each provider holds one part (3 data + 2 parity = 5 providers):

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
# Back up - new version
bfs push --new --password-file /etc/bfs/vault.pass

# Prune - keep last 14 versions
bfs prune --keep-last 14 --yes
```

Keep the password in a file readable only by the account running the job
(`chmod 600 /etc/bfs/vault.pass`) and pass `--password-file`. Do **not** use
`--password "$VAULT_PASS"`: the shell expands the variable before starting the
command, so the password ends up in the process arguments, where
`/proc/<pid>/cmdline` exposes it to every local account for as long as the
backup runs. `--password-file` works the same way in `pull`, `recovery`,
`repair` and `provider remove`.

A scheduled `bfs push` exits with code **3** if the directory contains symbolic
links or special files (they cannot be backed up) - so a cron job fails loudly
instead of quietly saving an incomplete backup. Add `--allow-excluded` to back up
everything else without failing, or list the entries in `.bfsignore`.

## Providers

Currently supported:

| Type | Description |
|---|---|
| `local` | Local directory, USB drive, network mount |
| `ftp` | FTP/FTPS server (uses `basic-ftp`) |
| `ssh` | SSH/SFTP server (uses `ssh2`) |

Coming soon (built into BFS core): `webdav` (WebDAV -
Nextcloud, ownCloud, Apache/nginx), `smb` (SMB/CIFS network shares).

Cloud storage (Google Drive, OneDrive, Dropbox, S3/Backblaze B2, ...) ships as
**external adapters**, not built-in - installed on demand and updated
independently of BFS, so a provider's API change never forces a BFS upgrade.

### FTP provider

Provider details can be given as inline flags, a JSON config file, or both - inline flags override file values.

**Inline flags:**

```bash
bfs init --ci docs --data-shards 2 --parity-shards 1 \
  --provider "ftp:nas1 --host ftp.example.com --user backup --password secret --path /backup --accept-new-cert" \
  --provider "ftp:nas2 --host ftp2.example.com --user backup --password secret --path /backup --accept-new-cert" \
  --provider "local:usb --path /media/usb"
```

FTPS is on by default, so a scripted run has to say which certificate to trust -
`--accept-new-cert` takes the one the server presents on first connection, and
`--cert-fingerprint AA:BB:...` pins one you already know. Without either, `--ci`
refuses rather than trusting silently.

**Config file** - recommended when credentials come from environment variables or a secrets manager:

`nas.json` (secure with `chmod 600`):
```json
{
  "host": "ftp.example.com",
  "port": 21,
  "user": "backup",
  "password": "secret",
  "path": "/backup",
  "accept_new_cert": true
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
| `--host <hostname>` | - | FTP server hostname or IP (required) |
| `--port <number>` | `21` | FTP server port |
| `--user <username>` | - | FTP login user |
| `--password <password>` | - | FTP login password |
| `--path </absolute/path>` | - | Absolute base path on server, must start with `/` (required) |
| `--secure <bool>` | `true` | FTPS/TLS - on by default; pass `false` for a server that offers only plain FTP (accepts `true`/`false`/`yes`/`no`) |
| `--cert-fingerprint <sha256>` | - | Pin the server's certificate up front (`AA:BB:...` form) |
| `--accept-new-cert` | - | Trust the certificate presented on first connection without asking (pins nothing - see `--cert-fingerprint`) |
| `--config-file <path>` | - | JSON file with any of the above fields; inline flags override file values |

### SSH/SFTP provider

Store parts on any SSH server (NAS, VPS, Raspberry Pi) over SFTP. Authenticate with a password **or** an SSH key - the private key is always given as a **file path**, never pasted into the terminal. With no password and no `--private-key`, BFS falls back to your default key in `~/.ssh` (`id_ed25519`, then `id_rsa`).

**Inline flags (password auth):**

```bash
bfs init --ci docs --data-shards 2 --parity-shards 1 \
  --provider "ssh:nas1 --host nas.example.com --user backup --password secret --path /backup" \
  --provider "ssh:nas2 --host nas2.example.com --user backup --password secret --path /backup" \
  --provider "local:usb --path /media/usb"
```

**Key auth + config file** - recommended when credentials come from environment variables or a secrets manager:

`nas.json` (secure with `chmod 600`):
```json
{
  "host": "nas.example.com",
  "port": 22,
  "user": "backup",
  "private_key_path": "/home/backup/.ssh/id_ed25519",
  "path": "/backup",
  "host_key_fingerprint": "SHA256:..."
}
```

```bash
bfs init --ci docs --data-shards 2 --parity-shards 1 \
  --provider "ssh:nas1 --config-file ./nas.json" \
  --provider "ssh:nas2 --config-file ./nas2.json" \
  --provider "local:usb --path /media/usb"
```

The server's host key is verified on first connection: accepted interactively, pinned with `--known-host <fingerprint>` (or `host_key_fingerprint` in the config), or accepted up front with `--accept-new-host-key`, which trusts the key presented on first contact and pins its fingerprint without asking. A later host-key change is then flagged.

SSH flag reference:

| Flag | Default | Description |
|---|---|---|
| `--host <hostname>` | - | SSH server hostname or IP (required) |
| `--port <number>` | `22` | SSH server port |
| `--user <username>` | - | SSH login user |
| `--password <password>` | - | Password auth (mutually exclusive with `--private-key`) |
| `--private-key <path>` | - | Path to an SSH private key file for key auth |
| `--passphrase <passphrase>` | - | Passphrase for the private key, if it is encrypted |
| `--path </absolute/path>` | - | Absolute base path on server, must start with `/` (required) |
| `--known-host <fingerprint>` | - | Pin the server's host key (`SHA256:...`) |
| `--accept-new-host-key` | - | Trust a new host key on first contact and pin its fingerprint, without prompting |
| `--config-file <path>` | - | JSON file with any of the above fields; inline flags override file values |

**Adding a provider to an existing vault:**

```bash
# Interactive
bfs provider add

# Non-interactive - inline
bfs provider add --ci --name nas --type ftp \
  --host ftp.example.com --user backup --password secret --path /backup

# Non-interactive - config file
bfs provider add --ci --name nas --type ftp \
  --config-file ./nas.json
```

## Platform notes

BFS runs on Linux, macOS, and Windows, and a backup created on one platform
restores on any other - shards and the on-disk format are byte-identical across
operating systems.

**Windows - protection of local credentials.** On Linux and macOS, BFS creates
`.bfs/` as `0700` and files holding provider secrets as `0600`, so other local
users cannot read them. On Windows these POSIX mode bits are a **no-op** - NTFS
uses ACLs, not Unix permissions - so BFS cannot restrict `.bfs/` that way. The
practical protection on Windows is the access control of the directory that
holds `.bfs/`: keep your vault under a per-user profile path (e.g. inside your
own `C:\Users\<you>\...`) rather than a world-readable shared location. See
[SECURITY.md](SECURITY.md) for the full threat model.

## Versioning

BFS uses [Semantic Versioning](https://semver.org).

## License

[AGPL-3.0-or-later](LICENSE) (c) Paweł Franczyk
