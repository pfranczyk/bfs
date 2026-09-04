# shellcheck shell=bash
# A run has two volumes underneath it and they fill independently: the system
# temp, where push stages parity parts and pull stages downloaded ones, and the
# backup's own cache directory, where the packed blob (push) and the restored
# blob (pull) are written. Each side names itself: the temp gives
# `bfs config --temp-dir`, the cache `bfs config --cache-dir`, both around the
# operating system's own reason. Told only that a syscall failed on a path, the
# operator could tell neither which of the two disks ran out nor what to do
# about it - and the two have different fixes.
#
# The fault is staged by putting a directory where the blob file belongs: its
# parent exists, so every directory check passes, and the open of the file
# itself fails the way a full or read-only volume does. That is portable, unlike
# a real ENOSPC.
#
# Binding assertions: push and pull exit non-zero naming the cache directory and
# `bfs config --cache-dir` around the operating system's reason (which stays -
# the temp side keeps it too, and it is what separates a full volume from a
# read-only one), with no version recorded; the temp side keeps naming the temp
# (the two must not collapse into one message); then a usable cache directory is
# given and the restore matches byte-for-byte.

SCENARIO_NAME="push/pull: a cache directory that refuses the blob is named, with the fix"
SCENARIO_DESC="3L 2/1; blob write refused in the cache dir -> named with bfs config --cache-dir, temp faults still named as temp; the fix then works"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs122"
  local blocked="$SC_DIR/blocked-cache" good="$SC_DIR/good-cache"
  local tempfile="$SC_DIR/temp-dir-is-a-file"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  # Compression on (no --no-compress): it routes the pack through the disk path
  # unconditionally, so the blob really is written to the cache directory
  # whatever the fixture weighs.
  run_bfs "$vault" init "$name" --ci --no-enc --compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 1

  # -- push: the packed blob has nowhere to go ------------------------------
  mkdir -p "$blocked/push.blob.pending"

  run_bfs "$vault" push --new --cache-dir "$(winpath "$blocked")"
  assert_fail
  assert_out_contains "blocked-cache"
  assert_out_contains 'bfs config --cache-dir'
  # The cause stays - the temp side keeps it too, and it is the only thing
  # separating a full volume from a read-only one. What has to appear around it
  # is the directory and the fix.
  assert_out_contains "EISDIR"
  assert_state "$vault" latest_version 1

  # The pack fails after the push lock is taken, so the leftover state has to be
  # discarded before the backup is usable again - exactly as the operator would.
  run_bfs "$vault" clear
  assert_ok
  rm -rf "$blocked/push.blob.pending"

  # -- The temp volume must keep its own name (A/B control) -----------------
  # Same run, other disk. If the cache message swallowed this one, the operator
  # would be sent to move the wrong directory.
  printf 'not a directory\n' > "$tempfile"
  run_bfs "$vault" push --new --temp-dir "$(winpath "$tempfile")"
  assert_fail
  assert_out_contains "temp-dir-is-a-file"
  assert_out_contains 'bfs config --temp-dir'
  if printf '%s' "$BFS_OUT" | grep -qF 'bfs config --cache-dir'; then
    _fail "a temp fault must not be redirected at the backup volume:
$BFS_OUT"
  fi
  run_bfs "$vault" clear
  assert_ok

  # -- pull: the restored blob has nowhere to go ----------------------------
  mkdir -p "$blocked/pull.blob.pending"

  run_bfs "$vault" pull --force --yes --cache-dir "$(winpath "$blocked")"
  assert_fail
  assert_out_contains "blocked-cache"
  assert_out_contains 'bfs config --cache-dir'
  # The cause stays - the temp side keeps it too, and it is the only thing
  # separating a full volume from a read-only one. What has to appear around it
  # is the directory and the fix.
  assert_out_contains "EISDIR"
  rm -rf "$blocked/pull.blob.pending"

  # -- The advice, carried out ----------------------------------------------
  run_bfs "$vault" config --cache-dir "$(winpath "$good")"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2
  assert_dir "$good"

  mutate_fixtures "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
