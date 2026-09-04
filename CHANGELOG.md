# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.14.3] - 2026-09-04

### Fixed

- **A language BFS does not have is now turned away instead of being saved.**
  `bfs --lang <code>` took anything at all - a typo, or the next flag when the
  code was left out - wrote it down as your choice, said it had been set, and
  exited as a success. Nothing was set: the interface quietly reverted to
  English on that run and on every run after it, with nothing on screen
  connecting that to the flag. The value is now checked against the languages
  that actually ship, and a refusal comes back in the language you were already
  using, leaving your setting as it was. If one was saved before this, it is
  pointed out on the next run together with the command that clears it, and the
  work carries on in English rather than stopping.
- **`bfs --cwd` without a directory no longer carries on with a different one.**
  With the value missing - left out entirely, empty because a variable in a
  script never got set, or with the next flag standing where it belongs - the run
  fell back to whatever directory it was started from, or answered with the
  version number as though that was what you had asked for. Either way it went
  ahead somewhere other than where you were pointing. It now says the directory
  is missing and stops, whichever way the flag was written.
- **Stopping an edit of a storage device now reads as your decision, not as a
  crash.** `bfs provider edit` says why it stopped in the same voice as the rest
  of the tool - the marked, coloured line every refusal carries. Only a refused
  SSH host key got that treatment; declining an FTPS certificate, backing out of
  its offline menu, or any reason an add-on storage adapter gave arrived as a
  bare line instead, indistinguishable from the tool falling over. What was
  stored is left untouched either way, and interrupting with Ctrl+C still ends
  the session the way it always did rather than being reported as a refused
  edit.
- **A backup can no longer be written missing a file because the disk refused
  mid-way.** Packing reads your files and writes them into a working file on the
  backup's own disk, and a refusal from that disk - full, read-only, a failing
  drive - was indistinguishable from a file that could not be read: it was
  reported against whichever of your files was in hand, and packing carried on
  without it. Because the working file is sealed over whatever reached the disk,
  the seal agreed with an archive that was short of a file, so nothing looked
  wrong, and the message suggested `bfs push --cache` - the one command that
  would upload it. The file could then go missing without a sound, a restore
  finishing and reporting success simply without it, or the copy could turn out
  unreadable when it was finally needed. A refused write now stops the packing
  and is named like every other refusal by that disk. A file that genuinely
  cannot be read is still skipped and still named, exactly as before.
- **A backup that cannot be unpacked now says so instead of printing an internal
  error trace.** When a restore reached data it could not decompress, the
  explanation was there but never got the chance to be shown: it surfaced as an
  unhandled internal fault, complete with a stack trace, before the message
  could be shown - and the tidying up that goes with a reported failure was
  skipped along with it.
- **`bfs config` no longer accepts a directory that the next backup will
  refuse.** `--temp-dir` and `--cache-dir` checked only the folder above the
  one you gave, so a path that already existed as a file was reported as
  saved, written to the configuration, and only turned away by the next
  `bfs push` - which sent you back to `bfs config` to undo it. The same check
  the backup itself makes now runs when the setting is stored, so the refusal
  arrives where the mistake is made. A folder that does not exist yet is still
  accepted; push and pull create it. Two things that were wrong about the old
  refusal are fixed with it: a path blocked by a file was reported as "does
  not exist", which reads as an instruction to create it - the one thing that
  cannot work there - and a refused setting still exited as a success, so a
  script could not tell a stored value from a rejected one.
- **When the disk holding the backup runs out of room while packing or
  restoring, it is now named.** The data is packed to (and restored through) a
  file in the backup's own cache directory, and there are two disks in play -
  that one and the temporary directory. Packing the backup, and writing the
  restored copy back, used to fail with the raw operating-system error on a
  path and nothing else, so there was no telling which of the two had filled up
  or what to do about it; on top of that, the refusal was reported against
  whichever of your files was being read at the time, which reads as a problem
  with that file. Both now name the directory
  that refused and the one command that moves it
  (`bfs config --cache-dir <path>`), keeping the system's own reason - full,
  read-only and permission-denied need different answers. The temporary
  directory keeps saying `bfs config --temp-dir`, so the two disks stay told
  apart, and a restore that fails for its own reasons - a wrong password, a
  part that cannot be used - is still reported as that and never as a full
  disk.
- **A restore now checks that each part it downloaded is the part it asked
  for.** Parts are stored under a name saying which backup, version and slot
  they belong to, but nothing read that back out of the part itself, so a sound
  part of another version - or of another backup, or of the same backup cut
  into a different number of pieces - was decoded as if it belonged here. That
  needs nothing to be corrupted: files get moved by hand while data is being
  rescued, a sync script points at the wrong source, a storage device comes
  back from the wrong snapshot. Such data was never accepted as your backup,
  but what you were told about it was wrong - on an encrypted backup, that the
  password was wrong when it was right; otherwise, that the backup had failed
  its integrity check - and no storage device was named to go and look at.
  Worse, when the misplaced part sat in the slot read first it handed the whole
  version its own size and encryption salt, so every healthy part failed
  alongside it and a backup with redundancy to spare would not restore at all.
  A part that does not belong is now refused by name and rebuilt from the
  parity, exactly like a damaged one; the message says which storage holds it
  and that `bfs verify` will show what disagrees, and when too few parts are
  left, the closing message lists those storage devices under a cause of their
  own instead of blaming the copy or your password. Backups written before
  0.3.0 are checked against the same five fields, except that a part whose
  contents also differ from what the backup records is still reported as
  damaged there, because that older read path recognises it by its contents
  first.

## [0.14.2] - 2026-08-27

### Fixed

- **A full or unwritable temp directory is now reported as such, not as
  backup data missing from a healthy storage.** When a part downloaded by
  `bfs pull` did not fit in the temporary directory (a small or RAM-backed
  system temp is the usual cause), the restore blamed the storage the part
  came from and sent you to `bfs verify --deep`, which would find every
  storage healthy. It now names the temporary directory and the fix
  (`bfs config --temp-dir <path>`), and it keeps restoring as long as enough
  parts did fit; only when too few fit does it stop, and then it says so
  without accusing any storage. `bfs push` does the same for the parity parts
  it writes there, so you can tell which of the two disks - the backup's or the
  temp - ran out. A `--temp-dir` that points at an existing file is refused
  up front, pointing at the same `bfs config --temp-dir` command, instead of
  failing with a raw `EEXIST` error.
- Temporary directories of push and pull are removed with a few retries, so a
  virus scanner or indexer briefly holding a fresh file no longer leaves the
  parts behind in the temp directory.
- **`bfs provider remove --strategy rebuild` no longer reports success when
  nothing was rebuilt.** When the new storage could not take the parts - wrong
  address, dead port, no space, missing permissions - the command exited with
  0, printed that the storage was replaced, dropped the old storage from the
  configuration and left the new one empty: every version lost its
  redundancy and nothing said so. The target is now probed once before any
  part is fetched, every rebuilt part is read back (size and identity) after
  it is written, and the first failure that would repeat for every version -
  the target refusing a write, a storage that does not answer - stops the run.
  Anything short of every version rebuilt is reported as a failure that names
  the step, the storage and the storage's own message, lists what was rebuilt,
  what failed and what was not attempted, and leaves the configuration exactly
  as it was: the old storage stays, a target that received nothing is
  withdrawn, one that already holds rebuilt parts is kept. Versions that were
  not rebuilt are marked degraded (a later `bfs verify` re-checks them against
  the storages). Running the same command again after fixing the cause
  finishes the job without rebuilding what already moved. When some versions
  had already moved, the new storage stays alongside the old one until that
  re-run, and `bfs push`, `bfs pull` and `bfs prune` wait for it; a version
  whose other storages lost too many parts is reported as such, with the
  parts to restore first. On a local
  disk the operating system's error code now travels with the message, and an
  SFTP server answering a write with its generic "Failure" status is explained
  as what it most often is - no disk space or quota left.

## [0.14.1] - 2026-08-26

### Changed

- **Temporary files of push and pull now live in the system temp directory,
  as `bfs config` has always said.** Parity parts written during push and the
  parts downloaded during pull go to a private `bfs-push-*` / `bfs-pull-*`
  directory under the system temp (unless `temp_dir` is set), and the
  directory is removed when the operation ends - also when it fails. Until now
  those files landed in the backup's own `.bfs/cache`, so an operator who
  reserved space on the system disk filled the volume holding the backup
  instead. If your system temp is small or lives in RAM, point BFS elsewhere
  with `bfs config --temp-dir <path>`.

## [0.14.0] - 2026-08-20

### Added
- **`bfs pull` can now restore a version your recovery could not open.** Each
  backup version is sealed with the password you gave when it was created, so a
  recovery run may meet a version whose password you did not have at hand; it is
  recorded as present on your storage but not restored. Reaching it used to mean
  running the whole recovery again with that password. Now `bfs pull --version N
  --password <its password>` goes and gets it: it finds that version's parts on
  your storages, opens them with the password you supplied, restores the files,
  and only then records the version - an attempt that fails partway leaves nothing
  half-written, so the next one starts clean. You are asked for the password once,
  since the same one unlocks both the version's whereabouts and its contents, and
  a wrong password says so plainly instead of sending you back to recovery. A
  version this directory has no record of is still refused immediately, without
  going near your storages.

- **`bfs push --yes` consents up front to creating a new version when the working
  copy is behind.** When the working directory sits on an older version than the
  latest already on your providers, `bfs push` confirms before creating the next
  version - a guard against pushing from a stale copy by mistake. A run with no
  terminal (a scheduled backup) cannot answer that question, so it stopped and
  told you to run at a terminal. `--yes` gives the consent ahead of time, so an
  unattended `bfs push --yes` creates the new version without prompting. It waives
  only the confirmation: push still creates a new version and never overwrites the
  working directory (unlike `bfs pull --yes`), so the refusal now points at
  `bfs push --yes`, not at pull.
- **Adapter authors can now name the types their optional methods take.**
  `bfs-vault/provider` exports `ConfigureEditContext` and `RecoverySecret`, the
  parameter types of `configureInteractiveForEdit` and `connectForRecovery`.
  Both methods were already part of the provider contract, but their parameter
  types were not exported, so an adapter had to restate their shape by hand
  instead of naming them. Nothing else changed, and no adapter needs
  rebuilding - the provider API version is unaffected.
- **`--password-file` keeps the backup password out of the process list.** Until
  now only `bfs repair` could read the password from a file; everywhere else it
  had to be typed on the command line, where the operating system shows it to
  every account on the machine (`/proc/<pid>/cmdline` on Linux) for as long as the
  command runs, and where monitoring agents that sample running processes capture
  it. Passing it through a shell variable did not help - the shell substitutes the
  value before starting the command, so the password still ends up in the
  arguments. `bfs push`, `bfs pull`, `bfs recovery` and `bfs provider remove` now
  accept `--password-file <path>` as well, reading the password from a file you
  can restrict to your own account (`chmod 600`). An explicit `--password` still
  wins where both are given, so existing scripts keep working; for `bfs recovery`,
  which tries several passwords, files add to that set rather than replacing it. A
  file that is missing or empty stops the command with a clear message instead of
  silently continuing without a password - including in `bfs repair`, which
  previously accepted an empty file as an empty password. The scheduled-backup
  example in the README now uses this.
- **`bfs --ci` declares a run that must not be asked anything.** Until now only
  some commands had a `--ci` of their own, and others inferred the same thing
  from whichever flag happened to be present - `bfs recovery` from `--bootstrap`,
  `bfs provider remove` from `--strategy`. That conflated two different things:
  supplying what a command needs removes the reason to ask, which is not the same
  as forbidding the question. The declaration now lives on the program, so every
  command reads it the same way and storage adapters are told about it through
  the same channel as before - nothing to rebuild, no adapter change. Without it
  an operator at a terminal is still asked, and the existing per-command `--ci`
  flags keep working exactly as before. One behaviour changed as a result:
  `bfs provider remove --strategy ...` and
  `bfs recovery --bootstrap ...` at a terminal now ask for anything they still need
  (the password of an encrypted backup, approval of a server identity) rather
  than failing or quietly skipping it - add `--ci` to get the old, unattended
  behaviour.
- **`bfs repair --force-unverified` is documented.** The flag has been available
  since 0.10.0 but was never described here, so the only way to find it was
  `bfs repair --help`. Before changing anything, `bfs repair` checks every part
  it is about to touch at its new address; `--force-unverified` lets a migration
  go on when a storage cannot answer that question - a read that fails for some
  reason other than the part being absent, altered, or damaged. Those three
  still stop the run, exactly as before: the flag waives an inconclusive answer,
  never a bad one. Each version continued this way is named in a warning as it
  happens.

### Changed
- **An unattended run stops on what its command line is missing, instead of
  asking.** `bfs --ci` promises that nothing will be asked, and that promise
  covers the questions a command puts on its own, not only the ones its storage
  adapters put. `bfs --ci prune`, `bfs --ci provider remove` and `bfs --ci
  recovery` each stop immediately and name what is missing - `bfs prune <range>`
  or `--keep-last`, `--yes`, `--strategy`, `--password` or `--password-file` for
  an encrypted backup, the name of the storage, `--bootstrap` with `--provider`
  and `--name` - and exit with a failure code. The check reads the command line
  before any work starts, so a relocation never configures the new address only
  to discover there that the password can never arrive.
- **Refusals in an unattended run say what could not be confirmed, and what
  settles it.** Where a yes/no question has no one to answer it, the run names
  the thing it could not confirm and the way to settle it, rather than reporting
  a decision nobody made: `--yes` for overwriting the working directory on `bfs
  pull`, running `bfs push` at a terminal when the working copy sits on an older
  version (no flag settles that one), and re-running `bfs recovery ...
  --trust-locations` after checking the recovered storage addresses. Recovery
  also says out loud which storage it skipped and why. A person who really does
  decline at the prompt still gets the plain cancellation.
- **An unattended run now refuses an FTPS storage it has no way to trust, before
  it opens a connection.** FTPS is on by default and its certificate has to be
  trusted before the password is sent - from a fingerprint you pinned, from
  `--accept-new-cert`, or from a person at the prompt. A run that states nobody
  can be asked and supplies neither flag has asked for two incompatible things,
  and that is decidable from the settings alone. Every command that configures a
  storage without a person present - `bfs init --ci`, `bfs provider add --ci`,
  `bfs repair --ci`, and `bfs --ci` in front of any command, including
  `recovery` and `provider remove` - now says so up front, naming the ways out,
  instead of reaching the server and failing there. The practical gain is
  for storage that cannot be reached at all: no connection attempt, no waiting
  for it to time out, and a message about the missing instruction rather than
  about the network. Settings that already carry a fingerprint, carry
  `--accept-new-cert`, or turn TLS off are unaffected, whether they come from
  flags or from a `--config-file`. Editing a stored configuration
  (`bfs provider edit --ci`) is also unaffected - it never contacts the storage,
  so a configuration without a pin stays legal there and the decision falls to
  whoever connects later.

### Fixed
- **Restoring files after a disaster recovery no longer waives the check on where
  your storage actually is.** `bfs recovery` rebuilds your storage addresses from
  information carried inside the backup parts themselves. On an unencrypted backup
  that information is not tamper-proof, so BFS holds the rebuilt addresses as
  unconfirmed and shows them to you for approval before the next `bfs push`, and
  before a `bfs provider remove` that relocates or rebuilds storage. Running
  `bfs pull` in between cleared that pending approval as a side effect of recording which
  version you restored, and the next push then sent your data to those addresses
  without showing them. Restoring now leaves the check exactly as it found it.
  Reading a backup is not approval to write one: a restore succeeds on fewer parts
  than there are storages, so it can finish without ever contacting one of them.
- **A version your recovery could not open is no longer forgotten - and the next
  backup no longer writes over it.** Versions can carry different passwords,
  since each `bfs push` asks anew. When `bfs recovery` met a version whose
  password was not among the ones you supplied, it skipped it silently: nothing
  on disk recorded that the version was out there, so `bfs versions` did not list
  it and `bfs pull` could not reach it even after you remembered the password.
  Worse, the count of how many versions your storage holds was taken from what
  the recovery could read, so the next `bfs push` claimed a number that was
  already in use and overwrote that version's parts - the only copy of its
  contents - without a word. Such a version is now recorded, listed under the
  version table as present but not recovered, and named as such when you try to
  restore it; the version count follows the storage, so the next backup always
  takes a free number. Running `bfs recovery` again with the missing password
  restores the version in full, and a recovery run without that password no
  longer disturbs versions it recovered earlier.
- **A backup interrupted while recording a version no longer takes the previous
  record down with it, and a damaged record no longer crashes the commands that
  read it.** Every version keeps a local record of which storage holds which part
  of it, rewritten in place whenever the version's health changes. Writing it
  cleared the file first and filled it afterwards, so a run cut short at that
  moment - power loss, a full disk, Ctrl-C - left the record truncated and the
  previous, complete one gone. Commands that read it then failed with a raw
  parser error naming a character position in a file you never wrote by hand:
  `bfs pull` and `bfs verify` stopped that way, and `bfs versions` broke off in
  the middle of its table. The record is now written to a side file and swapped
  into place in one step, so an interrupted run leaves the stored one untouched;
  and a record that is damaged or incomplete is treated as the version simply not
  being known to this directory, so `bfs versions` lists the rest and `bfs pull`
  names the version it cannot find. `bfs recovery` rebuilds such a record from
  your storage.
- **`bfs init` no longer replaces the backup already set up in a directory.**
  Running it in a directory that already holds a backup rewrote that backup's
  settings - a new identity, an emptied version history, and the only stored copy
  of your storage passwords gone - while the parts on your storage kept the old
  identity. The directory stopped reaching data it had just backed up, and
  nothing said so: the run reported success. The one guard that existed looked at
  the storage, under the folder named after the backup being created, so giving a
  different name walked straight past it. `bfs init` now stops before asking
  anything, names the backup standing in the way, and points at the ways out. A
  directory left half-set-up by an init that failed partway is unaffected - it
  still initializes, since no command removes that state and refusing there would
  leave nowhere to go. The message an offline `bfs provider edit` shows when
  `--accept-new-host-key` cannot reach the server no longer offers `bfs init`
  alongside `bfs provider add`, since that route now always stops.
- **Two `bfs repair` runs on the same backup can no longer both start.** The lock
  that keeps repairs apart is created first and filled in a moment later, so a run
  that had just claimed it was briefly visible to the other as a file with nothing
  in it. The second run read that emptiness as leftover state from a crash,
  deleted the claim and went ahead - leaving both runs rewriting the same
  version's storage locations, which can leave the copies of that bookkeeping
  disagreeing with each other and make a later recovery refuse to trust any of
  them. A claim that has no readable owner is now waited for instead of deleted,
  and the second run stops with a message that says so. A claim left behind by a
  run that died in that same instant is still taken over automatically once it is
  old enough that nobody can be writing it, and `bfs clear` still discards it
  immediately.
- **Authorizing a new SSH host key up front is now taken at its word, and the key
  is pinned.** `--accept-new-host-key` says "trust the key this server presents on
  first contact" - but it was honoured only in runs with no terminal attached,
  whether because `--ci` said so or because nobody was there. At your own terminal
  BFS asked you to confirm the fingerprint anyway, which is the question the flag
  had already answered (a replacement server has a new key by definition), and
  commands that take storage settings without requiring `--ci` - `bfs repair` and
  `bfs provider remove --strategy` - then saved a configuration carrying the
  authorization with **no** fingerprint recorded. Such a configuration trusts
  whatever host key answers at that address on every later connection, so a
  scheduled `bfs push` or `bfs pull` would accept an impostor at the same address
  without a word. The flag now settles the question whether or not anyone is at
  the keyboard, and the accepted fingerprint is pinned into the saved
  configuration in both cases, so every later connection is checked against it and
  a changed host key is reported as tampering. A revoked key (`@revoked` in
  `~/.ssh/known_hosts`) and an already-pinned fingerprint still decide first and
  still refuse. If you ran one of those commands at a terminal on an earlier
  version, the stored settings for that storage still carry the authorization
  without a fingerprint: running the same command again with
  `--accept-new-host-key` records one, and `--known-host <SHA256:...>` records a
  fingerprint you already know. The FTPS
  counterpart, `--accept-new-cert`, already behaved this way; it records no
  fingerprint of its own, and pinning a certificate is still `--cert-fingerprint`.
- **A run with no terminal no longer reports success after stopping halfway.**
  Anything BFS could not do without asking - the password for an encrypted
  backup, a storage password that recovery had to collect again - was still put
  as a question in runs where nobody could answer: from cron, from a script, with
  input redirected, or under `--bootstrap`. Such a question is never answered and
  never refused; the process simply ends where it stood, and because nothing had
  set an exit code it ended reporting success. `bfs recovery` was the worst of it:
  it wrote the snapshot of one version, died before writing the backup's
  configuration, and exited 0 - leaving a directory that looks recovered and from
  which nothing can be restored. `bfs pull` of an encrypted backup exited 0 having
  restored no files at all, and `bfs push` ended with Inquirer's own
  "User force closed the prompt" instead of saying what was missing. No question
  is now asked when there is nobody to answer it: commands say what they need and
  how to supply it (`--password`, `--password-file`), a question with a safe
  answer is answered that way - a location left unapproved stays unapproved - and
  recovery finishes the versions it can open, naming each one it skipped, so what
  it recovered restores. Interactive use is unchanged, prompts and retries
  included. If you have scripted runs that relied on the old exit code, note that
  they were reporting success without doing the work.
- **`bfs init --ci` no longer stops to ask a question.** Run from a terminal, a
  storage server whose identity BFS had not seen before - an FTPS certificate,
  an SSH host key - was put to the operator as a question, inside a run that had
  declared nobody is watching it, so the command waited for an answer no script
  can give. The same command on a build server, where no terminal is attached,
  refused instead; one command, two behaviours. It now refuses in both. For FTPS
  the refusal names the two ways to establish trust up front: `--cert-fingerprint`
  to pin a fingerprint you already know, or `--accept-new-cert` to trust the one
  presented on first connect; for SSH the equivalents are `--known-host` and
  `--accept-new-host-key`, though its refusal does not yet spell them out.
  Answering the certificate question at the keyboard pinned nothing, so a backup
  set up that way kept working by hand and refused from cron - that trap is gone
  too. Two things follow from the same change: a local storage whose directory
  does not exist is now created without asking under `--ci`, so a typo in
  `--path` is no longer caught by a prompt; and an interactive `bfs init` is
  unchanged, still showing an unknown certificate and offering to trust it, go
  back to the connection settings, or cancel.
- **`bfs provider edit --ci` now tells the adapter it is running
  non-interactively.** The provider contract states that `ProviderIO.interactive`
  is `false` under `--ci` or when no terminal is attached, and that an adapter
  must never block on a prompt in that case. `bfs provider
  edit` did not pass the flag on: run from a terminal it handed the adapter
  `interactive: true` despite `--ci`, so an adapter trusting the field could ask
  a question nobody was there to answer and hang a script. The built-in local,
  FTP and SSH adapters were unaffected - the flag path only builds and validates
  the configuration and never contacts the storage. An edit without `--ci` is
  unchanged and still takes the answer from whether a terminal is attached.
- **A command run without a terminal is no longer told that it has one.** An
  adapter is handed `interactive: false` under `--ci` or whenever no terminal is
  attached - but five commands honoured only the flag.
  `bfs init` while reading storage settings from `--provider`, `bfs repair`,
  `bfs provider add`, `bfs provider remove` and `bfs recovery` each claimed a
  terminal for every run that omitted their flag, including one started from
  cron or fed from a pipe. It showed most in `bfs repair`, the one command with
  no questions of its own, which can therefore run start to finish unattended:
  moving a backup to a machine where none of the recorded paths exist would ask
  whether to create each one, and with nothing to read the answer from, take
  silence for a refusal - so the repair reported success while relocating
  nothing, and the backup was left unreadable until someone ran a check. The
  same run would ask about an FTPS certificate it had not seen before, with the
  same outcome. `bfs init` taking storage settings
  from `--provider` now refuses an FTPS server it has no way to trust and names
  the flags that settle it, rather than falling silent at a question with no
  reader. All five now take the answer from whether a terminal is attached; runs
  at a terminal behave exactly as before.
- **A repair that had to skip a damaged storage no longer reports the version as
  healthy.** Rebuilding a lost part reads every other copy in full and checks it
  against its own checksum, so it knows when one of them has rotted on its
  device - it already warned about it. The version was nevertheless recorded as
  healthy, which is what `bfs status`, `bfs versions` and `bfs verify` then
  showed, even though one fewer copy was actually sound than the backup promises.
  A repair now records the version as degraded whenever a copy could not be read,
  and when the cause was damage it also notes that the finding came from reading
  the data, so a later routine `bfs verify` - which only inspects headers - no
  longer erases it. `bfs verify --deep` retires the finding once the damaged
  device is repaired, as before.
- **An interrupted rebuild no longer leaves an extra storage in the
  configuration.** `bfs provider remove --strategy rebuild` onto a new storage
  has to record that storage before it starts, and when the rebuild then failed
  it stayed behind. The backup was left with one storage more than its scheme
  allows, and every later `bfs push`, `bfs pull` and `bfs prune` refused to run
  until the configuration file was edited by hand. The entry is now withdrawn
  when the rebuild failed before putting anything on it, and kept - with a note
  saying so, and that re-running the same command finishes the job - when part of
  the backup had already been moved onto it.
- **Editing an FTPS provider no longer replaces the certificate it trusts with
  whatever answers at that address.** `bfs provider edit` is how you rotate a
  password or correct an address, and it never uploads anything - but on an FTPS
  provider it used to dial the server and pin the certificate it found, without
  ever comparing it to the one already stored. BFS promises that a storage server
  presenting a different certificate is refused as possible tampering; on this one
  path the promise did not hold, so a routine password change made while someone
  sits between you and the server would quietly make that impostor the identity
  BFS trusts from then on - and it is exactly that stored certificate which keeps
  your password from being sent to them. When the address is unchanged, the edit
  now keeps the stored certificate and does not contact the server at all. Moving
  the provider to a different host or port is a genuine change of identity, so the
  new certificate is shown, and you can accept it, go back to the connection
  settings, or cancel - going back exists because refusing a certificate usually
  means you aimed at the wrong server and noticed only at that question, which
  used to cost you every field you had already typed. When the
  server legitimately gets a new certificate at the same address, record it with
  `bfs provider edit <name> --ci --cert-fingerprint <new>` - passing the other
  connection settings too, since an edit replaces them all.
- **`bfs provider edit` now finishes when the storage is not there - which is
  usually why you are editing it.** The command only writes local settings, but
  on a local provider it kept re-asking for the directory until one existed, and
  on an FTPS provider it aborted with a raw connection error when the server was
  down. An unplugged drive or a switched-off server therefore left no way to
  record its new address. A directory that does not exist yet is now offered for
  confirmation instead of being rejected, and an unreachable FTPS server offers a
  choice: paste the certificate fingerprint, go back to the connection settings,
  save without a pin, or cancel. A path that points at a file rather than a
  directory is still refused outright. Turning FTPS off on a provider whose
  certificate was pinned now says so, naming the fingerprint it removes.
- **Resuming an interrupted backup with `bfs push --cache` no longer re-packs
  everything - and no longer deletes the cached data it was meant to resume
  from.** After a failed push, BFS keeps the packed backup data and tells you to
  run `bfs push --cache` to upload it without re-packing. That resume loaded the
  whole cached backup data into memory, while every other path in a push streams
  it and respects a memory budget. For a backup above roughly 2 GB the load failed
  outright; the failure was then mistaken for "no cached data found", so the
  directory was packed again from scratch and the cache was removed on the way -
  destroying the only copy of the work the interrupted push had already done, on
  exactly the large backups where re-packing costs most. If the original push had
  stopped because some files could not be read, the fresh pack ran into the very
  same problem again. The resume now reads only what it needs to describe the
  version and streams the rest, so it works regardless of backup size.
- **`bfs push --cache` now checks the cached backup data before uploading it.**
  Resuming an interrupted backup is the one case where BFS sends bytes it did not
  just read from your directory - they come from a file that has been sitting on
  disk since the earlier run, where an interrupted write, a failing disk, or
  another program rewriting it can damage them. That damage used to travel all the
  way to your storage unnoticed: each device's part was sealed over the corrupt
  data, so every part checked out against itself, the backup was reported healthy,
  and even `bfs verify --deep` found nothing. The problem surfaced only at the
  first restore, as a corruption error that pointed at the storage rather than at
  the local cache. The packed data carries its own checksum, so the resume now
  compares it before a single byte leaves the machine and stops with a message
  naming the cached file and telling you to run `bfs clear` and then back up
  again. Nothing already on your storage is touched when it stops, and an intact
  cache resumes exactly as before. The check reads the whole cached file, which on
  a large backup takes a while, so in a terminal the progress line now names that
  step instead of sitting on the generic "Preparing push...".
- **`bfs versions` no longer reports a resumed backup as empty.** After resuming
  an interrupted backup with `bfs push --cache`, the version was listed with `0`
  files and `0 B` - on compressed backups, which is the default. The figures were
  simply not read back from the cached data, and since the table prints `?` when
  a figure is unknown, the zero read as a statement that the version held nothing;
  nothing corrected it later either. The version restored your files correctly the
  whole time - only the listing was wrong. Resuming now reports the same file
  count and size a normal backup would.
- **`bfs --version` works.** Only the short `-V` was recognised; the long form
  printed `unknown option` and did nothing - it did not even fall through to the
  interactive prompt. Both forms now print the version - on the command line and
  typed at the interactive `bfs >` prompt - and `--version` keeps its separate
  meaning as an argument to `bfs repair` and `bfs pull`, where it selects which
  backup version to act on.

## [0.13.0] - 2026-08-03

### Added
- **`bfs verify --deep` checks the full backup data, not just its headers.** The
  regular `bfs verify` reads only a small header from each storage device - it
  confirms the data is present and consistent, but cannot see silent bit-rot in the
  stored bytes, which would otherwise surface only at restore time. `bfs verify
  --deep` streams every device's data end-to-end and re-checks its checksum, so
  on-device corruption is caught up front and a failing part is treated as damaged
  (like a missing one). It needs no backup password - even for encrypted backups -
  but downloads all backup data, so it is opt-in; the plain `bfs verify` stays fast.
- **FTPS storage now verifies the server's certificate, with pinning and
  trust-on-first-use.** When you add or set up an FTPS storage device
  (`bfs init`, `bfs provider add`), BFS shows the server certificate's fingerprint -
  and whether it is self-signed or CA-signed - and pins it after you confirm, so
  a self-signed certificate (common on a home server) is usable by trusting its
  fingerprint directly, without a certificate authority. Pin one up front with
  `--cert-fingerprint <fp>`, or accept a new certificate without a prompt using
  `--accept-new-cert` for scripted runs. The certificate is checked before your
  password is ever sent, so the password never reaches an untrusted or impersonated
  server; a certificate that later does not match the pinned one is refused as
  detected tampering.

### Changed
- **BREAKING: `bfs verify` now reports its verdict through the exit code.** A
  scheduled check could not tell a healthy backup from an unrecoverable one:
  `verify` always exited 0 and the verdict lived only in the printed table. It now
  exits **4** when a backup is degraded (still restorable, redundancy lost) and
  **5** when it is damaged (no longer restorable), keeping **0** for a healthy one.
  Both differ from the generic failure code 1, so automation can tell "the backup
  is damaged" from "the check could not run". A script that treated any non-zero
  exit as a crash needs updating; one that ignores the exit code is unaffected.
- **A damage verdict is no longer erased by the next routine `bfs verify`.** The
  regular check reads only a small header from each device and cannot see damage
  inside the data, yet it used to overwrite what `bfs verify --deep` had found -
  so a backup that had been proven unrecoverable started reporting healthy again.
  A verdict based on damage actually read off the devices now survives later
  header-only checks, which say where the verdict came from and how to refresh it.
  Only a new deep check can clear it, so a repaired backup returns to healthy;
  a verdict caused by a device that was merely unreachable is not kept, so an
  outage does not force a full re-download to clear it.
- **`bfs prune` refuses to delete the last version that can still be restored.**
  Housekeeping picks versions by number, so `bfs prune --keep-last 1` on a backup
  whose newest version had rotted deleted the only good copy and kept the
  unrecoverable one. Such a request is now refused with an explanation; deleting
  damaged versions, or any version while a restorable one remains, works as
  before. Pass `--force` to delete anyway - for instance to wipe a backup on
  purpose.
- **`init`, `push`, and `provider add` no longer silently overwrite a different
  backup that already occupies a storage location.** If you point a backup at a
  location (same backup name, same path on a storage device) that already holds a
  *different* backup - for example two machines both running `bfs init documents`
  against one shared network drive - BFS now stops with a clear message instead of
  letting the second machine's push quietly overwrite the first machine's data. To
  reuse such a location, remove the existing files there yourself, choose a
  different backup name, or run `bfs recovery` if the backup is yours. Pushing a new
  version of your own backup is unaffected.
- **`push` no longer silently drops symbolic links and special files.** A symbolic
  link, or a special file (socket, FIFO, device), can never be stored in a backup,
  so `bfs push` now stops with a clear message listing them and pointing at
  `.bfsignore`, instead of quietly leaving them out as it did before. An
  interactive session offers to add them to `.bfsignore` and retry; a scripted run
  exits with a dedicated code (3) so automation notices. Pass `--allow-excluded` to
  back up everything else and skip them without failing.
- **BREAKING: FTP storage now uses FTPS (TLS) by default.** A newly configured FTP
  device connects over TLS unless you explicitly opt out with `--secure false`;
  previously the connection was plain (unencrypted) FTP unless you turned TLS on.
  This protects the storage password and your backup data on the network by
  default. If a server offers only plain FTP, pass `--secure false` to keep using
  it (and heed the cleartext-transport warning). Existing devices are read from
  their own saved configuration and are unaffected until you reconfigure them.
  One consequence to plan for in automation: a TLS connection has to establish
  trust in the server's certificate, and a scripted run has nobody to ask - so
  configuring an FTPS device non-interactively now requires either a pinned
  fingerprint (`--cert-fingerprint`, or `cert_fingerprint` in a config file) or
  `--accept-new-cert` to trust the one presented on first connection. Without
  either, BFS refuses rather than trusting silently.
- **A storage server whose identity changed is now reported as possible tampering.**
  When an FTPS certificate, or an SSH host key, no longer matches the one BFS pinned
  when the device was set up, the operation stops with a clear message that the
  server's identity changed and this may be a machine-in-the-middle - instead of a
  generic connection or verification error. A deliberately new certificate or key is
  still accepted the usual way (an interactive confirmation, `--cert-fingerprint` /
  `--known-host`, or `--accept-new-cert` / `--accept-new-host-key`).
- **Messages about a skipped part of a backup now name the storage device instead
  of an internal part number.** "skipping piece 2" told you nothing you could act
  on - the numbering is internal and starts at zero. Every such message now names
  the device the part belongs to, which is what you need to fix the problem.

### Fixed
- **`bfs verify` now says why a part of a backup is missing, instead of only
  counting it.** A report of "2/3 available" read exactly the same whether a
  storage device was switched off, was no longer in the configuration, needed an
  adapter that is not installed, or its file had been deleted - yet those call for
  opposite moves: bring the device back versus rebuild the part with
  `bfs repair --rebuild`. Verify named the cause only
  for damage it could see in a file it had actually read; every other reason was
  dropped silently. Each of them is now reported under the device's name, and a
  device that never answered is reported as unreachable - not as a missing file and
  not as damaged data, because nothing was read from it.
- **A recovery started from a storage device holding damaged data no longer asks
  for the backup password over and over.** When the copy on the device you point
  `bfs recovery --bootstrap` at had rotted, BFS could not tell that from a
  mistyped password: it kept asking for a password that was already correct and
  that no password could have fixed - in the middle of a disaster recovery, with
  nothing to act on. It now checks that device's data once a first attempt has
  failed, and when the copy does not check out it says so and names the way out:
  recover from any other device of the same backup, which holds the same
  information. For an unencrypted backup, where no password is involved, the same
  situation used to end with an internal technical message and no next step; it
  now gets the same clear refusal. A genuinely wrong password is still reported as
  a wrong password. Telling the two apart needs the data itself, so the first
  attempt that fails costs one read of that device's data - once per recovery
  rather than once per try, unless that read is itself interrupted, in which case
  a later attempt tries again. A password that works costs nothing extra.
- **A restore that cannot go ahead now says which storage failed, and why.** It
  used to end with a fixed "some storage may be offline", even when every device
  answered and the real problem was damaged data - sending you to check cables
  instead of repairing the backup. The failure now names the devices holding
  damaged data, lists separately the ones whose data is missing or that could not
  be reached, and leaves healthy devices out of it; it also says plainly that the
  version cannot be restored from what is available and points at `bfs verify`,
  which shows the versions that still can be. Data that arrives but does not read
  back is reported as damaged rather than missing. A wrong password is still
  reported as a password problem.
- **The steps suggested after removing a storage device now actually work.**
  `bfs provider remove --strategy remove` leaves one device fewer than the backup
  scheme requires, and the first step it recommended - `bfs pull` - stopped on that
  very mismatch, as did `bfs push` and `bfs prune`. The suggested steps now start
  with `bfs scheme set <N> <K>`, which matches the scheme to the devices you have
  left and unblocks the rest. The mismatch message itself no longer offers
  `bfs provider add` either: adding a device raises the required total by one as
  well, so it never closed the gap.
- **A degraded restore now tells you how to bring back a storage device the
  configuration lost.** When a backup records a device that is no longer in the
  configuration, the restore rebuilds the missing part from redundancy and
  succeeds - but said nothing about the cause, so every later restore silently
  skipped the same part. It now names the device under the name the backup records
  and gives the command that restores it. This is the one kind of degradation that
  can be undone without touching any stored data.
- **Moving a backup's storage to a new device no longer accepts someone else's
  data as the move.** Before committing such a move, `bfs repair` checks that the
  part already sitting at the destination really belongs to this backup. That check
  was skipped in one case - restoring a device the backup remembers but the
  configuration has lost - and there a *different* backup's part that merely
  happened to have the same file name was accepted, silently pointing your backup
  at data that is not yours. The check now runs whichever of the two names the
  device is known under, so a mistyped or reused destination is refused before
  anything is written.
- **`bfs repair --help` now shows how to call it.** The command takes a storage
  name and a settings string, but neither appeared in its help, so the syntax was
  effectively undiscoverable; the help now spells it out with worked examples.
  `--rebuild` is also described correctly: it reconstructs a part that is lost
  **or damaged** - previously it mentioned only loss, so nobody whose data had
  rotted had reason to try the one command that repairs it.
- **Restored files now keep their permissions and modification time.** After
  `bfs pull`, files are recreated with their original POSIX permissions (the
  executable bit, a private key's `0600`, and so on) and their original
  modification time. Previously the permission bits were dropped - restored files
  landed on the default umask - and, for the default compressed backups, the
  modification time was lost as well. Permissions apply on Linux/macOS; on Windows
  the modification time is restored (POSIX permissions are not enforced there).
  Backups created before this release still restore exactly as they did before;
  only backups created from this release onward carry the full metadata.
- **Two overlapping runs on the same backup can no longer corrupt it.** Starting a
  second `bfs push` - or a `bfs repair` - while one is already working on the same
  backup now fails fast with a clear "another operation in progress" message,
  instead of both slipping through and clobbering each other's version data.
  Whichever run starts first owns the backup until it finishes; this closes a race
  that scripted and scheduled (cron) runs could hit, and now also guards
  `bfs push --cache`.
- **`bfs-vault/provider` type definitions now compile in adapter projects.** The
  published `.d.ts` referenced an internal `Nullable<T>` helper without shipping its
  definition, so `tsc` in an external adapter package failed with "Cannot find name
  'Nullable'". The alias is now exported from `bfs-vault/provider` alongside the
  contract types.
- **A damaged part on one storage device no longer costs a whole backup version
  during recovery.** Every device's part records where all the other parts of that
  version live, so any one of them is enough to rebuild the version's record. When
  the part BFS happened to read first was damaged - its record unreadable, or, for
  an encrypted backup, no longer opening with the backup password - `bfs recovery`
  dropped that entire version, even though the untouched parts on the other devices
  carried the very same record. Recovery now falls back to a healthy device for
  that version, so one damaged part costs nothing as long as the rest are intact.
- **Replacing a storage device now works when the data on another device has
  silently decayed.** When BFS rebuilds a device's part from the others
  (`bfs provider remove --strategy rebuild`, `bfs repair --rebuild`), it now
  checks every part it reads against its own checksum and leaves out the ones
  that fail. Previously a decayed part was used as if it were sound, and -
  depending on where the damage sat - the operation either stopped and reported
  the backup as possibly tampered with, although the redundancy to absorb the
  damage was present, or reported success while folding the damaged bytes into
  the newly built part, so the loss surfaced only at the next restore. A part
  that disagrees with the others while its own checksum verifies is still
  reported as tampering.
- **A damaged part no longer blocks restoring an encrypted backup version.** To
  decrypt a version, `bfs pull` reads the encryption parameters recorded alongside
  the backup data. If silent corruption (bit rot, a partial write) damaged those
  bytes on the part BFS happened to read first, the wrong decryption key was
  derived and the whole version failed to decrypt - looking like a wrong password -
  even though the remaining devices held the same, intact parameters and the
  version was fully recoverable. BFS now takes them from a part that passes its own
  integrity check, so a version survives a damaged part exactly as it already did
  for a missing one.

## [0.12.0] - 2026-07-20

### Added
- **`ssh` - store a device's part on an SSH/SFTP server.** Configure it with
  `--provider "ssh:<name> --host <host> --user <user> --path /backup ..."`.
  Authentication is password or SSH key (`--private-key <path>`, with an optional
  `--passphrase`); with neither, BFS uses the default key under `~/.ssh`
  (`id_ed25519`, then `id_rsa`). The host key is verified on first connection and
  pinned, so a later change is flagged - trusted interactively, via
  `--known-host <fingerprint>`, or with `--accept-new-host-key` for
  non-interactive runs. Settings accept inline flags, a `--config-file <path>` JSON
  file, or both; passwords and passphrases are stripped from the stored parts
  (kept only in the local config, `0600`) and requested again at recovery.

### Changed
- **Adding a storage device now checks it is actually writable, up front.** When
  you set a device up (`bfs init`, `bfs provider add`), BFS creates its target
  directory and round-trips a small test file - so a wrong path, a missing folder,
  or a read-only account fails immediately with a clear message instead of looking
  fine and only breaking at the first `push`. This applies to every device type
  (local, FTP, SSH) and to scripted (`--ci`) runs too.

## [0.11.0] - 2026-07-09

### Added
- **Adapter contract (`bfs-vault/provider`): `ProviderIO` gains an optional
  `interactive` flag.** It is `false` for non-interactive invocations (`--ci`,
  `recovery --bootstrap`, or no TTY attached) and absent/`true` otherwise. An
  adapter must not block on `confirm` / `ask` / `askSecret` / `choose` when it is
  `false` - pick a safe default instead (the built-in local adapter now
  auto-creates a missing base path rather than asking). The field is optional and
  additive, so adapters that ignore it keep working unchanged and
  `BFS_PROVIDER_API_VERSION` stays at 2.

### Fixed
- **Restoring a backup to a machine where a storage device's path differs no
  longer stalls or fails silently in scripted (`--ci`) runs.** `bfs repair` and
  `bfs recovery` point each device at its location; when a recorded path did not
  exist, BFS asked whether to create it - a question nothing can answer in a
  non-interactive run, so the operation aborted, or reported success while
  leaving the backup unrecoverable. Non-interactive runs now create the missing
  path automatically instead of prompting, so a cross-machine or cross-OS restore
  completes. Interactive runs still ask first.

## [0.10.0] - 2026-07-07

### Added
- **`bfs repair` - fix a backup's storage locations without re-uploading it.**
  When a storage device's path changes (a USB drive mounted elsewhere, a restore
  on a different machine or OS), its credentials rotate, its data is lost, or you
  move it to a different kind of storage, `bfs repair <device> "<new settings>"`
  updates where the backup expects that device and rewrites the other devices'
  internal location records so a fresh recovery finds everything at its new
  address - no full re-upload. `--rebuild` reconstructs a device's lost data from
  the remaining devices and parity (Reed-Solomon); a migration form
  (`<device> "<new-type>:<new-name> ..."`) moves a device to a different storage
  type. `--version` scopes which versions are rewritten, and encrypted backups
  take `--password` (or prompt). Each run is integrity-checked first - a foreign
  or mismatched part aborts before any change - and a partial failure leaves a
  `.bfs/repair.lock` for a safe, idempotent retry.
- **`bfs verify` flags missing or damaged header files, and `bfs repair
  --restore-headers` rebuilds them.** After a storage device is relocated, each
  part keeps a small header file next to it recording where every part now
  lives. If one is deleted or corrupted, `bfs verify` reports it - the backup
  stays otherwise healthy - and points you at the fix; `bfs repair
  --restore-headers` rebuilds the missing or damaged header files for the
  selected versions from the current configuration, without re-uploading any
  data. This matters most for unencrypted backups, where a lost header could
  otherwise trip up a recovery.

### Fixed
- **A push that fails partway through no longer errors out in a confusing way.**
  When an upload to one storage device failed mid-push (the device rejected the
  data or the connection dropped), cleanup of the temporary working files could
  race and surface an unrelated "file not found" error - occasionally crashing
  the command - instead of reporting the partial failure cleanly. Such a push
  now fails gracefully and preserves its retry state, so `bfs push --cache` can
  pick up where it left off.

## [0.9.1] - 2026-07-03

### Fixed
- **Damaged (not just missing) backup data on one storage device no longer blocks
  a restore when the redundancy to recover it is intact.** If the data on a device
  was silently corrupted - bit rot, an interrupted transfer, a partial write -
  rather than the device being unreachable, `bfs pull` previously aborted the
  entire restore, even though the remaining devices plus the parity were enough to
  rebuild the backup. BFS now detects the damaged data, sets that device aside,
  and reconstructs the backup from the healthy ones - exactly as it already did
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
  recoverability - only how up-to-date the backup is.

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
  devices are now consistently called "nośnik" across every command and prompt.
  Wording only - no change in behavior.

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
  contacting the storage. It works offline - when the medium is unplugged, or
  when its path differs between machines (e.g. a USB drive that is `E:/` on
  Windows and `/mnt/usb1` on Linux). Run it non-interactively with `--ci` and
  the adapter's own flags (`--path`, `--config-file`, ...), or interactively to
  re-enter the configuration after seeing the current one (secrets masked).
  Rotating a storage password is fully local: credentials live only in the
  local configuration and are never written into your backup. After changing a
  non-secret coordinate (host, path, ...), BFS notes that the next `bfs push`
  updates the stored backup headers to match. The provider's name and type are
  unchanged, and the redundancy scheme is left intact.
- **Interactive `bfs init` checks each storage before accepting it.** When you
  set up a storage device during interactive setup, BFS now verifies it is
  reachable and usable (a full round-trip to the configured base path, not just
  a login) before moving on. If the check fails - a transient network error, or
  a typo in the host, port, password, or path - you can retry, re-enter the
  settings, or abort, without losing the rest of the setup. This catches a
  storage that would otherwise look fine at setup and only fail later on the
  first `bfs push`.

### Changed
- **A failed storage check in interactive `bfs provider add` is now
  recoverable.** When adding a provider interactively, a rejected configuration
  or a failed connection check no longer abandons the operation - you can retry,
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
  count in the scheme (`bfs scheme set`) or back up a smaller directory -
  instead of silently weakening the encryption.
- **Security policy published (`SECURITY.md`).** The repository now documents how
  to report a vulnerability privately, which versions receive security updates,
  and a threat model: what each storage provider can and cannot see with and
  without encryption, the metadata that stays in cleartext, how storage
  credentials are handled, the per-key encryption size limit, and the
  interactive nature of disaster recovery.
- **Provider adapter contract v2 (`bfs-vault/provider`) - BREAKING for third-party adapters.** `BFS_PROVIDER_API_VERSION` is now `2`. `StorageProvider` gained four required methods - `usesSidecar`, `uploadHeaderSidecar`, `downloadHeaderSidecar` and `verifyShard` - so an adapter compiled against version 1 no longer satisfies the interface: it must implement all four methods and declare `requiresApiVersion: 2`. An adapter missing the methods is rejected with a clear incompatibility error when BFS instantiates it - so even a precompiled adapter that slips past registration fails loudly rather than silently. The built-in local disk and FTP adapters are already updated. A provider whose medium cannot rewrite a shard header in place (append-only object stores, APIs without partial writes) returns `usesSidecar() === true` and stores the updated header in a sidecar file using the standard **BFSH** binary format (magic + version + serialized header + SHA-256); providers that rewrite in place (the built-in local disk and FTP adapters) return `false` and are otherwise unchanged. The sidecar read-path is already active in `bfs verify`: when an adapter reports `usesSidecar() === true`, a present sidecar is read in preference to the in-shard header, so its `downloadHeaderSidecar` must work from this release. `verifyShard` lets a provider confirm a shard's identity (vault id, index, version) on its own medium; it has no consumer yet and is wired into the upcoming repair and recovery flows.
- **Warning when a storage provider uses plain (unencrypted) FTP.** Every backup
  operation that connects to an FTP provider with FTPS disabled now prints a
  warning naming the server - the storage password and your backup data cross
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
  are unaffected - their encryption setting is read from their own
  configuration. The `--enc` flag is still accepted for script compatibility
  but is no longer needed.
- **Storage passwords are no longer copied into your backup.** A provider's
  password (and any other credential it marks as secret) is now kept only in
  the local backup configuration and is no longer written into the data
  distributed to your storage. This takes effect from the next `bfs push`;
  data written by earlier versions keeps the old credentials until pushed
  again. When you recover a backup on a fresh machine, BFS asks for the
  storage password only when it is actually needed - and a shared password
  entered once via `--bootstrap` is reused for every storage location that
  uses it, so a typical single-server setup recovers without extra prompts.
- **More CLI messages respect `--lang`.** A range of errors and prompts that were
  previously English-only - across `bfs push`, `bfs pull` / restore, version
  selection, and `bfs provider remove` - are now shown in the configured
  language (e.g. "password required", "passwords do not match", "not enough
  storage pieces", "pull cancelled", "no versions available"). User-facing
  messages also now broadly avoid the internal term "vault".
- **Adapter contract (`bfs-vault/provider`): optional `connectForRecovery` hook.**
  Storage adapters may now implement `connectForRecovery(io, pool, options?)` to
  show the operator the destination host before any secret is sent during
  `bfs recovery` (the built-in FTP adapter does). Adapters that don't implement it
  fall back to the previous prompt flow and remain exposed to the recovery
  credential-phishing vector for unencrypted backups - implement the hook to opt
  into the defense. No `BFS_PROVIDER_API_VERSION` bump (the method is optional).

### Fixed
- **`bfs pull --allow-missing-adapters` now restores instead of crashing when a
  provider's adapter is missing.** With the flag set, a backup whose provider
  uses a third-party adapter that is no longer installed previously still aborted
  the restore with an "unknown provider type" error - even when enough other
  providers were reachable to rebuild the data. That provider's piece is now
  skipped and the backup is reconstructed from the remaining ones, matching how
  `bfs recovery` already behaves and what the flag promises.
- **`bfs init` now rejects duplicate provider names instead of silently
  accepting them.** Passing two `--provider` specs that share a name (or entering
  the same name twice during interactive setup) previously wrote both into the
  backup configuration, where later operations resolved the name to the first
  entry and quietly orphaned the other storage - skewing the redundancy scheme.
  `bfs init` now aborts with a clear error naming the duplicate, and no
  configuration is written.
- **Cancelling an interactive prompt no longer leaks a raw `User force closed
  the prompt` message in the installed CLI.** In the published package, pressing
  Ctrl+C at a prompt - or running an interactive command such as `bfs prune`
  with no terminal attached (piped or closed input) - could print Inquirer's
  internal force-close text to stderr instead of cancelling quietly. The
  cancellation is now recognized reliably across `bfs init`, `bfs prune`,
  `bfs recovery`, and `bfs provider remove`, so it always ends cleanly.
- **Rebuilding a removed provider's data no longer leaves an encrypted backup
  unrestorable.** `bfs provider remove --strategy rebuild` wrote the reconstructed
  piece in an outdated, unencrypted on-disk format incompatible with the rest of
  the backup. `bfs verify` still reported the version healthy, but a `bfs pull`
  that needed the rebuilt piece could not decrypt it - quietly cutting redundancy
  until the data could no longer be restored. Rebuilt pieces are now written in the
  same format as the rest of the backup and restore correctly.
- **Disaster recovery now succeeds for a backup whose storage was relocated or
  rebuilt.** After moving a provider to a new address (`bfs provider remove
  --strategy relocate`) or rebuilding a removed provider's data onto another one,
  the affected version's stored headers were rewritten in an outdated format. A
  normal `bfs pull` still restored the data, but if you then lost your local backup
  metadata and ran `bfs recovery`, the metadata was reconstructed incorrectly -
  every piece failed its integrity check and the version could not be restored.
  Recovery now reads the format correctly and restores these backups.

### Security
- **A tampered backup can no longer exhaust your memory while restoring.** When
  restoring a compressed backup, BFS now limits how much a single stored file -
  and the archive as a whole - is allowed to expand to, and stops with a clear
  error if a backup tries to expand far beyond the amount of data it actually
  holds. This protects against a "decompression bomb": a small, maliciously
  crafted backup that would otherwise unpack into enough data to crash the
  machine.
- **Local backup metadata and cached data are now owner-only.** In addition to
  `config.json`, BFS now writes `state.json`, the version manifests, and any
  cached backup data under `.bfs/cache/` with owner-only permissions (`0600`),
  and creates the cache directory `0700` - matching the protection already
  applied to the configuration. On POSIX this keeps a backup's metadata
  (including the storage coordinates recorded in each manifest) and any transient
  plaintext copy of your data readable only by the owning user. On Windows these
  POSIX mode bits are a no-op; the access control of the directory holding
  `.bfs/` remains the practical protection.
- **Backup names and FTP paths are rejected when they contain unsafe characters.**
  A backup name containing a path separator or `..` would otherwise become part of
  the folder path on every storage, so a careless or pasted name could place backup
  data - and later delete it - outside the intended directory, on local disks and
  over FTP alike; `bfs init` rejects such names with a clear error before any
  configuration is written. A backup name or FTP provider path that contains a
  control character (a line break or NUL byte) is likewise refused - when the
  provider is configured and again before any path is sent to the server - closing
  a control-channel injection vector on the FTP command stream.
- **A malformed backup header can no longer exhaust memory during `bfs pull` or
  `bfs recovery`.** A tampered or corrupted backup piece could declare an
  absurdly large internal chunk size that the restore path tried to allocate up
  front, aborting the operation - most dangerous when recovering from storage
  you do not fully control. Such headers are now rejected as corrupted with a
  clear error instead.
- **Recovery can no longer be tricked into sending your storage password to an
  attacker.** Restoring an unencrypted backup with `bfs recovery` trusted the
  recovered piece's record of where the other pieces live; a single tampered
  piece could redirect a provider to the attacker's host, so the password you
  typed went there - and it stuck in the rebuilt configuration, so your next push
  would ship data there too. Recovery now shows each destination before any
  password is sent and lets you decline, cross-checks the recovered locations
  across pieces and aborts on a mismatch, and the first write after recovery -
  whether a push or a `bfs provider remove` that relocates or rebuilds storage -
  confirms where data will go. Unattended recovery can opt out of the
  per-destination prompt with `bfs recovery --trust-locations`. (Encrypted
  backups were never exposed - their location record is authenticated.)
- **Rebuilding a removed provider now aborts if the remaining pieces disagree
  about the backup's identity.** `bfs provider remove --strategy rebuild` took
  the backup metadata from the first piece it read; a tampered piece in an
  unencrypted backup could feed it forged values unnoticed. It now cross-checks
  the available pieces and refuses to rebuild on a mismatch.

## [0.6.2] - 2026-06-07

### Security
- **A restore can no longer write files outside the directory you are restoring
  into.** When restoring or recovering a backup, BFS now rejects any stored file
  whose path would escape the target directory - an absolute path, a `..`
  traversal, or a path containing a NUL byte - and stops with a clear error
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
  - **Healthy** - every provider received its piece. The success message
    now reports "X of N uploaded" so the count is explicit.
  - **Degraded** - at least N providers stored a piece (the backup is
    still fully restorable via `bfs pull`). Exit code is non-zero so CI
    scripts can detect partial state; a hint suggests how to complete it
    once the offending provider is fixed.
  - **Damaged** - fewer than N providers stored a piece. The version is
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
  "push disabled - scheme N/K below minimum 2/1" so the user knows new
  pushes will be refused until the scheme is restored.

### Changed
- `bfs pull` against an encrypted backup with the wrong password now reports
  a single clean "Decryption failed - wrong key or corrupted data" message.
  Previously duplicate decryption errors could bleed into stderr - one per
  internal data piece - looking like a crash even though the main error was
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
- **FTP/FTPS provider** - `bfs init`, `bfs provider add`, `bfs recovery`, `bfs verify`,
  `bfs push`, and `bfs pull` now support FTP servers as storage providers. Configure host,
  port, credentials, base path, and optional TLS (FTPS). Each FTP connection is opened per
  operation and closed immediately - no persistent sessions. Notable design points:
  - **Post-upload verification.** Every `bfs push` queries the server for the stored file
    size after each upload and aborts with a clear error pointing at the FTP server's
    transfer mode if the size differs from what was sent - Alpine-based vsftpd builds and
    similar configurations are known to silently drop bytes during storage. A full
    byte-for-byte round-trip (upload + download + compare) runs once during
    `bfs provider add` so a misconfigured server is caught the moment it is registered,
    before any shard ever lands on it.
  - **Automatic retry up to 3x on sporadic truncation.** Some vsftpd / Docker deployments
    occasionally truncate the data connection on a single upload (verified independently
    with Windows Explorer - environmental, not BFS-specific). Persistent truncation (e.g.
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
- `bfs recovery --provider ftp` - recover a backup from an FTP server. Without
  `--bootstrap`, the CLI prompts for full FTP configuration (host, port, user, password,
  path, secure) interactively.
- `bfs init --ci --provider "ftp:<name> --host <h> --port <p> --user <u> --password <pw> --path <abs-path> --secure <b>"` -
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
  registered type - installing a third-party adapter automatically adds it to the choices,
  no CLI rebuild required.
- `bfs provider add` now runs a full write / read / verify round-trip against the new
  provider BEFORE saving it to the vault configuration. Invalid credentials or
  insufficient permissions are caught immediately, and the vault's N+K scheme stays
  untouched until the probe succeeds.
- **`bfs provider -h` aggregates help for every registered provider** (built-in and
  external alike) into an "Available providers:" section. Each block shows `Usage`,
  description, `Options`, and examples with a consistent layout, and respects `--lang` -
  built-in providers (`local`, `ftp`) translate their description and flag descriptions
  when the UI is set to Polish. Provider names (`Local filesystem`, `FTP/FTPS`) and CLI
  examples stay in English as proper nouns and copy-pasteable commands. External adapters
  can optionally translate their own help by reading `factory.lang` (BFS sets it from
  `--lang`); adapters that don't ship translations stay English-only. Installing a
  third-party adapter automatically adds its block.
- **`bfs provider add --ci` pass-through mode.** BFS recognizes exactly three flags:
  `--ci`, `--name`, `--type`. Every other CLI token - including `--config-file`,
  `--private-key`, `--bucket` - is forwarded verbatim to the provider so adapters can
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
  provider, so adapters with their own flags (`--bucket`, `--region`, `--private-key`, ...)
  work without any BFS changes. Credentials can live in a config file read by the adapter
  instead of on the shell command line, keeping passwords out of `ps` output and shell
  history.
- **Inline flags for built-in adapters.** `local` accepts `--path <path>` (absolute or
  resolved relative to the BFS working directory). `ftp` accepts `--host`, `--port`,
  `--user`, `--password`, `--path`, `--secure` (`true|false|1|0|yes|no`). Both still
  accept `--config-file <path>`; inline flags override fields loaded from JSON.
- **Provider name charset enforced.** `bfs init` and `bfs provider add` now reject names
  containing whitespace, colons, slashes, or other punctuation - only letters, digits,
  `.`, `_` and `-` are allowed. The name is a technical identifier that appears in the
  backup config, folder layout on providers, and error messages, so it needs to be
  unambiguous to split and quote. Existing backups with older names continue to load
  unchanged; the rule applies only to newly created or newly added providers.
- **Disaster-recovery preflight** - `bfs pull` and `bfs recovery` now list every missing
  external adapter before touching any shard, with ready-to-copy
  `npm install -g <package@version>` commands. Missing built-in providers abort with a
  "BFS installation broken" diagnostic. `--allow-missing-adapters` allows Reed-Solomon
  decoding to proceed with whichever providers remain reachable.
- **Adapter version mismatch warnings** - when the recorded adapter version differs from
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
  adapter's own `configureFromFlags` parser, so every provider - built-in or external -
  accepts its full flag set, including `--config-file <path>` for adapters that read JSON.
  Examples:
    bfs recovery --provider local --name picture --bootstrap "--path /mnt/usb"
    bfs recovery --provider ftp   --name temp    --bootstrap "--host x --user u --password p --path /a"
    bfs recovery --provider ftp   --name temp    --bootstrap "--config-file ./nas.json"
  The `--config-file` form is the recommended approach for any provider whose credentials
  don't fit cleanly on a command line (private keys, OAuth tokens, multi-line secrets) -
  the JSON file stays on disk with restricted permissions, never appears in shell history.
  The interactive REPL flow (no `--bootstrap`) is unchanged - recovery still prompts for
  each field one by one.
- `bfs provider remove --strategy relocate|rebuild` no longer accepts `--new-path <path>`.
  Every adapter now declares its own flag grammar for new connection details, in symmetry
  with `bfs provider add --ci` and `bfs init --ci --provider`. Use `--config-file ./new.json`
  for the built-in FTP/LocalFS adapters, or whatever flags the adapter documents in
  `bfs provider -h`. For `relocate`, `--new-type <type>` is optional (defaults to the
  current provider type). For `rebuild` to a brand-new target, `--new-type <type>` is
  required and `--target <new-id>` names the newly-registered provider - BFS detects
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
  falls back to a safe default when reading shards written before this field existed - no
  migration, no flags, no format-version bump.
- When a shard checksum fails to verify, the error now reports the shard's total size and
  the expected/computed hash prefixes. This makes it easy to compare shard sizes across
  providers and spot a truncated transfer without having to open each file manually.
- **`bfs init --ci` now refuses incomplete argument sets instead of creating a broken
  backup.** Previously `bfs init --ci myvault` (without `--data-shards` / `--parity-shards`
  / enough `--provider` flags) silently produced a configuration with a null scheme, then
  `bfs push` crashed later with an internal Reed-Solomon error. `--ci` now requires the
  backup name as a positional argument, `--data-shards >= 2`, `--parity-shards >= 1`, and
  exactly N+K `--provider` flags - missing or invalid values abort with a clear message
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
  CLI continue to load - the path/host/etc. is persisted in `.bfs/config.json` and
  manifests, not derived from the original spec.

## [0.4.0] - 2026-04-12

### Added
- **ZIP compression** - `bfs push` now compresses backup data using deflate before uploading.
  Compression is enabled by default for new backups. For text-heavy projects (code, logs,
  configs) this typically reduces backup size by 50-80 %.
- `bfs init` now analyses directory contents before asking about compression. When most files
  are already compressed (images, videos, archives), the prompt defaults to `[y/N]` (off) and
  shows which file types were detected. For code and text-heavy directories the prompt defaults
  to `[Y/n]` (on). In CI mode (`--ci`) compression is enabled or disabled automatically based
  on the same analysis when no explicit flag is given.
- `bfs init --compress` - explicitly enable compression, skipping the auto-detect analysis.
  Useful in CI scripts that always want compression regardless of directory contents.
- `bfs init --no-compress` - disable compression when initializing a new backup (CI/scripted
  mode). In interactive mode skips the auto-detect analysis and defaults the prompt to off.
- `bfs push --compress` - enable compression for a single push, overriding the backup
  configuration (useful when compression was disabled at init time).
- `bfs push --no-compress` - disable compression for a single push, overriding the backup
  configuration.
- `bfs config --on <feature>` / `bfs config --off <feature>` - toggle compression or
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
  versions, the user only needs to enter the old password once - it is reused automatically
  for all earlier versions that share it.
- `bfs push` now always asks to confirm the encryption password when entering it interactively,
  not only on the first push. Previously a typo during a subsequent push silently uploaded the
  backup with the wrong key and the failure was only visible later during `bfs pull`.

### Fixed
- `bfs push` could fail with `ENOENT` for temporary parity files on some Linux environments
  (including GitHub Actions CI runners). Temporary files are now stored in the backup's cache
  directory (`.bfs/cache/`) instead of the system temp directory.
- `bfs recovery` appeared to hang at "Scanning providers..." when the backup was encrypted
  and no `--password` was given. The spinner was covering the password prompt, so the user
  could not see the app was waiting for input. Interactive prompts now pause the spinner.
- `bfs recovery` downloaded entire shard files (multi-GB each) just to read their headers
  (~1 KB). For a 10 GB backup with 2 versions and 3 providers, recovery would copy ~20 GB
  of data to cache before finishing. Now only the first few kilobytes of each shard are read,
  making recovery nearly instant regardless of backup size.

## [0.3.0] - 2026-04-03

### Changed
- `bfs push` and `bfs pull` now use a streaming pipeline - backups of any size are supported
  (tested up to 100 GB+). Small backups (< 50 MiB) are still packed in memory for speed;
  larger ones are automatically streamed through disk. Peak memory usage is ~200-500 MB
  regardless of backup size.
- `bfs push` is significantly faster - shard hashes are now computed during encoding
  instead of re-reading all data afterwards. For a 200 GB backup this eliminates ~500 GB
  of redundant disk reads, cutting push time roughly in half.
- The in-memory threshold for small backups is now dynamic: based on the configured RAM
  limit minus encoding overhead, capped at 4 GB. Previously it was a fixed 50 MiB.

### Added
- Interactive prompts (e.g. `bfs prune`, `bfs provider remove`, `bfs recovery`) now support
  pressing **Esc** to cancel cleanly - no error message, treated as empty selection or decline.
  **Ctrl+C** still works as a force close with a visible message.
  The `bfs prune` version picker also shows `esc anuluj` in the keyboard shortcuts bar.
- `bfs config` - new command to view and persistently configure per-backup settings.
  Use `bfs config --cache-dir <path>` to set a custom cache directory and
  `bfs config --temp-dir <path>` to set a custom temp directory.
  Use `bfs config --cache-dir --reset` (or `--temp-dir --reset`) to restore the default.
  Running `bfs config` with no arguments displays the current settings.
- `bfs push --cache-dir <path>` / `bfs pull --cache-dir <path>` - override the cache
  directory for a single operation (takes priority over the value stored in `bfs config`).
- `bfs clear --cache-dir <path>` - delete cache files from a custom directory instead of
  the default. Respects the `cache_dir` set via `bfs config` when no flag is given.
- `bfs config --max-ram <MB>` - set a persistent RAM limit for encoding operations.
  Controls how much memory is used for in-memory packing and stripe size calculation.
  Use `bfs config --max-ram --reset` to restore the default (auto: 25% of system RAM).
  Running `bfs config` with no arguments now also displays the current RAM limit.
- `bfs push --max-ram <MB>` - override the RAM limit for a single push operation.
- `bfs init` now asks for a RAM limit during interactive setup (auto-detected from
  system memory, configurable). In CI mode use `--max-ram <MB>`.
- Pressing Ctrl+C during `bfs push` or `bfs pull` now automatically removes any
  in-flight temporary files, leaving no partial data on disk.
- `bfs push --temp-dir <path>` - specify a custom directory for temporary files during push
  (blob packing and parity shard generation).
- `bfs pull --temp-dir <path>` - specify a custom directory for temporary files during pull
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
  stored unencrypted. The configuration itself is not changed - this is a one-time override.

## [0.2.0] - 2026-03-27

### Changed
- Replaced internal technical terms "blob" and "vault" in all user-facing messages
  with plain language: "backup data" / "backup" (EN) and "dane kopii" / "kopia zapasowa" (PL).
  Internal code names (`blob-pack.ts`, `packBlob()`, `VaultConfig`, etc.) are unchanged.
- All CLI option descriptions (`--cache`, `--name`, `--password`, `--force`, `--version`,
  `--keep-last`, `--strategy`, and others) are now fully translated - visible when running
  `bfs <command> --help` with `--lang pl`.

### Added
- `bfs pull -y` / `bfs pull --yes` - auto-confirms the overwrite prompt without clearing
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

[Unreleased]: https://github.com/pfranczyk/bfs/compare/v0.14.3...HEAD
[0.14.3]: https://github.com/pfranczyk/bfs/compare/v0.14.2...v0.14.3
[0.14.2]: https://github.com/pfranczyk/bfs/compare/v0.14.1...v0.14.2
[0.14.1]: https://github.com/pfranczyk/bfs/compare/v0.14.0...v0.14.1
[0.14.0]: https://github.com/pfranczyk/bfs/compare/v0.13.0...v0.14.0
[0.13.0]: https://github.com/pfranczyk/bfs/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/pfranczyk/bfs/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/pfranczyk/bfs/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/pfranczyk/bfs/compare/v0.9.1...v0.10.0
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
