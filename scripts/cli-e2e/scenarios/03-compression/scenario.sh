# shellcheck shell=bash
# Compression on by default; per-push --no-compress override. Both roundtrip.
# Mirrors tests/e2e Scenariusz 9.

SCENARIO_NAME="local compression + per-push override"
SCENARIO_DESC="compressed v1, --no-compress v2, both restore"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs03"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  # v1 — compression enabled by config.
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_contains "$vault" 1 '"compressed": true'
  assert_manifest_contains "$vault" 1 'blob_size_uncompressed'

  # v2 — per-push override disables compression.
  run_bfs "$vault" push --new --no-compress
  assert_ok
  assert_manifest_absent "$vault" 2 '"compressed": true'

  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  run_bfs "$vault" pull --version 2 --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
