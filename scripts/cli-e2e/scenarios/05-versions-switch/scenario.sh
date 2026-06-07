# shellcheck shell=bash
# Two versions, then switch between them with `pull --version`. Verifies that an
# old snapshot restores its exact tree (and the v2-only file is gone), then the
# latest restores again. Mirrors tests/e2e Scenariusz 3.

SCENARIO_NAME="version switching (pull --version)"
SCENARIO_DESC="push v1/v2, restore v1 then v2, track working_version"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" b2="$SC_DIR/v2.txt" name="bfs05"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new
  assert_ok

  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$b2"
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2

  # Switch back to v1: tree matches v1 baseline and the v2-only file is absent.
  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$b1"
  assert_no_file "$vault/new-file.txt"
  assert_state "$vault" working_version 1

  # Switch forward to latest (v2).
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$b2"
  assert_file "$vault/new-file.txt"
  assert_state "$vault" working_version 2
}
