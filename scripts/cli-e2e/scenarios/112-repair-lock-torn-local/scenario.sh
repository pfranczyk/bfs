# shellcheck shell=bash
# bfs repair: a repair.lock that exists but carries no readable owner is a peer's
# reservation, not leftover state. The exclusive create that reserves the lock
# returns BEFORE the JSON payload is written, so a peer that just won the race is
# visible on disk as a zero-byte file. Repair must not read that emptiness as
# "dead leftover", delete it and walk in - that admits two repairs onto the same
# version, both rewriting the sibling location maps.
#
# Zero-byte repair.lock is written directly here: the real window is microseconds
# wide between two processes, and the state it produces on disk is exactly this
# file. `bfs clear` is the positive control - it drops the leftover and the same
# repair then commits, so refusing does not strand the operator.

SCENARIO_NAME="repair refuses on a repair.lock with no readable owner"
SCENARIO_DESC="3L 2/1; zero-byte repair.lock -> repair refuses and keeps the reservation; clear -> same repair commits + roundtrip"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs112"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Give the repair real work: p0's storage moves to a new path.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  assert_file "$newdir/$name/shard_0.bfs.1"

  # A peer mid-acquisition: the file is reserved, the payload is not there yet.
  : >"$vault/.bfs/repair.lock"
  assert_file "$vault/.bfs/repair.lock"

  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")"
  assert_fail
  assert_out_contains "carries no readable owner"
  # The advice must be executable in the state where it prints - the run below
  # walks it: `bfs clear`, then the same repair.
  assert_out_contains "bfs clear"
  # The peer's reservation must survive: deleting it is the defect itself.
  assert_file "$vault/.bfs/repair.lock"
  # Nothing was committed - p0 still points at the old, now-empty path, so the
  # version is short one shard.
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Positive control: the operator's way out works, and the same repair commits.
  run_bfs "$vault" clear
  assert_ok
  assert_no_file "$vault/.bfs/repair.lock"

  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")"
  assert_ok
  assert_no_file "$vault/.bfs/repair.lock"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
