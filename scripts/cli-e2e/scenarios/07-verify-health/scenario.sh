# shellcheck shell=bash
# Health transitions: healthy → degraded → damaged as shards disappear.
# Mirrors tests/e2e Scenariusz 6 / tests/cli/verify.

SCENARIO_NAME="verify health transitions"
SCENARIO_DESC="healthy → degraded → damaged on shard loss"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs07"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # 3 of 4 shards → still ≥ N(3), below N+K(4): degraded.
  rm "$(shard_file 0 1)"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  # 2 of 4 shards → below N(3): damaged, unrecoverable.
  rm "$(shard_file 1 1)"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 damaged
}
