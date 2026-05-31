# shellcheck shell=bash
# Compression + encryption together: deflate → AES-256-GCM → roundtrip.
# Mirrors tests/e2e Scenariusz 10.

SCENARIO_NAME="local compress + encrypt 2/1"
SCENARIO_DESC="deflate + AES roundtrip byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs04" pw="p4ssw0rd"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc --compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_contains "$vault" 1 '"compressed": true'
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
