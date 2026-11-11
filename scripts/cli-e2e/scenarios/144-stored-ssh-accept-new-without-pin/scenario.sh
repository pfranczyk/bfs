# shellcheck shell=bash
# A configuration carrying `accept_new_host_key: true` with no
# `host_key_fingerprint` is refused by an unattended push - it does not trust
# whatever key answers at that address.
#
# That pair is what `bfs provider add --accept-new-host-key` wrote on a terminal
# in 0.12/0.13, and nothing migrates config.json, so operators still stand on
# it. The opt-in read back from disk is consent spent again on every run: any
# server at that address would be trusted, forever, without a word. Without an
# operator the push must stop, name the storage and its state, suggest nothing
# (no flag, no command - the fix is the operator's, made at a terminal), and
# create no version.
#
# The state is written straight into config.json: no current command produces
# it any more, and this is the only way to stand where those operators stand.
# The runtime behaviour under test is untouched by that.
#
# The refused push stops in openProviders, after the push lock and the packed
# backup data were written, so the next command needs `bfs clear` first. Then
# the operator pins the fingerprint they obtained out of band and the backup
# runs again: push + pull with a SHA-256 comparison, the part checked on the
# server itself (under 2/1 the two local parts alone would restore).
#
# A real terminal on purpose (run_bfs_pty with no answers): `--ci` before the
# subcommand must not turn into a question even with a TTY attached, and a wait
# for an answer would end in the PTY timeout (124), which assert_exit rules out.
#
# local: N/A - a local directory has no server identity to establish.
# ftp: 145-stored-ftps-accept-new-without-pin.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="stored accept_new_host_key without a pin: unattended push refuses, pinning restores"
SCENARIO_DESC="config.json in the 0.12/0.13 shape (opt-in, null pin); --ci push on a terminal refuses naming the storage, no flag, no version; clear; pin out of band via provider edit --ci --known-host; push + pull SHA-256"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs144"
  local ctr="bfs-e2e-${RUN_ID}-c144" vol="bfs-e2e-${RUN_ID}-v144"
  local port=2351
  local cfg="$vault/.bfs/config.json"

  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" "$DOCKER_SSH_USER" "$DOCKER_SSH_PASS" "$DOCKER_SSH_BASE"
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the sshd
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # The fingerprint the operator knows from a second channel: the key captured
  # at init is this very server's, so it stands for the out-of-band value.
  local fp
  fp="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=j.providers.find((x)=>x.id==="p2");process.stdout.write(String(p.config.host_key_fingerprint||""))' "$(winpath "$cfg")")"
  case "$fp" in SHA256:*) ;; *) _fail "init did not pin the host key of p2 (got: '${fp}')" ;; esac

  # -- The 0.12/0.13 shape: opt-in kept, pin gone ------------------------------
  node -e 'const fs=require("fs");const f=process.argv[1];const j=JSON.parse(fs.readFileSync(f,"utf8"));const p=j.providers.find((x)=>x.id==="p2");p.config.accept_new_host_key=true;p.config.host_key_fingerprint=null;fs.writeFileSync(f,JSON.stringify(j,null,2))' "$(winpath "$cfg")"

  mutate_fixtures "$vault"
  PTY_TIMEOUT=60000 run_bfs_pty "$vault" '[]' --lang en --ci push --new
  assert_exit 1
  assert_out_contains "${DOCKER_SSH_USER}@127.0.0.1:${port}"
  assert_out_contains "not pinned"
  local leak
  for leak in "--accept-new-host-key" "--known-host" "provider edit" "$fp"; do
    if printf '%s' "$BFS_OUT" | grep -qF -- "$leak"; then
      _fail "the refusal suggests a fix or shows the presented key: found '${leak}'"
    fi
  done
  assert_state "$vault" latest_version 1
  if [ -n "$(ssh_sha "$se" "${PV_SSH_REMOTE[2]}/${name}/shard_2.bfs.2")" ]; then
    _fail "shard_2 of a new version reached the server despite the refusal"
  fi

  run_bfs "$vault" clear
  assert_ok

  # -- The operator pins the known fingerprint, at their own command -----------
  # MSYS2_ARG_CONV_EXCL: Git Bash would rewrite the bare POSIX --path for the
  # server into a Windows path; excluding just that prefix keeps the conversion
  # the bfs entry point itself needs. No effect outside Git Bash.
  MSYS2_ARG_CONV_EXCL="${PV_SSH_REMOTE[2]}" run_bfs "$vault" provider edit p2 --ci --host 127.0.0.1 --port "$port" \
    --user "$DOCKER_SSH_USER" --password "$DOCKER_SSH_PASS" --path "${PV_SSH_REMOTE[2]}" --known-host "$fp"
  assert_ok

  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 2 healthy
  [ -n "$(ssh_sha "$se" "${PV_SSH_REMOTE[2]}/${name}/shard_2.bfs.2")" ] \
    || _fail "shard_2 missing on the SSH server after the pinned push"

  wipe_working_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
