# shellcheck shell=bash
# bfs repair on an encrypted backup: repair must resolve the vault password
# (Phase 2a) and re-encrypt the rewritten sibling headers, so recovery from a
# sibling still decrypts and pulls after the provider moved.

SCENARIO_NAME="repair: encrypted local path change + propagation"
SCENARIO_DESC="3L 2/1 encrypted; move p0, repair --path --password, verify+pull, recover from sibling"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs62"
  local pw="repair-e2e-pw-62"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  # Move p0's storage, then repair to the new path with the vault password.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  assert_file "$newdir/$name/shard_0.bfs.1"

  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")" --password "$pw"
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"

  # Propagation proof: recover from sibling p1 — its re-encrypted header must
  # point p0 at the new path and decrypt with the same password.
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")" --password "$pw" --trust-locations
  assert_ok
  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
