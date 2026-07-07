# shellcheck shell=bash
# bfs repair migration local→FTP with --rebuild: a local provider's shard is lost
# and its role moves to a brand-new FTP provider. Reed-Solomon reconstructs the
# shard, uploads it to the new FTP provider over the network, and swaps the
# provider in the config + every manifest. The backup restores byte-for-byte from
# the migrated FTP shard.

SCENARIO_NAME="repair: migrate a lost local shard onto a new FTP provider (--rebuild)"
SCENARIO_DESC="3L 2/1; lose p2 local shard, repair migrate p2→FTP f9 --rebuild, verify+pull, manifest renamed"
REQUIRES_LOCAL=3
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs69"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"   # p0 L · p1 L · p2 L

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Lose p2's local shard, then migrate its role to a NEW FTP provider f9,
  # reconstructing the shard onto it. Pre-create f9's remote base dir (BFS
  # requires a provider's base path to exist) and pass the connection config as
  # JSON (MSYS-safe for the POSIX remote path).
  rm "$(shard_file 2 1)"
  local e=0
  local f9remote="${FTP_BASE[$e]%/}/bfs-e2e-${RUN_ID}/f9-${name}"
  local ftpjson="$SC_DIR/ftp-f9.json"
  ftp_mkdir "$e" "$f9remote"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s","secure":%s}\n' \
    "${FTP_HOST[$e]}" "${FTP_PORT[$e]}" "${FTP_USER[$e]}" "${FTP_PASS[$e]}" \
    "$f9remote" "${FTP_SECURE[$e]}" >"$ftpjson"

  run_bfs "$vault" repair --version all p2 "ftp:f9 --config-file $(winpath "$ftpjson")" --rebuild
  assert_ok
  assert_manifest_contains "$vault" 1 '"provider_id": "f9"'
  assert_manifest_contains "$vault" 1 '"provider_type": "ftp"'
  assert_manifest_absent "$vault" 1 '"provider_id": "p2"'

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
