# Security Policy

BFS (Backup File System) is a distributed backup tool: it packs a directory
into a binary blob, optionally encrypts it, splits it with Reed-Solomon erasure
coding, and spreads the resulting shards across independent storage providers.
This document describes what that design protects, what it does not, and how to
report a vulnerability.

## Reporting a Vulnerability

Please report security issues **privately** — do not open a public issue for a
suspected vulnerability.

- **Preferred channel:** [GitHub Security Advisories](https://github.com/pfranczyk/bfs/security/advisories/new).
  This opens a private report visible only to the maintainer.

When reporting, include the affected version, a description of the issue, and a
minimal reproduction if you have one. We aim to acknowledge a report within a
few days and to coordinate disclosure with you: a fix and an advisory are
published together, and we credit reporters who wish to be named.

Public, non-security bugs belong in the normal
[issue tracker](https://github.com/pfranczyk/bfs/issues).

## Supported Versions

BFS is pre-1.0 and ships frequently. Security fixes are released against the
**latest published stable version** only. There is no long-term support branch
for older releases — upgrade to the newest stable version to receive security
updates.

Prerelease builds (e.g. `0.7.0-beta.x`, installed with `npm install -g
bfs-vault@beta`) are for evaluation only. They are **not** the supported stable
channel: their on-disk format and behavior may change before the matching stable
release, and a fix lands in the next prerelease or stable build — not as a patch
to an earlier beta. Do not rely on a beta for your only copy of important data.

| Version                  | Security updates                              |
| ------------------------ | --------------------------------------------- |
| Latest stable release    | ✅ Yes                                        |
| Prerelease / beta builds | ⚠️ Evaluation only — fixed in the next build  |
| Older releases           | ❌ No                                         |

## Encryption Defaults

- `bfs init` enables encryption **by default**, in both interactive and
  non-interactive (`--ci`) mode. Pass `--no-enc` to deliberately store a backup
  unencrypted; `--enc` is accepted but is a no-op (kept for script
  compatibility).
- The encryption password is chosen on the **first `bfs push`**, not at `init`.
  A non-interactive push of an encrypted backup with no password supplied fails
  loudly instead of silently writing plaintext.
- Existing backups are unaffected by the default: each backup's encryption
  setting is read from its own local configuration, so an automated push on a
  previously created backup keeps behaving exactly as before.

## Cryptography

- **Confidentiality + integrity:** AES-256-GCM. Each shard is encrypted as a
  single GCM message with a 16-byte authentication tag, so tampering with a
  shard is detected on decryption.
- **Key derivation:** Argon2id with a 16-byte random salt (regenerated on every
  push and stored per shard), memory cost 64 MiB, 3 iterations, parallelism 1.
  The 256-bit data key is derived from the user-chosen password and that salt.
- **Nonce derivation:** each shard's 12-byte GCM nonce is derived
  deterministically as `HMAC-SHA256(data_key, "shard_nonce" || version ||
  shard_index)[:12]`. Because a new push uses a fresh salt (hence a fresh key),
  and each shard within a version gets a distinct index, no `(key, nonce)` pair
  is ever reused.

## Threat Model

### What a single storage provider can see

Each provider stores exactly **one shard per backup version** — never enough
data, on its own, to reconstruct an encrypted backup. What a provider (or anyone
who obtains one shard) can read depends on whether encryption is enabled:

**Encrypted backup (the default):**

- The **backup data payload is encrypted** — unreadable without the password.
- The **location map** — the coordinates of every other shard (provider host,
  port, username, path) — is **encrypted**.
- A fixed set of **header metadata is in cleartext** (see below).

**Unencrypted backup (`--no-enc`):**

- The payload is plaintext **systematic** Reed-Solomon. A single shard contains
  directly readable fragments of your files; holding `N` of the `N+K` shards
  reconstructs everything verbatim.
- The location map is **plaintext** on every device: the address, username, and
  path of every storage location are visible to anyone holding any one shard,
  who can then locate and reach the rest.
- Storage **passwords are still not exposed** — they are stripped from shard
  headers regardless of encryption (see *Credential handling*).

### Metadata exposed in cleartext (both modes)

Every shard header carries the following in the clear, even for an encrypted
backup:

- a magic marker and binary format version,
- the backup's random UUID,
- the backup name (as you chose it at `init`),
- the total backup-data size,
- a SHA-256 hash of the **unencrypted** backup data,
- the scheme (data count `N`, parity count `K`),
- the shard's index and the version (snapshot) number,
- the encryption flag and, when encrypted, the KDF salt.

The cleartext content hash means an observer holding a shard can confirm whether
a backup matches a file they already possess. Reducing this header metadata
exposure is planned for a future binary-format revision.

### Credential handling

- **Storage credentials are never written into shard headers.** A provider's
  password — and any field an adapter marks as secret — is kept only in the
  local backup configuration (`.bfs/config.json`) and is stripped from the
  location map embedded in shards. Non-secret coordinates (host, port, username,
  path) remain, so one shard can still discover and reach the others.
- This takes effect **from the next push**. Shards written by an earlier version
  retain the old embedded credentials until that version is pushed again (or its
  provider is relocated/rebuilt). An update does not rewrite shards already on
  remote storage.

### Local credentials at rest

The local backup configuration stores provider credentials in plaintext on the
machine that runs BFS. BFS applies defense-in-depth file permissions —
`.bfs/config.json` is created mode `0600` and `.bfs/` mode `0700` — which
restrict access to the owning user on POSIX systems. On Windows these mode bits
are a no-op (NTFS uses ACLs, not POSIX permissions), so the practical protection
there is the access control of the directory holding `.bfs/`. This is **not**
encryption at rest: protect the host and the disk accordingly, and keep `.bfs/`
out of any unrelated version-control repository (BFS does not modify your
`.gitignore`).

### Redundancy and key custody

- Any `N` of the `N+K` shards reconstruct the backup; losing up to `K` providers
  loses no data.
- Redundancy is an availability property, not a confidentiality one. For an
  encrypted backup, an attacker who collects shards still cannot read anything
  without the password — and BFS cannot recover the data if the password is
  lost. There is no recovery backdoor and no key escrow: **if you lose the
  password, the backup is unrecoverable.**

### Integrity of a restored backup

Reed-Solomon coding provides redundancy, not integrity: given exactly `N` shards
it reconstructs whatever it is handed, including a tampered payload. Integrity is
enforced separately — by SHA-256 content hashes and, for an encrypted backup, the
per-shard AES-GCM authentication tag. As defense-in-depth, a restore additionally
refuses to write any file whose stored path would land outside the directory you
are restoring into (absolute paths, `..` traversal, NUL bytes), and rejects a
backup whose internal size fields have been altered to implausible values rather
than failing unpredictably. This bounds what a tampered storage device can do
during a restore — but it is not a substitute for encryption: an unencrypted
backup remains readable and alterable by anyone holding `N` shards.

## Cryptographic Limits

AES-GCM can safely encrypt only a bounded amount of data under one
`(key, nonce)` pair (~64 GiB, the point at which its 32-bit block counter
wraps). BFS encrypts each shard as one GCM message, so the limit applies per
shard. `bfs push` **refuses** to encrypt when a single data unit would exceed
**60 GiB** (a margin below the hard limit), with an error suggesting you raise
the data count (`bfs scheme set`) or back up a smaller directory — rather than
silently weakening the encryption. Because each shard holds roughly
`backup_size / N`, the total encrypted backup can be up to about `60 GiB × N`.

## Disaster Recovery and Interactivity

Recovering a backup on a fresh machine (`bfs recovery`) is **inherently
interactive**. Because credentials are stripped from shards, BFS asks for the
storage passwords it needs to reconnect to the remaining providers. A password
supplied once via `--bootstrap` is reused for every storage location that shares
it, so a typical single-server setup recovers without extra prompts; only
locations with a *different* credential are prompted for.

Known limitations:

- **No interactive terminal → graceful degrade.** In an environment without a
  TTY (CI, cron, a test harness), a provider that needs a password is skipped
  rather than prompted, and recovery never crashes — but that provider's shard
  is unavailable for the recovery.
- **No non-interactive path to supply a transport password yet.** Fully
  recovering a stripped backup that needs a credential other than the bootstrap
  one requires an interactive terminal. A non-interactive override for automated
  recovery is planned for a later release.

## Out of Scope

The following are explicitly outside BFS's threat model:

- **The host running BFS.** Malware, another local user with administrative
  rights, or physical access to the machine can read the local configuration
  (including plaintext provider credentials) and any decrypted data.
- **Password strength.** The confidentiality of an encrypted backup rests
  entirely on the password you choose; BFS does not enforce a policy.
- **Cleartext header metadata.** Backup name, size, scheme, and the content hash
  are not hidden (see *Metadata exposed in cleartext*).
- **Traffic and access-pattern analysis.** BFS does not obscure when, how often,
  or in what sizes it talks to your providers.
- **The security of your storage accounts themselves** (provider-side
  authentication, transport security beyond what the adapter negotiates).
- **Recovery of a lost password.** There is no escrow or backdoor by design.
