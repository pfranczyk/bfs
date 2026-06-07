# shellcheck shell=bash
# init → push → lose one shard → verify (degraded) → pull (RS repair) → SHA match.
# Mirrors tests/e2e Scenariusz 1 (3/1, restore from 3 of 4 shards).

SCENARIO_NAME="local 3/1 basic + RS repair"
SCENARIO_DESC="init/push/verify/pull, restore from 3 of 4 shards"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs01"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok
  assert_out_contains "healthy"
  assert_manifest_health "$vault" 1 healthy
  assert_file "$(shard_file 0 1)"
  assert_file "$(shard_file 3 1)"

  # Simulate loss of one provider's shard, then confirm degraded health.
  rm "$(shard_file 0 1)"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  # Reed-Solomon reconstructs the missing shard from the surviving 3 of 4.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
