# shellcheck shell=bash
# Sidecar (BFSH) headers, FTP: a `bfs repair` location change on an FTP provider
# writes the updated header to a small remote `hdr_i.bfs.V` sidecar over the
# network INSTEAD of downloading + re-uploading the whole shard. Proves the
# expensive case: the multi-* shard payload on FTP is NOT re-transmitted — only
# a KB-sized sidecar is uploaded. Assertions read the remote bytes directly via
# ftp_sha (SHA-256 of the remote file), so a full rewrite (which changes the
# header bytes + trailing checksum) is caught even though the size is identical.
#
# RED today: repair rewrites the FTP shard (remote hash changes) and no remote
# hdr_ sidecar exists. Local siblings (p0/p1) gain hdr_ sidecars too — the mixed
# local+FTP case propagates the new map to every provider. Recovery-from-sibling
# for FTP is not exercised here (the FTP password is stripped from the location
# map, so a non-interactive re-contact is impossible — the local scenario 72
# proves the sidecar read-path reroute).

SCENARIO_NAME="sidecar: FTP relocate uploads hdr_ sidecar, no shard re-upload"
SCENARIO_DESC="2L+1F 2/1; repair the FTP shard's path, assert remote shard bytes unchanged + remote hdr_ sidecar present"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs73"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L · p1 L · p2 F

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Relocate the FTP provider p2's remote storage, then repair to the new path
  # (the documented credential-file form — a lone POSIX path in argv would be
  # rewritten to a Windows path by Git-Bash/MSYS before bfs sees it).
  local e="${PV_FTP_ENDPOINT[2]}"
  local oldremote="${PV_FTP_REMOTE[2]}"
  local newremote="${oldremote}-moved-${name}"
  local ftpjson="$SC_DIR/ftp-p2-new.json"
  ftp_rename "$e" "$oldremote" "$newremote"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s","secure":%s}\n' \
    "${FTP_HOST[$e]}" "${FTP_PORT[$e]}" "${FTP_USER[$e]}" "${FTP_PASS[$e]}" \
    "$newremote" "${FTP_SECURE[$e]}" >"$ftpjson"

  # Record the FTP shard's payload hash at its new remote path, before repair.
  local ftpshard="$newremote/$name/shard_2.bfs.1"
  local ftpsidecar="$newremote/$name/hdr_2.bfs.1"
  local h2
  h2="$(ftp_sha "$e" "$ftpshard")"
  [ -n "$h2" ] || _fail "could not read FTP shard before repair: $ftpshard"

  run_bfs "$vault" repair --version all p2 "--config-file $(winpath "$ftpjson")"
  assert_ok

  # Sidecar proof (FTP): the shard payload must be byte-for-byte unchanged…
  local a2
  a2="$(ftp_sha "$e" "$ftpshard")"
  [ "$a2" = "$h2" ] || _fail "FTP shard_2 payload changed by repair (expected sidecar, got full re-upload):
    before=$h2
    after =$a2"
  # …and a remote hdr_ sidecar must now exist (ftp_sha exits 0 when present).
  if ! ftp_sha "$e" "$ftpsidecar" >/dev/null; then
    _fail "FTP sidecar missing after repair: $ftpsidecar"
  fi
  # Local siblings propagate too: each gains an hdr_ sidecar.
  assert_file "${PV_LOCALDIR[0]}/$name/hdr_0.bfs.1"
  assert_file "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
