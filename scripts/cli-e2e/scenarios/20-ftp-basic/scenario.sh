# shellcheck shell=bash
# All-FTP 3/1 roundtrip including a multi-megabyte binary (upload integrity /
# chunking). One supplied --ftp endpoint backs all four providers via distinct
# remote sub-paths. Mirrors smoke Suite L.

SCENARIO_NAME="FTP 3/1 basic + large binary"
SCENARIO_DESC="all-FTP push/pull, 2 MB binary integrity"
REQUIRES_LOCAL=0
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs20"
  make_fixtures "$vault"
  make_large_file "$vault" $((2 * 1024 * 1024))
  build_pool "$SC_DIR" 0 4 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
