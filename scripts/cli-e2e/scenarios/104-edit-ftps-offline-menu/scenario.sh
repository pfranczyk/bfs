# shellcheck shell=bash
# Interactive `bfs provider edit <ftps>` moving the provider to a NEW address that
# cannot be reached: the online attempt fails, so the edit drops into the offline
# certificate menu and still completes with the fingerprint the operator supplies
# from a second channel. Without the menu the only outcomes would be a hang or an
# abort - and the address the operator came to fix would stay wrong.
#
# The FTPS twin of 96-edit-ssh-offline-menu; 102 covers the other half of the
# guarantee (unchanged address, pin reused without contact).
#
# Failure injected for real: the ftpd container is killed and the new address is
# a `.invalid` host, which no resolver can answer.
#
# local: N/A - no server identity to pin. ssh: 96.
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="edit ftps offline menu: an unreachable new address still completes via a pasted fingerprint"
SCENARIO_DESC="FTPS pinned at init; kill it; interactive provider edit moves the provider to an unreachable host -> offline menu -> paste a certificate fingerprint -> exit 0, new host and pasted pin stored"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificate"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs104"
  local ctr="bfs-e2e-${RUN_ID}-c104" vol="bfs-e2e-${RUN_ID}-v104"
  local port=2163 pmin=21290 pmax=21300
  local cert="$SC_DIR/cert.pem" key="$SC_DIR/key.pem"
  local cfg="$vault/.bfs/config.json"
  local newhost="bfs-e2e-nonexistent.invalid"
  # A well-formed colon-hex SHA-256 the operator reads off the new server by hand;
  # deliberately different from the captured pin, so reusing the old one fails here.
  local pasted="AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:00:11:22:33:44:55:66:77:88:99"

  ftp_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ftp");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  gen_selfsigned_cert "$cert" "$key" bfs-ftps-104 || _fail "could not generate the test certificate"
  local fp; fp="$(ftps_cert_fingerprint "$cert")"
  [ -n "$fp" ] || _fail "could not read the certificate fingerprint"
  [ "$fp" != "$pasted" ] || _fail "the captured pin unexpectedly equals the pasted one"
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

  [ "$(ftp_cfg_field cert_fingerprint)" = "$fp" ] || _fail "init did not pin the certificate"

  # -- Kill the server for real; the new address is unresolvable anyway --------
  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"

  # -- Interactive edit moving the provider to an unreachable HOST -------------
  # Changed identity -> online attempt -> failure -> offline menu (rawlist: option 1
  # is "paste a fingerprint") -> the operator types the fingerprint by hand.
  local remote="${PV_FTP_REMOTE[2]}"
  local edit_answers
  edit_answers='[
    {"anchor":"FTP host","value":"'"$newhost"'"},
    {"anchor":"Port (default 21)","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password:","value":"bfspass"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Use FTPS (secure connection)?","value":"y"},
    {"anchor":"Choose how to set","value":"1"},
    {"anchor":"Certificate fingerprint","value":"'"$pasted"'"}
  ]'
  PTY_TIMEOUT=45000 run_bfs_pty "$vault" "$edit_answers" --lang en provider edit p2

  # The edit must COMPLETE OFFLINE after the online attempt failed.
  assert_exit 0
  # The offline menu was rendered through the real inquirer prompt.
  assert_out_contains "Could not reach"

  local fp_after host_after
  fp_after="$(ftp_cfg_field cert_fingerprint)"
  host_after="$(ftp_cfg_field host)"
  [ "$host_after" = "$newhost" ] || _fail "host not updated by the edit: expected '$newhost', got '$host_after'"
  [ "$fp_after" = "$pasted" ] || _fail "pasted fingerprint not persisted: expected '$pasted', got '$fp_after'"

  return 0
}
