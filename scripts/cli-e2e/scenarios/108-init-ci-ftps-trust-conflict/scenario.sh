# shellcheck shell=bash
# Two instructions that cannot both hold are answered from the flags alone,
# before anything leaves the machine.
#
# `--ci` says "do not ask me". FTPS is the adapter's default, and trust in a
# server's certificate has to come from somewhere: a fingerprint pinned up
# front, an opt-in to the one presented on first connect, or a human at the
# prompt. A run that states nobody is watching and gives neither flag has asked
# for both at once - and that is decidable without a socket.
#
# The proof that it IS decided without a socket: this scenario points the
# storage at a port where nothing listens. A refusal coming from the connection
# attempt announces itself - the transport names the host and the reason. So the
# run must refuse naming the conflict and the ways out, and say nothing about
# reaching a server, because it never tried. (Locally the refused connect is
# instant; against a host that simply does not answer it is the adapter's whole
# connect timeout, which is what this saves in the field.)
#
# Companion to 106, which covers the same refusal against a server that IS
# there, driven through a real terminal. This one needs no server at all, so it
# runs local-only and costs nothing.
#
# local: N/A as a storage - the conflict is specific to a server identity.

SCENARIO_NAME="init --ci refuses conflicting instructions before opening a socket"
SCENARIO_DESC="an FTPS storage with no pinned fingerprint and no --accept-new-cert, pointed at a dead port: init --ci must refuse from the flags alone, naming the ways out, without attempting or reporting a connection, and write no config"
REQUIRES_LOCAL=2
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs108"
  # Nothing listens here. Reaching it would cost the adapter's connect timeout.
  local deadport=2199

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local   # two real local storages

  run_bfs "$vault" --lang en init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ftp:nas --host 127.0.0.1 --port ${deadport} --user u --password p --path /backup"
  assert_exit 1

  # The refusal names the conflict and leaves the operator with both flags that
  # resolve it - advice that cannot be carried out is worse than none.
  assert_out_contains "--cert-fingerprint"
  assert_out_contains "--accept-new-cert"

  # ...and it never talks about the transport, because it never touched it. This
  # is the message the run prints today, so it is the one that has to disappear.
  if printf '%s' "$BFS_OUT" | grep -qF "FTP operation failed"; then
    _fail "init --ci reached the FTP transport: the conflict was decided at connect time, not from the flags"
  fi

  assert_no_file "$vault/.bfs/config.json"

  # Positive control: the same command with one of the named flags completes,
  # so the refusal is about the missing instruction and not about the storage.
  # The dead port still refuses - but now at the connection, which is the honest
  # reason and a different message.
  run_bfs "$vault" --lang en init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ftp:nas --host 127.0.0.1 --port ${deadport} --user u --password p --path /backup --accept-new-cert"
  assert_fail
  # It must fail for the honest reason - the port really is dead - and not for
  # some third cause that would make the mirror assertion below vacuous.
  assert_out_contains "FTP operation failed"
  # Mirror of the first run's positive assertion: what it required to be present
  # must now be absent, or the flag changed nothing.
  if printf '%s' "$BFS_OUT" | grep -qF -- "--cert-fingerprint"; then
    _fail "the trust conflict was still reported after --accept-new-cert was supplied"
  fi

  return 0
}
