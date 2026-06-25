# shellcheck shell=bash
# Documented limitation: an OFFLINE `bfs provider edit` rewrites only the local
# config — it does NOT touch the location map inside the stored backup pieces.
# So if the local metadata is then lost and rebuilt with `bfs recovery` (which
# reconstructs the config from the pieces' headers), the edit is gone: recovery
# restores the provider's ORIGINAL address, not the edited one. The remedy is to
# `bfs push` after editing (a push re-stamps the headers) — or to re-apply the
# edit after recovery. This scenario pins that behavior so a future change can't
# silently alter it.

SCENARIO_NAME="provider edit lost on disaster recovery (no push)"
SCENARIO_DESC="offline edit relocates a provider; .bfs/ loss + recovery rebuilds the ORIGINAL address from headers"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs52"
  local newloc="$SC_DIR/relocated-p0"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"   # p0 p1 p2, scheme 2/1

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new; assert_ok            # v1 headers encode p0's ORIGINAL path

  # Physically relocate p0 and repoint it offline — but do NOT push, so the
  # backup pieces still carry the original location map.
  mkdir -p "$newloc"
  mv "${PV_LOCALDIR[0]}/$name" "$newloc/"
  run_bfs "$vault" provider edit p0 --ci --path "$(winpath "$newloc")"
  assert_ok
  grep -qF 'relocated-p0' "$vault/.bfs/config.json" || _fail "edit did not record the new path in config"

  # Catastrophe: the local metadata (the only place the edit lived) is gone.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Rebuild from a surviving provider (p1, untouched). Recovery reconstructs the
  # config from the pieces' headers → p0 comes back at its ORIGINAL address.
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  # The offline edit did not survive — recovery used the headers, not the lost
  # local config. This is the limitation being pinned.
  if grep -qF 'relocated-p0' "$vault/.bfs/config.json"; then
    _fail "recovered config kept the offline edit (relocated-p0); recovery must rebuild from backup headers"
  fi

  # Data is still restorable: p0's original address is now empty (moved), but the
  # 2/1 redundancy reconstructs from p1+p2.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Remedy: re-apply the edit after recovery → the relocated p0 is healthy again.
  run_bfs "$vault" provider edit p0 --ci --path "$(winpath "$newloc")"
  assert_ok
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
}
