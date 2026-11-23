# shellcheck shell=bash
# SSH twin of 108: an unattended run that gives no basis for trusting the
# server's host key is refused from the settings alone, before a socket opens.
#
# `--ci` says "do not ask me". An SSH host key has to be trusted from somewhere:
# a fingerprint pinned up front (--known-host), an opt-in to the key presented
# on first connect (--accept-new-host-key), an entry for host:port in the
# operator's ~/.ssh/known_hosts, or a human at the prompt. The scenario points
# HOME at an empty directory, so known_hosts holds nothing for this host - the
# run names none of the four, and that is decidable without a connection.
#
# The proof that it IS decided without a connection: the storage points at a
# port where nothing listens. A refusal coming from a connection attempt
# announces itself through the transport message, so that message must be
# absent while both ways out are named, and no configuration is written.
#
# Companion to 125, which covers the same refusal next to a live sshd and
# carries the advice through to a backup that lands on the server. This one
# needs no server, so it runs local-only.
#
# local/ftp: N/A as a storage - the conflict is specific to an SSH host key
# (FTPS has its own twin, 108).

SCENARIO_NAME="init --ci over SSH refuses a missing host-key trust basis before opening a socket"
SCENARIO_DESC="an SSH storage with no --known-host, no --accept-new-host-key and no known_hosts entry, pointed at a dead port: init --ci must refuse from the settings alone, naming both ways out, without attempting or reporting a connection, and write no config"
REQUIRES_LOCAL=2
REQUIRES_SSH=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs149"
  # Nothing listens here. Reaching it would cost the adapter's connect timeout.
  local deadport=2353
  local home="$SC_DIR/home"
  mkdir -p "$home/.ssh"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local   # two real local storages

  # HOME/USERPROFILE point at an empty home, so the operator's own known_hosts
  # cannot supply a trust basis for 127.0.0.1:2353 by accident.
  HOME="$home" USERPROFILE="$(winpath "$home")" run_bfs "$vault" --lang en init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ssh:p2 --host 127.0.0.1 --port ${deadport} --user u --password p --path /backup"
  assert_exit 1

  assert_out_contains "127.0.0.1:${deadport}"
  assert_out_contains "--accept-new-host-key"
  assert_out_contains "--known-host"

  # ...and it never talks about the transport, because it never touched it.
  if printf '%s' "$BFS_OUT" | grep -qF "SSH operation failed"; then
    _fail "init --ci reached the SSH transport: the missing trust basis was decided at connect time, not from the settings"
  fi

  assert_no_file "$vault/.bfs/config.json"

  # Positive control: the same command with one of the named flags gets past
  # the guard and fails only at the connection that reads the key to pin -
  # the honest reason, since the port really is dead.
  HOME="$home" USERPROFILE="$(winpath "$home")" run_bfs "$vault" --lang en init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ssh:p2 --host 127.0.0.1 --port ${deadport} --user u --password p --path /backup --accept-new-host-key"
  assert_fail
  assert_out_contains "SSH operation failed"
  if printf '%s' "$BFS_OUT" | grep -qF -- "--known-host"; then
    _fail "the missing trust basis was still reported after --accept-new-host-key was supplied"
  fi

  return 0
}
