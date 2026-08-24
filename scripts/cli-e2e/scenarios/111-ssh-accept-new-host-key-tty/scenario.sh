# shellcheck shell=bash
# `--accept-new-host-key` is consent given up front - a terminal being present
# does not turn it back into a question.
#
# The path is ordinary and has nothing to do with --ci: an SSH box dies, the
# operator sits down at their own terminal and migrates the shard onto the
# replacement with `bfs repair --rebuild`, passing --accept-new-host-key because
# the replacement is a NEW server and its key is new by definition. Asking them
# to confirm the fingerprint they just authorized adds no decision - and the run
# stops dead until someone notices.
#
# The second half is what makes this worth a real server. `bfs repair` forwards
# the adapter flags whether or not --ci was given, and it PERSISTS the resulting
# connection config. A capture that only fires off a terminal therefore writes
# `accept_new_host_key: true` with no `host_key_fingerprint` - a configuration
# that trusts ANY host key at that address on every later push and pull. So the
# fingerprint has to be in the written config, not merely absent from the output.
#
# A real terminal is the whole point: plain run_bfs redirects stdin from
# /dev/null, so the run is non-interactive there whatever the code does, and both
# possible answers look identical. Only a PTY can show that a terminal present
# does NOT turn this into a run that asks. run_bfs_pty is given NO answers, and
# the exit code is asserted exactly - a wait for an answer that never comes also
# ends non-zero (PTY timeout = 124), and that is the outcome being ruled out.
#
# local: N/A - a local directory has no server identity to establish.
# ftp: the FTPS counterpart (--accept-new-cert) already settles trust ahead of
#   the mode, but it pins nothing, so there is no config content to assert.
# Docker-managed: self-provisions both sshd boxes (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="--accept-new-host-key settles the host key on a terminal too, and pins it"
SCENARIO_DESC="server replaced; repair --rebuild WITHOUT --ci on a real terminal must not ask for the fingerprint, must pin it into the config, and must restore byte-for-byte"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs111"
  local ctr_a="bfs-e2e-${RUN_ID}-c111a" vol_a="bfs-e2e-${RUN_ID}-v111a"
  local ctr_b="bfs-e2e-${RUN_ID}-c111b" vol_b="bfs-e2e-${RUN_ID}-v111b"
  local port_a=2341 port_b=2342

  docker_volume_reset "$vol_a"
  docker_sshd_up "$ctr_a" "$port_a" "$vol_a" || _fail "could not start original sshd on port $port_a"
  register_ssh_endpoint 127.0.0.1 "$port_a" bfsuser bfspass /config

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the original sshd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- The box dies for good; a NEW empty one (fresh host key) takes its place --
  docker_sshd_down "$ctr_a"
  docker_volume_rm "$vol_a"
  docker_volume_reset "$vol_b"
  docker_sshd_up "$ctr_b" "$port_b" "$vol_b" || _fail "could not start replacement sshd on port $port_b"
  register_ssh_endpoint 127.0.0.1 "$port_b" bfsuser bfspass /config
  local se_b="$REG_SSH_INDEX"

  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # The operator's own terminal: no --ci anywhere. `bfs repair` has no prompts of
  # its own, so anything asked here comes from the adapter - which is exactly what
  # --accept-new-host-key was passed to settle.
  local s9remote="/config/bfs-e2e-${RUN_ID}/s9-${name}"
  local sshjson="$SC_DIR/ssh-s9.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"bfspass","path":"%s"}\n' \
    "$port_b" "$s9remote" >"$sshjson"

  PTY_TIMEOUT=60000 run_bfs_pty "$vault" '[]' --lang en repair --version all p2 \
    "ssh:s9 --config-file $(winpath "$sshjson") --accept-new-host-key" --rebuild
  # Checked BEFORE the exit code: an asked question is the precise diagnosis, and
  # the failure it causes downstream ("expected exit 0, got 1") is only its echo.
  if printf '%s' "$BFS_OUT" | grep -qF "Trust the host key for"; then
    _fail "repair asked the operator to trust the host key despite --accept-new-host-key"
  fi
  assert_exit 0
  assert_manifest_contains "$vault" 1 '"provider_id": "s9"'
  assert_manifest_absent "$vault" 1 '"provider_id": "p2"'

  # The pin, not merely the opt-in: a config carrying accept_new_host_key with no
  # fingerprint trusts whatever key answers at that address, on every connection.
  # Read out of the s9 entry specifically - a match anywhere in the file would go
  # green on some other storage's pin.
  local pinned
  pinned="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=j.providers.find((x)=>x.id==="s9");const f=p&&p.config&&p.config.host_key_fingerprint;process.stdout.write(typeof f==="string"?f:"")' "$(winpath "$vault/.bfs/config.json")")"
  case "$pinned" in
    SHA256:*) ;;
    *) _fail "the accepted host key was not pinned into the s9 configuration (got: '${pinned}')" ;;
  esac

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  [ -n "$(ssh_sha "$se_b" "${s9remote}/${name}/shard_2.bfs.1")" ] \
    || _fail "shard_2 missing on the replacement server after repair --rebuild"

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctr_b"
  docker_volume_rm "$vol_b"
  return 0
}
