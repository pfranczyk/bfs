# shellcheck shell=bash
# A configuration carrying `accept_new_cert: true` with no `cert_fingerprint` is
# refused by an unattended push - it does not trust whatever certificate an
# FTPS server at that address presents.
#
# `--accept-new-cert` in 0.14 and earlier pinned nothing, so every config
# written with it holds exactly this pair, and nothing migrates config.json. The opt-in
# read back from disk is consent spent again on every run: any server at that
# address would be trusted, forever, and handed the password. Without an
# operator the push must stop before PASS leaves, name the storage and its
# state, suggest nothing (no flag, no command - the fix is the operator's, made
# at a terminal), and create no version.
#
# The state is written straight into config.json: no command produces it once
# the flag pins, and this is the only way to stand where those operators stand.
# The runtime behaviour under test is untouched by that.
#
# The refused push stops in openProviders, after the push lock and the packed
# backup data were written, so the next command needs `bfs clear` first. Then
# the operator pins the fingerprint they obtained out of band and the backup
# runs again: push + pull with a SHA-256 comparison, the part checked on the
# server itself (under 2/1 the two local parts alone would restore).
#
# A real terminal on purpose (run_bfs_pty with no answers): `--ci` before the
# subcommand must not turn into a question even with a TTY attached.
#
# local: N/A - TLS certificate trust is FTPS-specific.
# ssh: 144-stored-ssh-accept-new-without-pin.
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="stored accept_new_cert without a pin: unattended push refuses, pinning restores"
SCENARIO_DESC="config.json with accept_new_cert and no cert_fingerprint; --ci push on a terminal refuses naming the storage, no flag, no fingerprint, no version; clear; pin out of band via provider edit --ci --cert-fingerprint; push + pull SHA-256"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificate"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs145"
  local ctr="bfs-e2e-${RUN_ID}-c145" vol="bfs-e2e-${RUN_ID}-v145"
  local port=2168 pmin=21390 pmax=21400
  local cert="$SC_DIR/cert.pem" key="$SC_DIR/key.pem"
  local cfg="$vault/.bfs/config.json"

  gen_selfsigned_cert "$cert" "$key" bfs-ftps-145 || _fail "could not generate the certificate"
  local fp; fp="$(ftps_cert_fingerprint "$cert")"
  [ -n "$fp" ] || _fail "could not read the certificate fingerprint"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$cert" "$key" \
    || _fail "could not start FTPS server on port $port"
  register_ftp_endpoint 127.0.0.1 "$port" bfsuser bfspass /ftp/bfsuser true "$fp"
  local fe="$REG_FTP_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = the FTPS server, pinned
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # -- The bare opt-in: accept_new_cert kept, pin gone -------------------------
  node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));const p=j.providers.find((x)=>x.id==="p2");p.config.accept_new_cert=true;delete p.config.cert_fingerprint;delete p.config.cert_self_signed;fs.writeFileSync(f,JSON.stringify(j,null,2))' "$(winpath "$cfg")"

  mutate_fixtures "$vault"
  PTY_TIMEOUT=60000 run_bfs_pty "$vault" '[]' --lang en --ci push --new
  assert_exit 1
  # Target AND state: the target alone also appears in a plain transport
  # failure ("FTP operation failed on 127.0.0.1:<port>").
  assert_out_contains "127.0.0.1:${port}"
  assert_out_contains "not pinned"
  local leak
  for leak in "--accept-new-cert" "--cert-fingerprint" "provider edit" "$fp"; do
    if printf '%s' "$BFS_OUT" | grep -qF -- "$leak"; then
      _fail "the refusal suggests a fix or shows the presented certificate: found '${leak}'"
    fi
  done
  assert_state "$vault" latest_version 1
  if [ -n "$(ftp_sha "$fe" "${PV_FTP_REMOTE[2]}/${name}/shard_2.bfs.2")" ]; then
    _fail "shard_2 of a new version reached the server despite the refusal"
  fi

  run_bfs "$vault" clear
  assert_ok

  # -- The operator pins the known fingerprint, at their own command -----------
  # MSYS2_ARG_CONV_EXCL: Git Bash would rewrite the bare POSIX --path for the
  # server into a Windows path; excluding just that prefix keeps the conversion
  # the bfs entry point itself needs. No effect outside Git Bash.
  MSYS2_ARG_CONV_EXCL="${PV_FTP_REMOTE[2]}" run_bfs "$vault" provider edit p2 --ci --host 127.0.0.1 --port "$port" \
    --user bfsuser --password bfspass --path "${PV_FTP_REMOTE[2]}" --secure true --cert-fingerprint "$fp"
  assert_ok

  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 2 healthy
  [ -n "$(ftp_sha "$fe" "${PV_FTP_REMOTE[2]}/${name}/shard_2.bfs.2")" ] \
    || _fail "shard_2 missing on the FTPS server after the pinned push"

  wipe_working_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
