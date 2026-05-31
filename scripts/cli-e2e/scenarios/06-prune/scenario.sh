# shellcheck shell=bash
# Three versions, then prune by single version and by --keep-last.
# Mirrors tests/cli/prune.

SCENARIO_NAME="prune versions (range + keep-last)"
SCENARIO_DESC="delete v1 by id, then keep only the latest"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs06"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  run_bfs "$vault" push --new; assert_ok   # v1
  run_bfs "$vault" push --new; assert_ok   # v2
  run_bfs "$vault" push --new; assert_ok   # v3

  assert_file "$vault/.bfs/manifests/v001.json"
  assert_file "$vault/.bfs/manifests/v002.json"
  assert_file "$vault/.bfs/manifests/v003.json"

  # Delete a single version by id.
  run_bfs "$vault" prune 1 --yes
  assert_ok
  assert_no_file "$vault/.bfs/manifests/v001.json"
  assert_file "$vault/.bfs/manifests/v002.json"
  assert_file "$vault/.bfs/manifests/v003.json"

  # Keep only the latest; v2 goes away.
  run_bfs "$vault" prune --keep-last 1 --yes
  assert_ok
  assert_no_file "$vault/.bfs/manifests/v002.json"
  assert_file "$vault/.bfs/manifests/v003.json"
}
