# shellcheck shell=bash
# bfs repair: cross-OS path change. A local provider's storage moves to a new
# path; `bfs repair` updates the local config AND rewrites the sibling shards'
# location maps, so a fresh recovery from any sibling discovers the provider at
# its new path (this is what repair does beyond the local-only `provider edit`).

SCENARIO_NAME="repair: local path change + header propagation"
SCENARIO_DESC="3L 2/1; move p0 storage, repair --path, verify+pull, recover from sibling to prove propagation"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs60"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Physically move provider p0's storage to a new path, then repair to it.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  assert_file "$newdir/$name/shard_0.bfs.1"

  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")"
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Propagation proof: wipe .bfs and recover from a SIBLING (p1). Its location
  # map must already point p0 at the new path (repair rewrote it), so recovery
  # rebuilds a config that pulls successfully from the moved storage.
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")" --trust-locations
  assert_ok
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
