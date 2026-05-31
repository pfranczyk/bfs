# shellcheck shell=bash
# Encrypted backup over FTP (2/1): AES-256-GCM push/pull over the network.

SCENARIO_NAME="FTP 2/1 encrypted"
SCENARIO_DESC="encrypted all-FTP push/pull roundtrip"
REQUIRES_LOCAL=0
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs22" pw="ftpSecret9"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 0 3 "$name"

  run_bfs "$vault" init "$name" --ci --enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_contains "$vault" 1 '"encrypted": true'
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
