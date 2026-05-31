# shellcheck shell=bash
# Extreme scheme sanity check: 3/3 (6 providers, local-only for speed). Confirms
# a high parity count pushes, verifies, loses a shard, and restores. Light by
# design — deep loss-tolerance is covered by the 01/02/25 scenarios.

SCENARIO_NAME="extreme 3/3 (6 providers)"
SCENARIO_DESC="high-parity roundtrip + single-shard repair"
REQUIRES_LOCAL=6
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs26"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 6 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 3 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  rm "$(shard_file 0 1)"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
