# shellcheck shell=bash
# bfs repair migration: a provider's shard is moved to a NEW provider (new id +
# type). The payload is already at the destination; repair swaps the provider in
# config + every manifest and rewrites the sibling location maps, so recovery
# from a sibling discovers the shard under its new provider id.

SCENARIO_NAME="repair: migrate provider id (local→local)"
SCENARIO_DESC="3L 2/1; move p2 storage to a new provider p9, repair migrate, verify+pull, recover from sibling"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs65"
  local newdir="$SC_DIR/p9-storage"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # The user physically moved p2's shard to a new storage that becomes p9.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[2]}/$name" "$newdir/"
  assert_file "$newdir/$name/shard_2.bfs.1"

  run_bfs "$vault" repair --version all p2 "local:p9 --path $(winpath "$newdir")"
  assert_ok
  assert_manifest_contains "$vault" 1 '"provider_id": "p9"'
  assert_manifest_absent "$vault" 1 '"provider_id": "p2"'

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Propagation: recover from a sibling (p1); its location map must point the
  # migrated shard at p9's new storage.
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")" --trust-locations
  assert_ok
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
