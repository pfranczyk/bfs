# shellcheck shell=bash
# Sidecar detection (verify), local: a MISSING hdr_ sidecar next to a shard
# whose payload and in-shard header are intact. `bfs verify` must stay exit 0
# and keep the version healthy (data availability is read from the in-shard
# header, immune to the sidecar), while surfacing an advisory that a header
# sidecar is missing and can be restored with `bfs repair --restore-headers`.
#
# The advisory line is the load-bearing assertion: a missing sidecar falls back
# to the in-shard header, so the version stays healthy regardless — what proves
# detection is the `--restore-headers` hint appearing in the report.

SCENARIO_NAME="verify: missing hdr_ sidecar surfaces --restore-headers advisory"
SCENARIO_DESC="3L 2/1; repair --path p0 writes sidecars, delete p1's hdr_, verify stays healthy + advises --restore-headers"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs74"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Relocate provider p0 so a repair writes an hdr_ sidecar next to EVERY shard
  # (each sibling's location map is updated via a sidecar, not a shard rewrite).
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")"
  assert_ok
  assert_file "$newdir/$name/hdr_0.bfs.1"
  assert_file "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"
  assert_file "${PV_LOCALDIR[2]}/$name/hdr_2.bfs.1"

  # Delete a non-relocated provider's sidecar (p1, still at its original dir, so
  # its hdr path is stable). The shard payload + in-shard header stay intact.
  # Sidecar filename = shard filename with the leading shard_ swapped for hdr_.
  rm -f "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"
  assert_no_file "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_out_contains "--restore-headers"
}
