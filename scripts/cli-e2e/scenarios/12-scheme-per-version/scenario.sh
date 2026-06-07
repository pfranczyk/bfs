# shellcheck shell=bash
# Different scheme per version: v1 uses 3/1, then a provider is added (3/2) and
# v2 is pushed under the new scheme. Each version restores using its own
# manifest scheme. Mirrors tests/e2e Scenariusz 8.

SCENARIO_NAME="scheme per version"
SCENARIO_DESC="v1 3/1, add provider → v2 3/2, restore both"
REQUIRES_LOCAL=5
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" b2="$SC_DIR/v2.txt" name="bfs12"
  local addir="$SC_DIR/added"
  make_fixtures "$vault"
  # Build 4 providers for the initial 3/1 scheme; the 5th is added later.
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new; assert_ok          # v1: 3/1

  # Add a 5th provider — parity bumps to 2 (scheme becomes 3/2).
  mkdir -p "$addir"
  run_bfs "$vault" provider add --ci --name p4 --type local \
    --path "$(winpath "$addir")"
  assert_ok

  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$b2"
  run_bfs "$vault" push --new; assert_ok          # v2: 3/2

  assert_manifest_contains "$vault" 1 '"parity_shards": 1'
  assert_manifest_contains "$vault" 2 '"parity_shards": 2'

  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$b1"

  run_bfs "$vault" pull --version 2 --force --yes
  assert_ok
  assert_restored "$vault" "$b2"
}
