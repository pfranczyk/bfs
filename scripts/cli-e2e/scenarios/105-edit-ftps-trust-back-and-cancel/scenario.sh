# shellcheck shell=bash
# The certificate decision during an interactive edit has three exits, not two.
# Refusing an identity usually does not mean "I distrust this server" - it means
# "I aimed at the wrong one, and I only noticed now, at this question". With a
# yes/no decision that mistake costs the operator every field already entered:
# address, user, password, path. So the decision offers going back to them.
#
# Two phases against two REAL servers with different certificates:
#   (a) cancel  -> the edit ends, the stored config is untouched;
#   (b) go back -> the fields are collected again, the corrected address is saved.
#
# Failure injected for real: the wrong target is a second ftpd container holding
# its own self-signed certificate, not a faked answer.
#
# local: N/A - no server identity to decide about. ssh: GAP - the same three exits
# for a host key are a separate iteration.
# Docker-managed: self-provisions both ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="edit ftps trust menu: cancel leaves the config alone, going back re-collects the fields"
SCENARIO_DESC="two FTPS servers with different certificates; an edit aimed at the wrong one is first cancelled (config untouched), then repeated and taken back to the prompts, where the corrected address and a new password are saved"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificates"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs105"
  local ctrA="bfs-e2e-${RUN_ID}-c105a" volA="bfs-e2e-${RUN_ID}-v105a"
  local ctrB="bfs-e2e-${RUN_ID}-c105b" volB="bfs-e2e-${RUN_ID}-v105b"
  local portA=2164 pminA=21310 pmaxA=21320
  local portB=2165 pminB=21330 pmaxB=21340
  local certA="$SC_DIR/certA.pem" keyA="$SC_DIR/keyA.pem"
  local certB="$SC_DIR/certB.pem" keyB="$SC_DIR/keyB.pem"
  local cfg="$vault/.bfs/config.json"

  ftp_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ftp");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  # -- The intended server (A), pinned at init --------------------------------
  gen_selfsigned_cert "$certA" "$keyA" bfs-ftps-105-A || _fail "could not generate cert A"
  local fpA; fpA="$(ftps_cert_fingerprint "$certA")"
  [ -n "$fpA" ] || _fail "could not read cert A fingerprint"
  docker_volume_reset "$volA"
  docker_ftpsd_up "$ctrA" "$portA" "$pminA" "$pmaxA" "$volA" "$certA" "$keyA" \
    || _fail "could not start FTPS server A on port $portA"

  register_ftp_endpoint 127.0.0.1 "$portA" bfsuser bfspass /ftp/bfsuser true "$fpA"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = server A

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local remote="${PV_FTP_REMOTE[2]}"
  [ "$(ftp_cfg_field cert_fingerprint)" = "$fpA" ] || _fail "init did not pin cert A"
  [ "$(ftp_cfg_field password)" = "bfspass" ] || _fail "unexpected stored password before the edits"

  # -- The server the operator aims at by mistake (B), different certificate --
  # Started only now, and stopped again before the restore: the two edit phases
  # need it for one TLS handshake each, and nothing else here does, so the second
  # server is up for as short a window as the assertions allow.
  gen_selfsigned_cert "$certB" "$keyB" bfs-ftps-105-B || _fail "could not generate cert B"
  local fpB; fpB="$(ftps_cert_fingerprint "$certB")"
  [ "$fpB" != "$fpA" ] || _fail "cert B fingerprint unexpectedly equals cert A"
  docker_volume_reset "$volB"
  docker_ftpsd_up "$ctrB" "$portB" "$pminB" "$pmaxB" "$volB" "$certB" "$keyB" \
    || _fail "could not start FTPS server B on port $portB"

  # -- (a) Aim at server B, then CANCEL at the certificate decision -----------
  # Option 3 is cancel. The command must end and leave the stored config alone.
  local cancel_answers
  cancel_answers='[
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port (default 21)","value":"'"$portB"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password:","value":"never-persisted"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Use FTPS (secure connection)?","value":"y"},
    {"anchor":"What would you like to do","value":"3"}
  ]'
  PTY_TIMEOUT=45000 run_bfs_pty "$vault" "$cancel_answers" --lang en provider edit p2

  # Exactly 1, not merely non-zero: a PTY timeout exits 124, so `assert_fail`
  # alone would also accept a flow that hung waiting for an answer nobody gave.
  assert_exit 1
  # The decision has to be a menu, not a yes/no question - otherwise "3" would be
  # read as a refusal and this phase would pass for the wrong reason.
  assert_out_contains "What would you like to do"
  assert_out_contains "was not trusted"
  # Reported in the CLI's own voice, with the mark every refusal by this tool
  # carries. Without it the same sentence reaches the operator bare, the way an
  # error escaping the command does - which reads as a crash, not a decision.
  assert_out_matches "X .*was not trusted"
  [ "$(ftp_cfg_field cert_fingerprint)" = "$fpA" ] || _fail "a cancelled edit changed the pinned certificate"
  [ "$(ftp_cfg_field password)" = "bfspass" ] || _fail "a cancelled edit persisted the password"
  [ "$(ftp_cfg_field port)" = "$portA" ] || _fail "a cancelled edit persisted the wrong port"

  # -- (b) Aim at B again, then GO BACK and correct the address ---------------
  # Option 2 is go back. The second pass points at server A and supplies the
  # password the server actually accepts; the address then matches what is stored,
  # so the pin is reused without contact.
  #
  # The stored password is spoiled first, so that seeing `bfspass` afterwards can
  # only mean the SECOND pass reached the config. Without this the phase would
  # pass for an edit that aborted and changed nothing, because everything else it
  # asserts already holds beforehand.
  # Through a JSON config file rather than inline flags: Git Bash rewrites a bare
  # `/ftp/...` argument into a Windows path, which the adapter then rejects as not
  # absolute. Values inside the file are never touched.
  local spoil="$SC_DIR/spoil.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"spoiled-before-the-edit","path":"%s","secure":true,"cert_fingerprint":"%s"}\n' \
    "$portA" "$remote" "$fpA" > "$spoil"
  run_bfs "$vault" provider edit p2 --ci --config-file "$(winpath "$spoil")"
  assert_ok
  [ "$(ftp_cfg_field password)" = "spoiled-before-the-edit" ] || _fail "could not spoil the stored password"

  local newpw="bfspass"
  local back_answers
  back_answers='[
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port (default 21)","value":"'"$portB"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password:","value":"typed-at-the-wrong-server"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Use FTPS (secure connection)?","value":"y"},
    {"anchor":"What would you like to do","value":"2"},
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port (default 21)","value":"'"$portA"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password:","value":"'"$newpw"'"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Use FTPS (secure connection)?","value":"y"}
  ]'
  PTY_TIMEOUT=60000 run_bfs_pty "$vault" "$back_answers" --lang en provider edit p2

  assert_exit 0
  local fp_after pw_after port_after
  fp_after="$(ftp_cfg_field cert_fingerprint)"
  pw_after="$(ftp_cfg_field password)"
  port_after="$(ftp_cfg_field port)"
  [ "$port_after" = "$portA" ] || _fail "the corrected address was not saved: port '$port_after', expected '$portA'"
  [ "$pw_after" = "$newpw" ] || _fail "the second pass did not reach the config: password '$pw_after', expected '$newpw'"
  [ "$fp_after" = "$fpA" ] || _fail "going back disturbed the pinned certificate: '$fpA' -> '$fp_after'"

  # Server B has done its job; take it down so the restore runs against a single
  # ftpd, the way every other scenario in this pool does.
  docker_ftpd_down "$ctrB"
  docker_volume_rm "$volB"

  # The corrected config has to actually work, not merely look right. One local
  # part is removed, so reconstruction cannot avoid the FTPS server - a restore
  # that still succeeds proves the address, the password and the pin all landed
  # correctly. With both local parts present this would pass on any config at all.
  rm -f "$(shard_file 0 1)"
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_ftpd_down "$ctrA"
  docker_ftpd_down "$ctrB"
  docker_volume_rm "$volA"
  docker_volume_rm "$volB"
  return 0
}
