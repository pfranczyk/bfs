# shellcheck shell=bash
# Heal by relocation: a provider's storage moves to a new path; update the
# address and stay healthy. Mirrors vault-manager removeProvider relocate.

SCENARIO_NAME="heal: provider relocate"
SCENARIO_DESC="move shards to new path, relocate, stay healthy"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs10"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Physically move provider p0's storage to a new location, then relocate.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  assert_file "$newdir/$name/shard_0.bfs.1"

  run_bfs "$vault" provider remove p0 \
    --strategy relocate --path "$(winpath "$newdir")" --yes
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
