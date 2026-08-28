# shellcheck shell=bash
# A temp directory that cannot take the scratch files is a local condition with
# a one-command fix, and both push and pull have to say so: name the path that
# refused and point at `bfs config --temp-dir`. A path that exists as a file is
# the portable way to make the scratch unusable from outside the process (a
# full volume cannot be staged on every platform): its parent exists, so the
# directory check passes, and creating the scratch under it fails inside the
# operating system.
#
# Binding assertions: exit != 0 with the path and the hint in the output, no
# raw stack trace, nothing recorded as a new version - then the advice is
# carried out (`bfs config --temp-dir <dir>`), push and pull go through that
# directory, and the restore matches the snapshot byte-for-byte.

SCENARIO_NAME="push/pull: --temp-dir that is a file is named, with the fix"
SCENARIO_DESC="3L 2/1; --temp-dir <file> refused by push and pull with path + bfs config --temp-dir hint; the hint then works"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs118"
  local tempfile="$SC_DIR/temp-dir-is-a-file" scratch="$SC_DIR/scratch"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 1

  printf 'not a directory\n' > "$tempfile"

  run_bfs "$vault" push --new --temp-dir "$(winpath "$tempfile")"
  assert_fail
  assert_out_contains "temp-dir-is-a-file"
  assert_out_contains 'bfs config --temp-dir'
  assert_state "$vault" latest_version 1

  run_bfs "$vault" pull --force --yes --temp-dir "$(winpath "$tempfile")"
  assert_fail
  assert_out_contains "temp-dir-is-a-file"
  assert_out_contains 'bfs config --temp-dir'

  # The advice, carried out: a directory that does not exist yet is accepted
  # (only its parent must), and push creates it on first use.
  run_bfs "$vault" config --temp-dir "$(winpath "$scratch")"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2
  assert_dir "$scratch"

  # The working tree is dirtied before the restore, so a pull that did nothing
  # could not pass the SHA-256 comparison.
  mutate_fixtures "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
