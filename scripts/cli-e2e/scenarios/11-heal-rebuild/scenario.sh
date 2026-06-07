# shellcheck shell=bash
# Heal by rebuild: re-encode a removed provider's shard onto a brand-new
# provider via Reed-Solomon, then stay healthy. Mirrors tests/e2e Scenariusz 7.

SCENARIO_NAME="heal: provider rebuild"
SCENARIO_DESC="rebuild p0's shard onto a new provider, stay healthy"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs11"
  local newdir="$SC_DIR/rebuilt"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Remove p0 by rebuilding its shard onto a new local provider "p4".
  mkdir -p "$newdir"
  run_bfs "$vault" provider remove p0 \
    --strategy rebuild --target p4 --new-type local \
    --path "$(winpath "$newdir")" --scope all --yes
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
