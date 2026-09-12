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
# This closes only the message-content half of the SSH coverage gap - not the
# "real terminal, never prompts" half, which stays open pending a PTY-driven
# companion answering whether SSH trust can also be decided from settings
# alone, the way FTPS's ftp_cert_trust_conflict already is.
#
# Unlike FTPS, SSH trust is not decidable from the flags alone:
# `knownHostsLookup` reads ~/.ssh/known_hosts, so a missing --known-host does
# not by itself mean "no trust source" - the refusal has to come from the
# CONNECTION attempt, once decideHostKeyTrust reaches its non-interactive TOFU
# branch with no pin, no --accept-new-host-key, and no known_hosts entry.
#
# That branch returns false and, ahead of it, warns naming both ways out
# (mirroring the existing @revoked case) - it does NOT stop withClient from
# also turning the declined key into a generic `ssh_operation_failed`, so this
# scenario pins the presence of the named flags, not the absence of that
# generic message.
#
# The server is up on purpose: the refusal is decided at connect time (unlike
# FTPS's from-the-flags refusal in 108), so it has to actually reach the
# medium to reproduce. It also carries the second half - the advice has to
# complete a real backup through this same server, verified on the server
# itself (not just via a roundtrip the other two, local shards could satisfy
# alone under this 2/1 scheme).
#
# local/ftp: N/A - host-key TOFU is SSH-specific.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="init --ci over SSH refuses first-contact TOFU naming the ways out"
SCENARIO_DESC="init --ci against a real sshd with no pin, no --accept-new-host-key and no known_hosts entry must refuse naming both --accept-new-host-key and --known-host; the advice must then complete the same init and land shard_2 on the server"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs125"
  local ctr="bfs-e2e-${RUN_ID}-c125" vol="bfs-e2e-${RUN_ID}-v125"
  local port=2350

  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" "$DOCKER_SSH_USER" "$DOCKER_SSH_PASS" "$DOCKER_SSH_BASE"
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local   # p0, p1 - p2 (ssh) is added manually below

  # Manual --provider string (not build_pool_seq's ssh branch, which always
  # appends --accept-new-host-key): first contact, no pin, no opt-in, no
  # known_hosts entry - the exact state decideHostKeyTrust's non-interactive
  # TOFU branch refuses.
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ssh:p2 --host 127.0.0.1 --port ${port} --user ${DOCKER_SSH_USER} --password ${DOCKER_SSH_PASS} --path ${DOCKER_SSH_BASE}"
  assert_exit 1
  assert_out_contains "--accept-new-host-key"
  assert_out_contains "--known-host"
  assert_no_file "$vault/.bfs/config.json"

  # Positive control: the same command with one of the named flags completes,
  # so the refusal is about the missing trust decision and not about the server.
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
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
