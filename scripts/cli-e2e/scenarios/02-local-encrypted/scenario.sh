# shellcheck shell=bash
# Encrypted 5/2: push with password, lose 2 shards, restore from 5 of 7.
# Mirrors tests/e2e Scenariusz 2.

SCENARIO_NAME="local 5/2 encrypted + 2 lost shards"
SCENARIO_DESC="AES-256-GCM push/pull, restore from 5 of 7 shards"
REQUIRES_LOCAL=7
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs02" pw="Secret123!"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 7 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc --no-compress \
    --data-shards 5 --parity-shards 2 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  # Lose two shards — within the K=2 parity tolerance.
  rm "$(shard_file 0 1)"
  rm "$(shard_file 6 1)"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
