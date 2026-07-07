# shellcheck shell=bash
# bfs repair on an FTP provider: the shard's remote storage moves to a new path
# (a relocated remote dir / changed mount point). `bfs repair` rewrites the config
# AND the sibling shards' location maps over the network — the payload is NOT
# rebuilt, only the header coordinates — and the backup restores from the FTP
# shard at its new remote path. (Sibling-header propagation is proven for the
# local case by scenarios 60/62/65; a recovery-from-sibling proof for an FTP
# sibling is not repeated here because the FTP password is stripped from the
# location map, so recovery cannot re-contact it non-interactively.)

SCENARIO_NAME="repair: FTP path change (header rewrite, no rebuild)"
SCENARIO_DESC="2L+1F 2/1; move the FTP shard's remote dir, repair --config-file, verify+pull, recover from sibling"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs67"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L · p1 L · p2 F

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Relocate the FTP provider p2's remote storage, then repair to the new path.
  # The new connection config goes through a JSON file (the documented
  # credential-file form): a lone POSIX remote path in argv would be rewritten to
  # a Windows path by Git-Bash/MSYS before the native bfs process sees it — the
  # JSON content is not subject to that.
  local e="${PV_FTP_ENDPOINT[2]}"
  local oldremote="${PV_FTP_REMOTE[2]}"
  local newremote="${oldremote}-moved-${name}"
  local ftpjson="$SC_DIR/ftp-p2-new.json"
  ftp_rename "$e" "$oldremote" "$newremote"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s","secure":%s}\n' \
    "${FTP_HOST[$e]}" "${FTP_PORT[$e]}" "${FTP_USER[$e]}" "${FTP_PASS[$e]}" \
    "$newremote" "${FTP_SECURE[$e]}" >"$ftpjson"

  run_bfs "$vault" repair --version all p2 "--config-file $(winpath "$ftpjson")"
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
