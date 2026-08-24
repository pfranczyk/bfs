# shellcheck shell=bash
# Interactive `bfs provider edit <ftps>` honours the offline-edit guarantee: a
# password rotation on an UNCHANGED address succeeds even when the FTPS server is
# DOWN. The command writes nothing but `.bfs/config.json`, and the server
# identity did not move, so nothing here needs the medium to answer.
#
# This is the FTPS twin of 95-edit-ssh-offline; the pair is the A/B control that
# the offline guarantee is a BFS property, not an SSH quirk.
#
# Failure injected for real: the ftpd container is KILLED and its volume
# removed - not a directory swap on a live server.
#
# local/ssh: N/A here - the SSH twin is 95, the local twin is 103.
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="edit ftps offline: password rotation on an unchanged address succeeds with the server down"
SCENARIO_DESC="FTPS pinned to a self-signed cert at init; kill the server; interactive provider edit rotates ONLY the password -> exit 0 offline, cert_fingerprint preserved"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificate"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs102"
  local ctr="bfs-e2e-${RUN_ID}-c102" vol="bfs-e2e-${RUN_ID}-v102"
  local port=2162 pmin=21270 pmax=21280
  local cert="$SC_DIR/cert.pem" key="$SC_DIR/key.pem"
  local cfg="$vault/.bfs/config.json"

  ftp_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ftp");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  gen_selfsigned_cert "$cert" "$key" bfs-ftps-102 || _fail "could not generate the test certificate"
  local fp; fp="$(ftps_cert_fingerprint "$cert")"
  [ -n "$fp" ] || _fail "could not read the certificate fingerprint"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$cert" "$key" \
    || _fail "could not start FTPS server on port $port"

  register_ftp_endpoint 127.0.0.1 "$port" bfsuser bfspass /ftp/bfsuser true "$fp"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = the FTPS server

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local fp_before pw_before
  fp_before="$(ftp_cfg_field cert_fingerprint)"
  pw_before="$(ftp_cfg_field password)"
  [ "$fp_before" = "$fp" ] || _fail "init did not pin the certificate: expected '$fp', stored '$fp_before'"
  [ "$pw_before" = "bfspass" ] || _fail "unexpected stored password before edit: '$pw_before'"

  # -- Kill the server for real: the medium is now unreachable -----------------
  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"

  # -- Interactive edit rotating ONLY the password, host and port unchanged ----
  local newpw="rotated-${RUN_ID}"
  local remote="${PV_FTP_REMOTE[2]}"
  local edit_answers
  edit_answers='[
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port (default 21)","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password:","value":"'"$newpw"'"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Use FTPS (secure connection)?","value":"y"}
  ]'
  PTY_TIMEOUT=45000 run_bfs_pty "$vault" "$edit_answers" --lang en provider edit p2

  # The edit must COMPLETE OFFLINE - not hang, not fail on the dead server.
  assert_exit 0

  local fp_after pw_after
  fp_after="$(ftp_cfg_field cert_fingerprint)"
  pw_after="$(ftp_cfg_field password)"
  [ "$pw_after" = "$newpw" ] || _fail "password not rotated by the offline edit: expected '$newpw', got '$pw_after'"
  [ "$fp_after" = "$fp_before" ] || _fail "cert_fingerprint changed across an offline password edit: '$fp_before' -> '$fp_after'"

  return 0
}
