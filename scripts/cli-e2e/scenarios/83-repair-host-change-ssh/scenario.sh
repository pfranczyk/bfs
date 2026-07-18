# shellcheck shell=bash
# bfs repair on an SSH provider whose HOST address drifted: the stored host no
# longer reaches the server (e.g. the box moved / a new port). `bfs verify` sees
# the provider as unreachable (degraded); `bfs repair --config-file` rewrites the
# connection config to a reachable host and the backup is healthy again. Proves
# repair repoints the SSH host end-to-end while leaving the shard body untouched:
# a host-change is a config edit (relocateProvider), so it only rewrites config +
# the header sidecar, never re-uploads the payload — the before/after hash of the
# shard file confirms the bytes did not change.

SCENARIO_NAME="repair: SSH host address change"
SCENARIO_DESC="2L+1S 2/1; break the SSH host in config (degraded), repair --config-file to a reachable host, prove no re-upload, verify+pull"
REQUIRES_LOCAL=2
REQUIRES_SSH=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs83"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p0 L · p1 L · p2 S

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Snapshot the remote shard file hash BEFORE repair, to confirm repair repoints
  # the host without changing the shard body (host-change is a config edit only).
  local e="${PV_SSH_ENDPOINT[2]}"
  local sshshard="${PV_SSH_REMOTE[2]}/${name}/shard_2.bfs.1"
  local before
  before="$(ssh_sha "$e" "$sshshard")"
  [ -n "$before" ] || _fail "could not read shard payload hash before repair"

  # Simulate a host-address change: point p2 at a non-resolving host so the stored
  # coordinate no longer reaches the server. `bfs verify` must see it as down.
  node -e 'const fs=require("node:fs");const f=process.argv[1];const c=JSON.parse(fs.readFileSync(f,"utf8"));for(const p of c.providers)if(p.type==="ssh")p.config.host="bfs-no-such-host.invalid";fs.writeFileSync(f,JSON.stringify(c,null,2));' "$vault/.bfs/config.json"
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Repair p2 to a reachable host. The endpoint is local, so use the other
  # spelling (127.0.0.1 <-> localhost) — the host string genuinely changes while
  # still reaching the same server. --accept-new-host-key TOFU-accepts the new
  # host string (its known_hosts entry is not yet pinned).
  local host="${SSH_HOST[$e]}"
  local newhost="$host"
  if [ "$host" = "127.0.0.1" ]; then
    newhost="localhost"
  elif [ "$host" = "localhost" ]; then
    newhost="127.0.0.1"
  fi
  local sshjson="$SC_DIR/ssh-p2-host.json"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s"}\n' \
    "$newhost" "${SSH_PORT[$e]}" "${SSH_USER[$e]}" "${SSH_PASS[$e]}" \
    "${PV_SSH_REMOTE[2]}" >"$sshjson"

  # --ci makes repair non-interactive so --accept-new-host-key is honoured (in
  # interactive mode SSH always TOFU-prompts for a new host key). This is how a
  # real operator runs an unattended SSH host-change, mirroring init/push --ci.
  run_bfs "$vault" repair --ci --version all p2 "--config-file $(winpath "$sshjson") --accept-new-host-key"
  assert_ok

  # Payload untouched (no re-upload) and the header sidecar landed remotely.
  local after
  after="$(ssh_sha "$e" "$sshshard")"
  [ "$after" = "$before" ] || _fail "shard body changed after host-change repair (unexpected re-upload): $before -> $after"
  ssh_sha "$e" "${PV_SSH_REMOTE[2]}/${name}/hdr_2.bfs.1" >/dev/null || _fail "header sidecar hdr_2.bfs.1 missing after repair"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Wipe the working tree (keep .bfs/) so the restore is a genuine reconstruction
  # over the repointed provider, not a no-op over still-intact files.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
