# shellcheck shell=bash
# bfs repair --rebuild: a provider's shard is physically lost; Reed-Solomon
# reconstructs it in place from the surviving shards and the vault is healthy
# again, restoring byte-for-byte.

SCENARIO_NAME="repair --rebuild: reconstruct a lost local shard"
SCENARIO_DESC="3L 2/1 no-enc; rm p2 shard, repair --rebuild, verify healthy, pull SHA-256"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs63"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Lose p2's shard, confirm degraded, then RS-rebuild it in place.
  rm "$(shard_file 2 1)"
  assert_no_file "$(shard_file 2 1)"
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  run_bfs "$vault" repair --version 1 p2 "" --rebuild
  assert_ok
  assert_file "$(shard_file 2 1)"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
