# shellcheck shell=bash
# REAL disk failure at the SAME location. The sshd holding shard_2 is killed and
# its data volume WIPED (data gone, fresh host keys), then restarted on the SAME
# port. Host and port are unchanged, but the shard is gone — so `bfs repair
# --rebuild` must Reed-Solomon-reconstruct shard_2 from the survivors and
# re-upload it to the original location. Distinct from an address change: here
# the data is genuinely lost, not merely moved.
#
# Docker-managed: self-provisions its sshd so the failure is a real container +
# volume lifecycle, deterministic on CI. SKIPs without a Docker daemon.

SCENARIO_NAME="repair --rebuild: SSH disk failure, same location"
SCENARIO_DESC="sshd data volume wiped in place; repair --rebuild reconstructs shard_2 to the same host:port"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs86"
  local ctr="bfs-e2e-${RUN_ID}-c86" vol="bfs-e2e-${RUN_ID}-v86"
  local port=2313

  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" bfsuser bfspass /config
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the managed sshd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local sshshard="${PV_SSH_REMOTE[2]}/${name}/shard_2.bfs.1"
  [ -n "$(ssh_sha "$se" "$sshshard")" ] || _fail "shard_2 missing on the server after push"

  # ── Disk failure: same host:port, data GONE (volume wiped → fresh host keys) ──
  docker_sshd_down "$ctr"
  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not restart sshd after disk wipe"

  # The shard is gone from the server.
  if ssh_sha "$se" "$sshshard" >/dev/null 2>&1; then
    _fail "shard_2 unexpectedly still present after the disk wipe"
  fi
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Repair rebuilds shard_2 from parity and re-uploads it to the SAME location.
  # --rebuild because the payload is gone; --accept-new-host-key because the wiped
  # box came back with a new host key.
  local sshjson="$SC_DIR/ssh-p2.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"bfspass","path":"%s"}\n' \
    "$port" "${PV_SSH_REMOTE[2]}" >"$sshjson"
  run_bfs "$vault" repair --ci --version all p2 "--config-file $(winpath "$sshjson") --accept-new-host-key" --rebuild
  assert_ok

  # Shard is back at the original location.
  [ -n "$(ssh_sha "$se" "$sshshard")" ] || _fail "shard_2 was not rebuilt at the original location"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
