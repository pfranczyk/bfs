# shellcheck shell=bash
# `bfs provider edit` on a mixed pool (local + FTP), ENCRYPTED backup.
# Physically relocate BOTH a local and an FTP provider's storage, then point the
# providers at the new addresses with `bfs provider edit` (offline, no medium
# contact). `bfs verify` must find every shard at its EDITED location, the v1
# restore must match byte-for-byte, and a fresh v2 must round-trip through the
# new locations. Proves edit repoints both provider types on the live
# push/pull path — independent of the location map still in the shard headers.

SCENARIO_NAME="provider edit: relocate local+FTP (encrypted)"
SCENARIO_DESC="2L+1F 2/1 encrypted; edit local + FTP --path to moved storage; verify+pull+push"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs50"
  local pw="edit-e2e-pw-50"
  local newlocal="$SC_DIR/relocated-local"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L · p1 L · p2 F

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  # ── Relocate the LOCAL provider p0: move its vault dir, repoint via edit ─────
  mkdir -p "$newlocal"
  mv "${PV_LOCALDIR[0]}/$name" "$newlocal/"
  assert_file "$newlocal/$name/shard_0.bfs.1"
  run_bfs "$vault" provider edit p0 --ci --path "$(winpath "$newlocal")"
  assert_ok
  assert_out_matches 'push'   # non-secret coordinate changed → resync hint

  # ── Relocate the FTP provider p2: move its remote dir, repoint via edit ──────
  # The new connection config goes through a JSON file (the documented
  # credential-file form), not inline --path: a lone POSIX path argument like
  # "/bfs-e2e-…" would be rewritten to a Windows path by Git-Bash/MSYS before
  # the native bfs process sees it. The JSON content is not subject to that.
  local e="${PV_FTP_ENDPOINT[2]}"
  local oldremote="${PV_FTP_REMOTE[2]}"
  local newremote="${oldremote}-moved-${name}"
  local ftpjson="$SC_DIR/ftp-p2-new.json"
  ftp_rename "$e" "$oldremote" "$newremote"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s","secure":%s}\n' \
    "${FTP_HOST[$e]}" "${FTP_PORT[$e]}" "${FTP_USER[$e]}" "${FTP_PASS[$e]}" \
    "$newremote" "${FTP_SECURE[$e]}" >"$ftpjson"
  run_bfs "$vault" provider edit p2 --ci --config-file "$(winpath "$ftpjson")"
  assert_ok

  # ── Both relocated shards must be reachable at their EDITED locations ────────
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # ── Restore v1 from the relocated providers (byte-for-byte) ─────────────────
  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"

  # ── Push v2 to the new locations and round-trip it back ─────────────────────
  mutate_fixtures "$vault"
  local base2="$SC_DIR/baseline-v2.txt"
  snapshot_hashes "$vault" "$base2"
  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_health "$vault" 2 healthy
  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base2"
}
