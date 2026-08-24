# shellcheck shell=bash
# `bfs provider edit` on an FTPS provider must not become the moment an impostor
# gets pinned. SECURITY.md promises that a server presenting an identity OTHER
# than the pinned one is refused, not silently adopted - the pin is the only
# thing standing between the operator's password and a MITM, because the
# certificate decision runs BEFORE login.
#
# The edit here is the routine one: the operator rotates the password, host and
# port untouched. Meanwhile an impostor sits at that same address with a fresh
# certificate B. Whatever the edit does about the medium, the stored pin must
# still name certificate A afterwards.
#
# Failure injected for real: the genuine ftpd container is killed and a second
# one, holding a different self-signed certificate, is started on the same
# published port - not a directory swap on a live server.
#
# local: N/A - there is no server identity to pin. ssh: GAP - the same property
# for a host key is pinned only at unit level (`configureInteractiveForEdit` in
# tests/providers/ssh.test.ts), with no e2e twin.
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="edit ftps cert pin: a routine password edit must not re-pin an impostor's certificate"
SCENARIO_DESC="FTPS pinned to self-signed cert A at init; the box is replaced by an impostor presenting cert B on the same address; interactive provider edit rotates ONLY the password -> stored cert_fingerprint must still be cert A"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificates"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs101"
  local ctr="bfs-e2e-${RUN_ID}-c101" vol="bfs-e2e-${RUN_ID}-v101"
  local port=2161 pmin=21250 pmax=21260
  local certA="$SC_DIR/certA.pem" keyA="$SC_DIR/keyA.pem"
  local certB="$SC_DIR/certB.pem" keyB="$SC_DIR/keyB.pem"
  local cfg="$vault/.bfs/config.json"

  # Reads a field of the (single) FTP provider's connection config from config.json.
  ftp_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ftp");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  # -- Genuine FTPS server presenting self-signed cert A, pinned at init -------
  gen_selfsigned_cert "$certA" "$keyA" bfs-ftps-101-A || _fail "could not generate cert A"
  local fpA; fpA="$(ftps_cert_fingerprint "$certA")"
  [ -n "$fpA" ] || _fail "could not read cert A fingerprint"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$certA" "$keyA" \
    || _fail "could not start FTPS server on port $port"

  register_ftp_endpoint 127.0.0.1 "$port" bfsuser bfspass /ftp/bfsuser true "$fpA"

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
  [ "$fp_before" = "$fpA" ] || _fail "init did not pin cert A: expected '$fpA', stored '$fp_before'"
  [ "$pw_before" = "bfspass" ] || _fail "unexpected stored password before edit: '$pw_before'"

  # -- MITM: an impostor takes the same address with a DIFFERENT certificate ---
  gen_selfsigned_cert "$certB" "$keyB" bfs-ftps-101-B || _fail "could not generate cert B"
  local fpB; fpB="$(ftps_cert_fingerprint "$certB")"
  [ "$fpB" != "$fpA" ] || _fail "cert B fingerprint unexpectedly equals cert A"
  docker_ftpd_down "$ctr"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$certB" "$keyB" \
    || _fail "could not start impostor FTPS server on port $port"

  # -- Routine interactive edit: password rotation, host and port unchanged ----
  # Prompt order mirrors the add flow (host / port / user / password / base path /
  # FTPS?). The trailing answer accepts whatever identity decision appears - an
  # operator mid-rotation says yes to the prompt in front of them; that is exactly
  # why the pin, not the prompt, has to be the gate.
  local newpw="rotated-${RUN_ID}"
  local remote="${PV_FTP_REMOTE[2]}"
  local edit_answers
  edit_answers='[
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port (default 21)","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password:","value":"'"$newpw"'"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Use FTPS (secure connection)?","value":"y"},
    {"anchor":"What would you like to do","value":"1"}
  ]'
  PTY_TIMEOUT=45000 run_bfs_pty "$vault" "$edit_answers" --lang en provider edit p2

  # Positive control FIRST: the pin assertions below hold trivially for an edit
  # that aborted or hung, so the edit has to be shown to have happened at all.
  assert_exit 0
  local pw_after
  pw_after="$(ftp_cfg_field password)"
  [ "$pw_after" = "$newpw" ] || _fail "the edit did not run to completion: password still '$pw_after', expected '$newpw'"

  # THE assertion: the identity BFS trusts for this address must not have moved.
  # A pin replaced here is a pin replaced for every later push, pull and recovery.
  local fp_after
  fp_after="$(ftp_cfg_field cert_fingerprint)"
  [ "$fp_after" != "$fpB" ] || _fail "the edit pinned the impostor's certificate: '$fpA' -> '$fpB' (SECURITY.md: a changed server identity must not be adopted silently)"
  [ "$fp_after" = "$fpA" ] || _fail "pinned cert_fingerprint changed across the edit: expected '$fpA', stored '$fp_after'"

  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
