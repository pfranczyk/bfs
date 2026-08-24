# shellcheck shell=bash
# `bfs init --ci` must never stop to ask a question - including the one that
# settles a storage server's identity.
#
# FTPS is the default for the FTP adapter, and BFS decides whether to trust a
# server's certificate BEFORE sending the password. With no pinned fingerprint
# and no --accept-new-cert there is nothing to decide from, so the run has to
# refuse and name the two ways out. Asking instead would put a prompt inside a
# run that declared nobody is watching it: the command hangs until the operator
# notices, and an operator who answers "yes" gets a configuration that works at
# the keyboard and refuses tomorrow from cron, because the interactive branch of
# the trust ladder pins nothing.
#
# A real terminal is what makes this worth asserting. Smoke spawns with a pipe
# and plain run_bfs redirects from /dev/null, so there the run is non-interactive
# whatever the code does; only a PTY can show that a terminal being present does
# NOT turn the run into one that asks. run_bfs_pty supplies no answers, which is
# exactly the situation `--ci` describes.
#
# Exit code is asserted exactly, not merely as "non-zero": a PTY timeout also
# leaves a non-zero code (124), and that is the very outcome being ruled out.
#
# The server is up on purpose, even though the refusal is decided from the flags
# and never reaches it (108 covers that, against a dead port). It is here for the
# second half: the advice printed by the refusal has to carry a real backup all
# the way through this server, or it is not advice.
#
# local: N/A - a local directory has no server identity to establish.
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="init --ci over FTPS refuses an unknown certificate instead of asking"
SCENARIO_DESC="init --ci against an FTPS server with no pinned fingerprint must fail fast naming --cert-fingerprint / --accept-new-cert, never prompt on a real terminal, and write no config; the advice it prints must then complete the same init"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificate"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs106"
  local ctr="bfs-e2e-${RUN_ID}-c106" vol="bfs-e2e-${RUN_ID}-v106"
  local port=2166 pmin=21350 pmax=21360
  local cert="$SC_DIR/cert.pem" key="$SC_DIR/key.pem"

  gen_selfsigned_cert "$cert" "$key" bfs-ftps-106 || _fail "could not generate the test certificate"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$cert" "$key" \
    || _fail "could not start FTPS server on port $port"

  # Registered WITHOUT a pin (no 7th argument), so build_pool_seq emits
  # `--secure true` alone - the operator has not said how to establish trust.
  register_ftp_endpoint 127.0.0.1 "$port" bfsuser bfspass /ftp/bfsuser true
  local fe="$REG_FTP_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = the FTPS server

  # A short PTY budget: the failure mode being ruled out is a wait for an answer
  # that never comes, and 90s of it would only slow the suite down.
  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_exit 1
  assert_out_contains "Conflicting instructions"
  # The prompt must be absent, not merely unanswered.
  if printf '%s' "$BFS_OUT" | grep -qF "Trust it?"; then
    _fail "init --ci asked the operator to trust the FTPS certificate instead of refusing"
  fi
  assert_no_file "$vault/.bfs/config.json"

  # The refusal names two ways out; take one and prove it finishes the same init
  # in the same state - advice that cannot be carried out is worse than none.
  local -a trusting=()
  local a
  for a in "${PROVIDER_ARGS[@]}"; do
    case "$a" in
      ftp:*) trusting+=("$a --accept-new-cert") ;;
      *) trusting+=("$a") ;;
    esac
  done

  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${trusting[@]}"
  assert_exit 0
  assert_file "$vault/.bfs/config.json"

  # Trust established for real: bytes make the full round trip through that server.
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  [ -n "$(ftp_sha "$fe" "${PV_FTP_REMOTE[2]}/${name}/shard_2.bfs.1")" ] \
    || _fail "shard_2 missing on the FTPS server after push"

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
