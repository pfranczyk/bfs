# Security Policy

BFS (Backup File System) is a distributed backup tool: it packs and compresses a
directory into a binary blob, splits it with Reed-Solomon erasure coding, and
encrypts each resulting shard — compression and encryption are both on by
default — then spreads the shards across independent storage providers. This
document describes what that design protects, what it does not, and how to report
a vulnerability.

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

| Version                  | Security updates                              |
| ------------------------ | --------------------------------------------- |
| Latest stable release    | ✅ Yes                                        |
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
- When a backup is stored unencrypted (`--no-enc`), BFS prints a prominent
  warning — at `bfs init` and again on **every** `bfs push` of that backup —
  that part of the data is directly readable on a single storage device and that
  the addresses and usernames of all your storage are visible on every device.
  An unintended opt-out is hard to miss. (Current versions never embed storage
  passwords; see *Credential handling*.)

## Cryptography

- **Confidentiality + integrity:** AES-256-GCM. Each shard is encrypted as a
  single GCM message with a 16-byte authentication tag, so tampering with a
  shard is detected on decryption.
- **Key derivation:** Argon2id with a 16-byte random salt (regenerated on every
  push and stored per shard), memory cost 64 MiB, 3 iterations, parallelism 1.
  The 256-bit data key is derived from the user-chosen password and that salt.
- **Nonce derivation:** each shard's 12-byte GCM nonce is derived
  deterministically as `HMAC-SHA256(data_key, "shard_nonce" || uint32LE(version)
  || uint8(shard_index))[:12]` — the UTF-8 label `shard_nonce`, the snapshot
  version as a 4-byte little-endian integer, and the shard index as a single
  byte, in that order, truncated to the leading 12 bytes. Because a new push uses
  a fresh salt (hence a fresh key), and each shard within a version gets a
  distinct index, no `(key, nonce)` pair is ever reused.
- **Integrity hashing:** SHA-256 is used throughout for integrity — a cleartext
  content hash over the packed backup data and a separate checksum over each
  stored shard — independent of, and in addition to, the AES-GCM tag. See
  *Integrity of a restored backup*.

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

- The payload is **systematic** Reed-Solomon over the packed backup data: the
  `N` data shards are verbatim slices of it. With compression off, a single
  shard exposes raw file fragments directly. With compression on (the default),
  the packed data is a deflate-compressed archive, so a shard holds compressed
  fragments rather than readable text — but holding `N` of the `N+K` shards
  still reconstructs the archive, and then your files, verbatim and without any
  key.
- The location map is **plaintext** on every device: the address, username, and
  path of every storage location are visible to anyone holding any one shard,
  who can then locate and reach the rest.
- Storage **passwords are not exposed by current versions** — they are stripped
  from shard headers regardless of encryption, though shards written by an
  earlier version still carry them until re-pushed (see *Credential handling*).

### Metadata exposed in cleartext (both modes)

Every shard header carries the following in the clear, even for an encrypted
backup:

- a magic marker and binary format version,
- the backup's random UUID,
- the backup name (as you chose it at `init`),
- the total backup-data size,
- a SHA-256 hash of the packed backup data, taken before encryption (over the
  compressed archive when compression is enabled — the default — not over your
  original files),
- the scheme (data count `N`, parity count `K`),
- the Reed-Solomon stripe size,
- the shard's index and the version (snapshot) number,
- the encryption flag and, when encrypted, the KDF salt.

The cleartext content hash means an observer holding a shard can confirm whether
a backup matches data they can reproduce byte-for-byte — the same files packed
(and compressed) the same way — not merely a file they happen to possess. This cleartext header metadata is
listed under *Out of Scope* below.

### Credential handling

- **Current versions of BFS never write storage credentials into shard headers.** A provider's
  password — and any field an adapter marks as secret — is kept only in the
  local backup configuration (`.bfs/config.json`) and is stripped from the
  location map embedded in shards. Non-secret coordinates (host, port, username,
  path) remain, so one shard can still discover and reach the others.
- This takes effect **from the next push**. Shards written by an earlier version
  retain the old embedded credentials until that version is pushed again (or its
  provider is relocated/rebuilt). An update does not rewrite shards already on
  remote storage.

### Transport to a provider

BFS does not encrypt the channel to a storage provider on your behalf. The FTP
adapter can use FTPS (TLS) when you enable its `secure` option, but that option
is **off by default**: a plain FTP connection sends the storage password and the
shard bytes in cleartext over the network. This is independent of whether the
backup itself is encrypted, and it matters most for an unencrypted backup, whose
shard payloads and plaintext location map would then also cross the network in
the clear. Enable FTPS, or run BFS only over a network you already trust, when
the path to a provider is untrusted. When a backup operation connects over plain
FTP, BFS prints a warning naming the server, so an unintended insecure transport
is hard to miss.

### Local credentials at rest

The local backup configuration stores provider credentials in plaintext on the
machine that runs BFS. BFS applies defense-in-depth file permissions: the whole
`.bfs/` tree is created mode `0700`, and the files inside it that hold secrets,
metadata, or a plaintext copy of your data — `config.json` (provider
credentials), `state.json`, the version manifests, and any cached backup blob
under `.bfs/cache/` — are written mode `0600`. These restrict access to the
owning user on POSIX systems. On Windows these mode bits are a no-op (NTFS uses
ACLs, not POSIX permissions), so the practical protection there is the access
control of the directory holding `.bfs/`. This is **not**
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
enforced separately, in layers:

- **Per-shard checksum.** Each stored shard ends with a SHA-256 over its own
  header and payload. A restore (`bfs pull`) reads the whole shard and recomputes
  a per-shard SHA-256 before reconstruction — the in-shard header+payload checksum
  for shards in the current striped format, or the per-shard payload hash recorded
  in the manifest for older non-striped shards — so a shard that a storage device
  silently corrupted or that the transport truncated is set aside before
  reconstruction and the backup is rebuilt from the remaining healthy shards plus
  parity, the same path as a shard that is missing entirely. Corrupting up to `K`
  shards is therefore as survivable as losing `K` providers, and a single damaged
  shard cannot deny an otherwise-recoverable restore. A wrong password is
  distinguished from corruption: it fails a shard's authentication tag (not its
  checksum) on every shard, so it surfaces as a password error rather than being
  mistaken for damage. `bfs verify` and `bfs
  recovery` read only the shard header window (see *Format validation*): they
  confirm a shard is present and carries a consistent header, but do not
  re-check its payload bytes.
- **Content hash.** The reconstructed backup data is checked against the SHA-256
  content hash recorded for the backup. Individual files are checked too: on the
  default compressed path each file is validated against a stored CRC-32 and its
  declared size, and on the uncompressed path against a per-file SHA-256.
- **Authentication tag.** For an encrypted backup, each shard is a single
  AES-GCM message whose 16-byte tag detects any tampering on decryption.
- **Format validation.** Every shard — and, where a provider keeps the updated
  header in a separate sidecar file, every sidecar — begins with a fixed format
  marker that is checked before any field is parsed; a sidecar additionally
  carries its own SHA-256. A bad marker or checksum is treated as corruption and
  the read is rejected.
- **Cross-provider consensus (recovery).** Rebuilding a backup's metadata on a
  fresh machine cross-checks shard headers held by *different* providers. When
  BFS bootstraps from one provider's shard, it compares that header against a
  second provider's — backup UUID, content hash, version, scheme, and the
  encryption flag — and aborts recovery as suspected tampering if they disagree.
  As each further version is rebuilt, the same comparison (minus the encryption
  flag) instead marks that version as lacking consensus and continues. This is
  the one check that can catch a single provider serving an altered header, even
  for an unencrypted backup — though it does not cover the payload, nor tampering
  applied consistently across the providers an attacker controls.

As further defense-in-depth, a restore refuses to write any file whose stored
path would land outside the directory you are restoring into (absolute paths,
`..` traversal, NUL bytes). BFS also rejects a backup — or an individual shard —
whose internal size fields have been altered to implausible values, failing with
a clear error rather than over-allocating memory or failing unpredictably; the
shard-header check runs during verify and recovery as well as restore. And
because compression is on by default, a restore caps how far the embedded archive
may expand — bounded by the smaller of the on-disk data size times a fixed
maximum deflate ratio and half of the machine's RAM — so a tampered or
maliciously crafted archive that would inflate past that ceiling is stopped
before it can exhaust memory.

Together these bound what a corrupted or faulty storage device can do during a
restore. They are not, however, a substitute for encryption: apart from the
cross-provider header check, these checks all rely on values stored in the clear,
so for an unencrypted backup a deliberate attacker who controls the shards can
read the data and recompute them after altering it. Robust protection against
deliberate tampering comes from an encrypted backup's AES-GCM tag, which is bound
to a key you hold and cannot be forged without it.

### Currency of a packed backup

`bfs push` reads each file exactly once while packing, so the resulting blob is
always internally consistent and restorable. To catch files that change on disk
*while* a push runs, it brackets the pack with two directory snapshots — each
file's size and modification time (`mtime`) before packing and again after — and
reports any file that changed, vanished, or appeared in between. In an
interactive terminal you are asked whether to accept the drifted backup (still
fully restorable, just not current for that file) or retry without touching
files; a non-interactive push refuses by default and requires `--allow-drift` to
accept. `--allow-drift` waives only *currency* — never *recoverability*, which
the single-read pack guarantees for every blob.

This check compares size and `mtime`, not file contents: a change that preserves
**both** a file's size and its `mtime` is not detected. Doing so requires
deliberately forging the modification time — a user who does that is knowingly
corrupting their own backup — so it is out of scope, alongside the other
cleartext-trust limitations of an unencrypted backup. The check is designed to
surface accidental mid-push edits and ordinary saves, not an adversary forging
timestamps.

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

Recovering a backup on a fresh machine (`bfs recovery`) is **interactive by
default**. Because credentials are stripped from shards, BFS asks for the storage
passwords it needs to reconnect to the remaining providers; without a terminal it
degrades gracefully instead (see *Known limitations*). A password
supplied once via `--bootstrap` is reused for every storage location that shares
it, so a typical single-server setup recovers without extra prompts; only
locations with a *different* credential are prompted for. A location that needs
no secret at all — an anonymous or guest resource — is never prompted, because
the shard location map records that it requires no input.

Before any storage password is sent during recovery, BFS shows the destination
host it is about to send it to and lets you decline — so a tampered location map
in an unencrypted backup cannot redirect your password to an attacker's server.
The recovered locations are also cross-checked across providers (see *Integrity
of a restored backup → Cross-provider consensus*), and the first write after
recovery — a push, or a `bfs provider remove` that relocates or rebuilds storage
— re-confirms each destination before data is sent there. Unattended recovery can
pre-approve the recovered hosts with `bfs recovery --trust-locations`, skipping
the per-destination prompt. An encrypted backup's location map is authenticated
by its AES-GCM tag and was never exposed to this redirection.

Known limitations:

- **No interactive terminal → graceful degrade.** In an environment without a
  TTY (CI, cron, a test harness), a provider that needs a password is skipped
  rather than prompted, and recovery never crashes — but that provider's shard
  is unavailable for the recovery.
- **No non-interactive path to supply a transport password yet.** Fully
  recovering a stripped backup that needs a credential other than the bootstrap
  one requires an interactive terminal. A non-interactive override for automated
  recovery is planned for a later release.
- **An encrypted backup cannot start recovering without the newest version's
  password.** The password decrypts the shard location map BFS uses to discover
  the other providers, so recovery bootstraps from the newest version's shard; if
  that password is wrong or unavailable, the bootstrap aborts with a clear error
  rather than proceeding partially, because nothing else is reachable until the
  map is read. Once bootstrapped, a later shortfall degrades gracefully instead:
  a provider whose transport password is missing, or an older version encrypted
  under a different password that is not supplied, is skipped rather than aborting
  the whole recovery.

## Out of Scope

The following are explicitly outside BFS's threat model:

- **The host running BFS.** Malware, another local user with administrative
  rights, or physical access to the machine can read the local configuration
  (including plaintext provider credentials) and any decrypted data.
- **Password strength.** The confidentiality of an encrypted backup rests
  entirely on the password you choose; BFS does not enforce a policy.
- **Cleartext header metadata.** A fixed set of header fields — backup name,
  size, scheme, content hash, the random backup UUID, the shard index and
  version, the encryption flag, and more — is not hidden (see *Metadata exposed
  in cleartext* for the complete list).
- **Traffic and access-pattern analysis.** BFS does not obscure when, how often,
  or in what sizes it talks to your providers.
- **Provider-side security of your storage accounts** (their own authentication
  and access controls). BFS does not add transport encryption on your behalf; see
  *Transport to a provider* for what the FTP adapter does and does not secure.
- **Recovery of a lost password.** There is no escrow or backdoor by design.
