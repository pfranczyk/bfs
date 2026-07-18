# shellcheck shell=bash
# REAL SSH server address change, data intact. The sshd holding shard_2 is
# stopped and restarted on a NEW port, its data preserved in a named volume (a
# genuine "the box moved to a new address" — not a faked failure). `bfs repair`
# repoints the provider to the new port WITHOUT --rebuild: the shard is still
# there, so repair only rewrites config + the location map in every shard's
# header. The before/after hash proves the payload was not re-uploaded, and the
# no-rebuild repair only succeeds because the data genuinely persisted.
#
# Docker-managed: self-provisions its sshd (no --ssh needed) so the lifecycle is
# deterministic on CI. SKIPs when no Docker daemon is available.

SCENARIO_NAME="repair: real SSH address (port) change, data intact"
SCENARIO_DESC="sshd on a volume; restart on a NEW port (same data), repair --config-file (no rebuild), prove no re-upload"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs85"
  local ctr="bfs-e2e-${RUN_ID}-c85" vol="bfs-e2e-${RUN_ID}-v85"
  local port_a=2311 port_b=2312

  # Provision an sshd on port_a backed by a fresh named volume (data outside the
  # container, so it survives the restart below).
  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port_a" "$vol" || _fail "could not start sshd on port $port_a"
  register_ssh_endpoint 127.0.0.1 "$port_a" bfsuser bfspass /config
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
  local before
  before="$(ssh_sha "$se" "$sshshard")"
  [ -n "$before" ] || _fail "could not read shard body before the address change"

  # ── The server moves: restart on port_b, SAME volume (data persists) ────────
  docker_sshd_down "$ctr"
  docker_sshd_up "$ctr" "$port_b" "$vol" || _fail "could not restart sshd on port $port_b"
  set_ssh_endpoint_port "$se" "$port_b"

  # The stored coordinate (port_a) is now dead → verify sees the provider down.
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Repair repoints p2 to port_b. Data is intact, so NO --rebuild: repair rewrites
  # config + the location map in every shard's header (--ci + --accept-new-host-key
  # so the new host:port is trusted non-interactively).
  local sshjson="$SC_DIR/ssh-p2.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"bfspass","path":"%s"}\n' \
    "$port_b" "${PV_SSH_REMOTE[2]}" >"$sshjson"
  run_bfs "$vault" repair --ci --version all p2 "--config-file $(winpath "$sshjson") --accept-new-host-key"
  assert_ok

  # Payload not re-uploaded — the shard on port_b is byte-identical to before.
  local after
  after="$(ssh_sha "$se" "$sshshard")"
  [ "$after" = "$before" ] || _fail "shard body changed after address-change repair (unexpected re-upload): $before -> $after"

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
