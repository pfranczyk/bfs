# shellcheck shell=bash
# bfs repair --rebuild on an encrypted backup: reconstruction must decrypt the
# surviving shards (Phase 2a resolves the password), RS-repair the plaintext,
# and re-encrypt the rebuilt shard with the deterministic per-shard nonce so it
# is byte-identical to the original.

SCENARIO_NAME="repair --rebuild: reconstruct a lost encrypted shard"
SCENARIO_DESC="3L 2/1 encrypted; rm p2 shard, repair --rebuild --password, verify healthy, pull SHA-256"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs64"
  local pw="repair-rebuild-pw-64"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  rm "$(shard_file 2 1)"
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  run_bfs "$vault" repair --version 1 p2 "" --rebuild --password "$pw"
  assert_ok
  assert_file "$(shard_file 2 1)"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
