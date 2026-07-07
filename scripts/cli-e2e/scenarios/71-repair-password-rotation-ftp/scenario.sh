# shellcheck shell=bash
# bfs repair on an FTP provider whose stored PASSWORD drifted: the account
# password was rotated on the server, so the saved credential no longer
# authenticates. `bfs verify` sees the provider as unreachable (auth failure →
# degraded); `bfs repair` rewrites the connection config with the current
# password and the backup is healthy again, restoring byte-for-byte.

SCENARIO_NAME="repair: FTP password rotation"
SCENARIO_DESC="2L+1F 2/1; stale FTP password in config (degraded), repair --config-file with the current password, verify+pull"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs71"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L · p1 L · p2 F

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Simulate a rotated server password: the stored credential is now stale, so p2
  # no longer authenticates. `bfs verify` must see it as down.
  node -e 'const fs=require("node:fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));for(const p of c.providers)if(p.type==="ftp")p.config.password="stale-"+p.config.password;fs.writeFileSync(f,JSON.stringify(c,null,2));' "$vault/.bfs/config.json"
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Repair p2 with the current (correct) password.
  local e="${PV_FTP_ENDPOINT[2]}"
  local ftpjson="$SC_DIR/ftp-p2-pw.json"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s","secure":%s}\n' \
    "${FTP_HOST[$e]}" "${FTP_PORT[$e]}" "${FTP_USER[$e]}" "${FTP_PASS[$e]}" \
    "${PV_FTP_REMOTE[2]}" "${FTP_SECURE[$e]}" >"$ftpjson"

  run_bfs "$vault" repair --version all p2 "--config-file $(winpath "$ftpjson")"
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
