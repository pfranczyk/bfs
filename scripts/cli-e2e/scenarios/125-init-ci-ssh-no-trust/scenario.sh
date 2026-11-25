# shellcheck shell=bash
# `bfs init --ci` must never stop to ask a question - including the one that
# settles an SSH server's host-key identity. `--ci` forces
# `createCliProviderIO(rootDir, false)` (src/cli/commands/init.ts), so
# `interactive=false` regardless of whether a terminal is attached, and
# `confirm()` under that flag returns false without prompting
# (src/providers/provider.ts) - there is no prompt code path left for a PTY to
# race against here. So this scenario proves the CONTENT of the refusal with
# plain run_bfs, not run_bfs_pty.
#
# SSH trust is decided from the settings: a pin (--known-host), an opt-in
# (--accept-new-host-key) or an entry for host:port in ~/.ssh/known_hosts. The
# adapter refuses while it parses the flags when none of them is there, so the
# refusal comes before any storage is probed or recorded. The scenario points
# HOME at an empty directory so the operator's own known_hosts cannot supply
# that entry by accident.
#
# The server is up on purpose, unlike the dead-port twin 149: the refusal must
# not come from the connection even when one would succeed, and the advice has
# to complete a real backup through this same server, verified on the server
# itself (not just via a roundtrip the other two, local shards could satisfy
# alone under this 2/1 scheme).
#
# local/ftp: N/A - host-key TOFU is SSH-specific.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="init --ci over SSH refuses a missing host-key trust basis next to a live server"
SCENARIO_DESC="init --ci against a real sshd with no pin, no --accept-new-host-key and no known_hosts entry must refuse from the settings, naming both --accept-new-host-key and --known-host, without reaching the transport or writing config; the advice must then complete the same init and land shard_2 on the server"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs125"
  local ctr="bfs-e2e-${RUN_ID}-c125" vol="bfs-e2e-${RUN_ID}-v125"
  local port=2350
  local home="$SC_DIR/home"
  mkdir -p "$home/.ssh"

  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" "$DOCKER_SSH_USER" "$DOCKER_SSH_PASS" "$DOCKER_SSH_BASE"
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local   # p0, p1 - p2 (ssh) is added manually below

  # Manual --provider string (not build_pool_seq's ssh branch, which always
  # appends --accept-new-host-key): first contact, no pin, no opt-in, no
  # known_hosts entry - a run that names no basis for trusting the host key.
  HOME="$home" USERPROFILE="$(winpath "$home")" run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ssh:p2 --host 127.0.0.1 --port ${port} --user ${DOCKER_SSH_USER} --password ${DOCKER_SSH_PASS} --path ${DOCKER_SSH_BASE}"
  assert_exit 1
  assert_out_contains "127.0.0.1:${port}"
  assert_out_contains "--accept-new-host-key"
  assert_out_contains "--known-host"
  # Decided from the settings, so the live server was never asked and nothing
  # was recorded - not even the two local storages listed before it.
  if printf '%s' "$BFS_OUT" | grep -qF "SSH operation failed"; then
    _fail "init --ci reached the SSH transport: the missing trust basis was decided at connect time, not from the settings"
  fi
  assert_no_file "$vault/.bfs/config.json"

  # Positive control: the same command with one of the named flags completes,
  # so the refusal is about the missing trust decision and not about the server.
  HOME="$home" USERPROFILE="$(winpath "$home")" run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ssh:p2 --host 127.0.0.1 --port ${port} --user ${DOCKER_SSH_USER} --password ${DOCKER_SSH_PASS} --path ${DOCKER_SSH_BASE} --accept-new-host-key"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  # A 2/1 scheme with two LOCAL data shards would restore fine even if shard_2
  # never reached the server - so the roundtrip below cannot by itself prove
  # the advice carried anything through this sshd. Check the server directly.
  [ -n "$(ssh_sha "$se" "${DOCKER_SSH_BASE}/${name}/shard_2.bfs.1")" ] \
    || _fail "shard_2 missing on the SSH server after push"

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
