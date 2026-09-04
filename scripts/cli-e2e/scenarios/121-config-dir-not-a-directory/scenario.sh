# shellcheck shell=bash
# `bfs config` is the only writer of cache_dir / temp_dir, and push and pull are
# the only readers. The readers refuse a path whose leaf exists and is not a
# directory, and say so with the one-command fix; the writer checks the parent
# alone. It therefore stores a value its own readers will reject, reports
# success while doing it, and exits 0 - so nothing driving `bfs config` from a
# script can tell a stored setting from a refused one. The operator finds out
# one push later, from a message that sends them back to this very command.
#
# Binding assertions: the refusal exits non-zero, names the reason (not "does
# not exist" for a path that exists), carries the `bfs config --<flag>` hint,
# and leaves config.json untouched - then the same setting pointed at a usable
# path is accepted, push and pull run through it, and the restore matches the
# snapshot byte-for-byte.

SCENARIO_NAME="config: --temp-dir/--cache-dir that is a file is refused, not stored"
SCENARIO_DESC="3L 2/1; bfs config refuses the leaf its own readers reject, exits != 0, config untouched; the accepted path then works"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs121"
  local leaffile="$SC_DIR/config-dir-is-a-file"
  local goodtemp="$SC_DIR/good-temp" goodcache="$SC_DIR/good-cache"
  local cfg="$vault/.bfs/config.json"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 1

  printf 'not a directory\n' > "$leaffile"

  # -- The leaf that exists as a file ---------------------------------------
  run_bfs "$vault" config --temp-dir "$(winpath "$leaffile")"
  assert_fail
  assert_out_contains "config-dir-is-a-file"
  assert_out_contains 'bfs config --temp-dir'
  # Asserted on both flags, not just one: a half fix that corrected the cache
  # branch and left the temp branch alone would otherwise walk through here.
  assert_out_matches 'not a directory|nie jest katalogiem'
  if printf '%s' "$BFS_OUT" | grep -qiE 'does not exist|nie istnieje'; then
    _fail "an obstacle that is not absence must not be reported as absence:
$BFS_OUT"
  fi
  if grep -q '"temp_dir"' "$cfg"; then
    _fail "a refused path must not reach config.json: $(grep '"temp_dir"' "$cfg")"
  fi

  # The operator acts on what the message says, and "does not exist" reads as
  # "create it" - which is the one thing that cannot work here: mkdir on this
  # path fails with ENOTDIR however many times it is tried.
  run_bfs "$vault" config --cache-dir "$(winpath "$leaffile")"
  assert_fail
  assert_out_contains "config-dir-is-a-file"
  assert_out_contains 'bfs config --cache-dir'
  assert_out_matches 'not a directory|nie jest katalogiem'
  if printf '%s' "$BFS_OUT" | grep -qiE 'does not exist|nie istnieje'; then
    _fail "an obstacle that is not absence must not be reported as absence:
$BFS_OUT"
  fi
  if grep -q '"cache_dir"' "$cfg"; then
    _fail "a refused path must not reach config.json: $(grep '"cache_dir"' "$cfg")"
  fi

  # -- The refusal did not disturb the backup -------------------------------
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2

  # -- The same settings, pointed somewhere usable --------------------------
  # A directory that does not exist yet is accepted: only its parent must, and
  # push and pull create the leaf on first use.
  run_bfs "$vault" config --temp-dir "$(winpath "$goodtemp")"
  assert_ok
  run_bfs "$vault" config --cache-dir "$(winpath "$goodcache")"
  assert_ok

  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 3
  assert_dir "$goodtemp"
  assert_dir "$goodcache"

  # The working tree is dirtied before the restore, so a pull that did nothing
  # could not pass the SHA-256 comparison.
  mutate_fixtures "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
