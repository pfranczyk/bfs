# shellcheck shell=bash
# repair --restore-headers, BROKEN sidecar (local, --no-enc): after a relocate
# writes an hdr_ sidecar next to EVERY shard, one sibling's sidecar is CORRUPTED
# (non-BFSH bytes). `bfs verify` surfaces the --restore-headers advisory; `bfs
# repair --restore-headers` OVERWRITES the broken sidecar with a valid BFSH
# envelope rebuilt from the CURRENT config map + the in-shard frozen fields, so
# verify's advisory disappears and a fresh recovery from that sibling restores
# the files byte-for-byte.

SCENARIO_NAME="repair --restore-headers overwrites a broken sidecar (local, no-enc)"
SCENARIO_DESC="3L 2/1; relocate p0 writes sidecars, corrupt p1's hdr_, repair --restore-headers overwrites it, advisory gone, recover from p1 byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs77"
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

  # Relocate p0 so a repair writes an hdr_ sidecar next to EVERY shard.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")"
  assert_ok
  assert_file "$newdir/$name/hdr_0.bfs.1"
  assert_file "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"
  assert_file "${PV_LOCALDIR[2]}/$name/hdr_2.bfs.1"

  # Corrupt a non-relocated provider's sidecar (p1, stable path) with non-BFSH
  # bytes so extractSidecarHeaderBytes rejects it. The shard payload + in-shard
  # header stay intact — only the sidecar file is broken.
  local hdr="${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"
  printf 'GARBAGE-NOT-BFSH' > "$hdr"
  assert_file "$hdr"

  # Detection (already implemented): verify stays healthy but advises the fix.
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_out_contains "--restore-headers"

  # FIX (RED today): overwrite every broken sidecar for all versions from config.
  run_bfs "$vault" repair --restore-headers
  assert_ok
  assert_file "$hdr"

  # The advisory is gone — the overwritten sidecar is a valid BFSH envelope again
  # (verify's sidecar probe parses it).
  run_bfs "$vault" verify
  assert_ok
  if printf '%s' "$BFS_OUT" | grep -qF -- "--restore-headers"; then
    _fail "verify still advises --restore-headers after repair overwrote the broken sidecar"
  fi

  # Correctness: wipe .bfs and recover from p1, the sidecar we corrupted+rebuilt.
  # Its map must point p0 at the new path (from config), so pull succeeds.
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")" --trust-locations
  assert_ok
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
