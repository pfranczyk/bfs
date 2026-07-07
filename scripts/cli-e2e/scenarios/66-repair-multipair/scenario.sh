# shellcheck shell=bash
# bfs repair multi-pair: two providers migrate in a single invocation. Each pair
# is committed independently; the manifest and sibling headers reflect both new
# providers, and the backup still restores byte-for-byte.

SCENARIO_NAME="repair: multi-pair migration (two providers at once)"
SCENARIO_DESC="3L 2/1; move p1→q1 and p2→q2 in one repair, verify+pull, both renamed"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs66"
  local q1dir="$SC_DIR/q1-storage" q2dir="$SC_DIR/q2-storage"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Move p1 and p2 storage to two new providers.
  mkdir -p "$q1dir" "$q2dir"
  mv "${PV_LOCALDIR[1]}/$name" "$q1dir/"
  mv "${PV_LOCALDIR[2]}/$name" "$q2dir/"

  run_bfs "$vault" repair --version all \
    p1 "local:q1 --path $(winpath "$q1dir")" \
    p2 "local:q2 --path $(winpath "$q2dir")"
  assert_ok
  assert_manifest_contains "$vault" 1 '"provider_id": "q1"'
  assert_manifest_contains "$vault" 1 '"provider_id": "q2"'
  assert_manifest_absent "$vault" 1 '"provider_id": "p1"'
  assert_manifest_absent "$vault" 1 '"provider_id": "p2"'

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
