# shellcheck shell=bash
# bfs repair: pointing a provider at a path that does not hold its shards must
# fail cleanly — the config stays untouched and the vault remains healthy.

SCENARIO_NAME="repair: bad path aborts, config untouched"
SCENARIO_DESC="3L 2/1; repair p0 to an empty path (no shards) fails, verify still healthy, repair.lock kept"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs61"
  local emptydir="$SC_DIR/empty"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Point p0 at an existing but empty directory — its shards are not there.
  mkdir -p "$emptydir"
  run_bfs "$vault" repair --version all p0 "--path $(winpath "$emptydir")"
  assert_fail
  assert_out_matches 'repair.lock'
  assert_file "$vault/.bfs/repair.lock"

  # Config untouched: the vault still verifies healthy from the original paths.
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
