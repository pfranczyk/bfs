# shellcheck shell=bash
# bfs repair on an FTP provider whose HOST address drifted: the stored host no
# longer reaches the server (e.g. the NAS moved to a new address). `bfs verify`
# sees the provider as unreachable (degraded); `bfs repair` rewrites the
# connection config to a reachable host and the backup is healthy again,
# restoring byte-for-byte. Proves repair repoints the FTP host end-to-end.

SCENARIO_NAME="repair: FTP host address change"
SCENARIO_DESC="2L+1F 2/1; break the FTP host in config (degraded), repair --config-file to a reachable host, verify+pull"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs70"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L · p1 L · p2 F

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Simulate a host-address change: point p2 at a non-resolving host so the stored
  # coordinate no longer reaches the server. `bfs verify` must see it as down.
  node -e 'const fs=require("node:fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));for(const p of c.providers)if(p.type==="ftp")p.config.host="bfs-no-such-host.invalid";fs.writeFileSync(f,JSON.stringify(c,null,2));' "$vault/.bfs/config.json"
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Repair p2 to a reachable host. Where the endpoint is local, use the other
  # spelling (127.0.0.1 <-> localhost) so the host string genuinely changes while
  # still reaching the same server; otherwise the original host is reachable.
  local e="${PV_FTP_ENDPOINT[2]}"
  local host="${FTP_HOST[$e]}"
  local newhost="$host"
  if [ "$host" = "127.0.0.1" ]; then
    newhost="localhost"
  elif [ "$host" = "localhost" ]; then
    newhost="127.0.0.1"
  fi
  local ftpjson="$SC_DIR/ftp-p2-host.json"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s","secure":%s}\n' \
    "$newhost" "${FTP_PORT[$e]}" "${FTP_USER[$e]}" "${FTP_PASS[$e]}" \
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
