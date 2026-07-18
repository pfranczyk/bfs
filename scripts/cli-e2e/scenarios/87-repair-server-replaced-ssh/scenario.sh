# shellcheck shell=bash
# REAL server replacement: the sshd holding shard_2 dies for good (container AND
# volume destroyed), and a brand-new EMPTY sshd is stood up on a different port.
# The operator migrates the shard onto the new box with `bfs repair --rebuild`,
# which must Reed-Solomon-reconstruct shard_2 and upload it to the new location.
#
# Exercises the MIGRATION rebuild path (commitMigrationPairs → rebuildVersion,
# new provider id on a new address) — distinct from 86's in-place same-id rebuild
# (rebuildShardInPlace). The new box is empty, so the target base directory does
# not exist — the same condition that breaks 86; this checks whether the
# migration path has the same gap.
#
# Docker-managed; SKIPs without a Docker daemon.

SCENARIO_NAME="repair --rebuild: SSH server replaced, new location"
SCENARIO_DESC="old sshd+volume destroyed; migrate p2→s9 onto a new EMPTY sshd with repair --rebuild"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs87"
  local ctr_a="bfs-e2e-${RUN_ID}-c87a" vol_a="bfs-e2e-${RUN_ID}-v87a"
  local ctr_b="bfs-e2e-${RUN_ID}-c87b" vol_b="bfs-e2e-${RUN_ID}-v87b"
  local port_a=2321 port_b=2322

  docker_volume_reset "$vol_a"
  docker_sshd_up "$ctr_a" "$port_a" "$vol_a" || _fail "could not start original sshd on port $port_a"
  register_ssh_endpoint 127.0.0.1 "$port_a" bfsuser bfspass /config
  local se_a="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the original sshd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # ── The server dies for good; a NEW empty box comes up on a new port ────────
  docker_sshd_down "$ctr_a"
  docker_volume_rm "$vol_a"
  docker_volume_reset "$vol_b"
  docker_sshd_up "$ctr_b" "$port_b" "$vol_b" || _fail "could not start replacement sshd on port $port_b"
  register_ssh_endpoint 127.0.0.1 "$port_b" bfsuser bfspass /config
  local se_b="$REG_SSH_INDEX"

  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Migrate p2 → s9 onto the new box and rebuild the lost shard there. The new box
  # is EMPTY: its base directory does not exist yet.
  local s9remote="/config/bfs-e2e-${RUN_ID}/s9-${name}"
  local sshjson="$SC_DIR/ssh-s9.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"bfspass","path":"%s"}\n' \
    "$port_b" "$s9remote" >"$sshjson"
  run_bfs "$vault" repair --ci --version all p2 "ssh:s9 --config-file $(winpath "$sshjson") --accept-new-host-key" --rebuild
  assert_ok
  assert_manifest_contains "$vault" 1 '"provider_id": "s9"'
  assert_manifest_contains "$vault" 1 '"provider_type": "ssh"'
  assert_manifest_absent "$vault" 1 '"provider_id": "p2"'

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctr_b"
  docker_volume_rm "$vol_b"
  return 0
}
