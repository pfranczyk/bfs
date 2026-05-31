# shellcheck shell=bash
# Extreme scheme sanity check: 3/5 (8 providers, local-only for speed). A very
# parity-heavy layout — push, verify, drop a shard, restore. Light by design.

SCENARIO_NAME="extreme 3/5 (8 providers)"
SCENARIO_DESC="very-high-parity roundtrip + single-shard repair"
REQUIRES_LOCAL=8
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs27"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 8 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 5 "${PROVIDER_ARGS[@]}"
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
