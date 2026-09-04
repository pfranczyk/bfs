# shellcheck shell=bash
# The pack loop reads a user file and writes it into the compressed blob under
# one error handler, and only the handle knows which of the two refused. When
# the backup volume refuses a write, the loop is told nothing that separates it
# from a file it could not read - so it files the refusal against the file it
# happened to be holding, and carries on.
#
# What that costs the operator is the whole point of testing it end to end.
# The pack finishes and seals the blob with a checksum computed by re-reading
# what is on disk, so the seal agrees with an archive that is short of a member.
# The CLI then advises `bfs push --cache` - upload what is already packed -
# which is exactly the command that would put an incomplete backup on the
# storage. Nothing about it looks wrong until a restore comes up short, and the
# unit tests cannot show that the advice itself is the trap.
#
# Sibling of 122, which stages the other shape: there the OPEN of the blob file
# is refused (a directory in its place), here the open succeeds and one WRITE
# inside the loop is refused. 122 is portable without help; this one needs the
# refusal injected into the process, because a volume that stays full also
# refuses the final write - the pack then aborts and reports the truth, so the
# damaging shape never appears. See lib/fs-write-fault-hooks.mjs.
#
# The local header is the write refused here because it is the quiet one:
# nothing of the file reaches the archive, the stream stays structurally sound,
# and a restore SUCCEEDS while silently missing the file. Refusing the
# compressed bytes instead breaks the restore loudly, which is easier to notice
# and therefore the lesser danger.
#
# Binding assertions: the push exits non-zero naming the cache directory and
# `bfs config --cache-dir`, and does NOT name a user file or claim it could not
# be read; no version is recorded; the cache left behind is not accepted as a
# finished backup by `--cache`; and once the fault is gone the same directory
# packs, uploads and restores byte-for-byte.

SCENARIO_NAME="push: a write refused inside the compressed pack is not blamed on a user file"
SCENARIO_DESC="3L 2/1 --compress; one refused local-header write -> cache dir named, no user file blamed, no silent short backup"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="zipfault"
  local work="$SC_DIR/work"
  mkdir -p "$work"

  build_pool "$SC_DIR" 3 0 "$vault"

  # Named distinctly on purpose. The check below proves no user file is blamed
  # for the disk's refusal, and it can only do that if a file name cannot occur
  # in the message by coincidence - which rules out the shared fixture set,
  # where a directory called "data" would match wording about backup data.
  # Incompressible bodies, so a file's compressed payload dwarfs the headers
  # around it and the injected fault can tell the three writes apart.
  local payload
  for payload in payload-01 payload-02 payload-03 payload-04; do
    head -c 8192 /dev/urandom > "$work/$payload.bin"
  done
  printf 'a readable line\n' > "$work/payload-05.txt"

  run_bfs "$work" init "$vault" --ci --no-enc --compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$work" "$SC_DIR/baseline.txt"

  # --- The refused write ------------------------------------------------------
  # The third local header written, whichever file that turns out to be: the
  # point is that a readable file gets blamed, not which one. Naming it here
  # would tie the scenario to the fixture's sort order.
  export NODE_OPTIONS="--import ./scripts/cli-e2e/lib/fs-write-fault.mjs"
  export BFS_FAULT_KIND="lfh"
  export BFS_FAULT_AT="3"
  export BFS_FAULT_CODE="ENOSPC"

  run_bfs "$work" push
  local push_out="$BFS_OUT"

  unset NODE_OPTIONS BFS_FAULT_KIND BFS_FAULT_AT BFS_FAULT_CODE

  BFS_OUT="$push_out"
  assert_fail
  assert_out_contains "bfs config --cache-dir"
  assert_out_contains "ENOSPC"
  # The refusal came from the destination; the file being packed was readable.
  # Naming it sends the operator to inspect a file that is perfectly fine.
  if printf '%s' "$push_out" | grep -qiE "could not be read"; then
    _fail "refused write reported as a file that could not be read"
  fi
  # The skipped-files list is how a readable file gets named for a fault that was
  # not its doing; a destination refusal must not produce that list at all.
  if printf '%s' "$push_out" | grep -qiE "excluded"; then
    _fail "refused write reported as excluded user files"
  fi
  # The file being packed when the disk refused must not be named at all - that
  # is the whole difference between blaming the volume and blaming a file.
  if printf '%s' "$push_out" | grep -qF -- "payload-"; then
    _fail "refused write blamed on a user file"
  fi

  # Nothing may have been recorded: the pack never produced a complete blob.
  assert_state "$work" latest_version 0

  # --- The advice must lead to a backup that holds everything -----------------
  # `bfs push --cache` is what the CLI suggests after a failed push, so wherever
  # it leads is where the operator ends up. The blob's header is written last,
  # so a pack cut short leaves a file that never became a blob - the resume
  # recognises that and packs the directory again rather than uploading the
  # remains. Either way the version that lands must give every file back, which
  # only shows if the working copy is cleared first: leaving the files in place
  # would let a backup missing one of them pass.
  run_bfs "$work" push --cache
  if [ "$BFS_EXIT" -eq 0 ]; then
    rm -f "$work"/payload-*
    run_bfs "$work" pull --yes
    assert_ok
    assert_restored "$work" "$SC_DIR/baseline.txt"
  else
    # Refusing the resume is the other honest way out, but it has to be about
    # the cached data. Without this the whole check could go quiet behind a
    # resume that fails for some unrelated reason.
    assert_out_matches "cache|Cache"
  fi

  # --- Control: with no fault the same directory round-trips ------------------
  # A pack cut short leaves its lock and half-written cache behind, and the next
  # push refuses on that state rather than on anything this control is about.
  run_bfs "$work" clear
  run_bfs "$work" push
  assert_ok
  rm -f "$work"/payload-*
  run_bfs "$work" pull --yes
  assert_ok
  assert_restored "$work" "$SC_DIR/baseline.txt"

  return 0
}
