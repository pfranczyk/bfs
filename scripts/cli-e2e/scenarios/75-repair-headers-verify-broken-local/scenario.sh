# shellcheck shell=bash
# Sidecar detection (verify), local: a BROKEN hdr_ sidecar (non-BFSH bytes) next
# to a shard whose payload and in-shard header are intact. `bfs verify` must stay
# exit 0 and keep the version healthy — data availability/identity is read from
# the in-shard header, so a corrupt sidecar must NOT reduce availability — while
# surfacing an advisory that a header sidecar is broken and can be restored with
# `bfs repair --restore-headers`.
#
# Two assertions carry this scenario: the version stays healthy (a broken sidecar
# never reduces availability — identity is read from the in-shard header), and the
# `--restore-headers` hint appears in the report.

SCENARIO_NAME="verify: broken hdr_ sidecar stays healthy + advises --restore-headers"
SCENARIO_DESC="3L 2/1; repair --path p0 writes sidecars, corrupt p1's hdr_, verify stays healthy (not degraded) + advises --restore-headers"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs75"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Relocate provider p0 so a repair writes an hdr_ sidecar next to EVERY shard.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")"
  assert_ok
  assert_file "$newdir/$name/hdr_0.bfs.1"
  assert_file "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"
  assert_file "${PV_LOCALDIR[2]}/$name/hdr_2.bfs.1"

  # Corrupt a non-relocated provider's sidecar (p1, still at its original dir):
  # overwrite it with non-BFSH bytes so extractSidecarHeaderBytes throws. The
  # shard payload + in-shard header stay intact, so data must remain healthy.
  printf 'GARBAGE-NOT-BFSH' > "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"
  assert_file "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_out_contains "--restore-headers"
}
