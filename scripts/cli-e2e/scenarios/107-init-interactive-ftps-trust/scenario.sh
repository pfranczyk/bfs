# shellcheck shell=bash
# The companion of 106: when a human IS at the keyboard, `bfs init` puts an
# unknown FTPS certificate to them rather than refusing it.
#
# Where 106 covers a run that declared nobody is watching, this covers the
# ordinary one, and it closes a gap of its own: trust-on-first-use for an FTPS
# certificate is exercised today through `bfs provider add` (97) but never
# through the interactive `bfs init`, which is where most operators meet it.
#
# Worth knowing when reading both: the identity is settled here at a DIFFERENT
# point than in 106. Configuring the storage captures and pins the fingerprint
# up front, so by the time init probes every storage the pin already exists and
# the probe never has to decide anything. That is also why the decision is a
# menu with a way back rather than a yes/no - refusing an identity usually means
# "wrong address", and a typo should not cost every field already typed.
#
# The menu is answered "trust", so the fingerprint is pinned - proven by reading
# it back out of the written config and by a full SHA-256 roundtrip.
#
# local: N/A - a local directory has no server identity to establish.
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="interactive init asks before trusting an unknown FTPS certificate"
SCENARIO_DESC="interactive init with two local storages and one FTPS server carrying an unpinned self-signed cert must prompt for trust, pin the accepted fingerprint into the config, and complete a push/pull SHA-256 roundtrip"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificate"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs107"
  local ctr="bfs-e2e-${RUN_ID}-c107" vol="bfs-e2e-${RUN_ID}-v107"
  local port=2167 pmin=21370 pmax=21380
  local cert="$SC_DIR/cert.pem" key="$SC_DIR/key.pem"

  gen_selfsigned_cert "$cert" "$key" bfs-ftps-107 || _fail "could not generate the test certificate"
  local fp; fp="$(ftps_cert_fingerprint "$cert")"
  [ -n "$fp" ] || _fail "could not read the test certificate fingerprint"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$cert" "$key" \
    || _fail "could not start FTPS server on port $port"

  # Registered WITHOUT a pin: the operator is meant to meet this certificate for
  # the first time at the prompt.
  register_ftp_endpoint 127.0.0.1 "$port" bfsuser bfspass /ftp/bfsuser true
  local fe="$REG_FTP_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = the FTPS server

  # The interactive local prompt refuses a directory that does not exist yet;
  # build_pool_seq has already created both, so they can simply be typed in.
  local remote="${PV_FTP_REMOTE[2]}"
  # Provider type is a rawlist in registration order: local=1, ftp=2.
  local answers
  answers='[
    {"anchor":"Number of data copies","value":"2"},
    {"anchor":"Number of redundancy copies","value":"1"},
    {"anchor":"Provider name","value":"q0"},
    {"anchor":"Provider type","value":"1"},
    {"anchor":"Base directory path","value":"'"$(winpath "${PV_LOCALDIR[0]}")"'"},
    {"anchor":"Provider name","value":"q1"},
    {"anchor":"Provider type","value":"1"},
    {"anchor":"Base directory path","value":"'"$(winpath "${PV_LOCALDIR[1]}")"'"},
    {"anchor":"Provider name","value":"q2"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password","value":"bfspass"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Use FTPS","value":"y"},
    {"anchor":"What would you like to do?","value":"1"},
    {"anchor":"Push mode","value":"1"},
    {"anchor":"RAM limit","value":"1024"}
  ]'

  run_bfs_pty "$vault" "$answers" --lang en init "$name" --no-enc --no-compress
  assert_ok
  # Every scripted answer was consumed - so the trust prompt really rendered and
  # was really answered, rather than the run skipping past it.
  assert_out_contains "PROMPTS_FED=19/19"
  # The decision is a menu with a way back, not a yes/no - refusing an identity
  # usually means "wrong address", and losing every field typed so far would be
  # the wrong price for a typo.
  assert_out_contains "Trust this server identity"
  assert_out_contains "Go back and re-enter the connection settings"
  assert_file "$vault/.bfs/config.json"
  # Accepting at the prompt PINS the fingerprint; without that the answer would
  # buy trust for this run only and every later unattended push would refuse.
  assert_out_contains "$fp"
  if ! grep -qF "$fp" "$vault/.bfs/config.json"; then
    _fail "the accepted FTPS fingerprint was not pinned into the configuration"
  fi

  # Trust established for real: bytes make the full round trip through that server.
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  [ -n "$(ftp_sha "$fe" "${remote}/${name}/shard_2.bfs.1")" ] \
    || _fail "shard_2 missing on the FTPS server after push"

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
