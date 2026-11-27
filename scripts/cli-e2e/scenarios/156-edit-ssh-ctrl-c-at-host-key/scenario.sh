# shellcheck shell=bash
# Ctrl+C at the host-key question of an interactive `bfs provider edit <ssh>`
# ends the command. The server answered and presented its key, so the question
# being interrupted is not a sign that it is unreachable - the edit must not
# drop into the offline menu ("Could not reach ...") as if it were.
#
# Setup: the stored SSH entry carries no host-key pin (what "save without a pin"
# in the offline menu leaves behind), so an edit naming the same address still
# has to ask the server for its key. HOME and USERPROFILE point at an empty
# directory, so the operator's own ~/.ssh/known_hosts cannot trust the key and
# skip the question.
#
# Failure injected for real: a real sshd presents its key over a real PTY, and
# the operator's answer at the host-key menu is the Ctrl+C byte.
# local: N/A - no server identity to decide about. FTPS reads its certificate
# apart from the decision about it, so only SSH needs this proof.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="edit ssh: Ctrl+C at the host-key menu ends the command, no offline menu"
SCENARIO_DESC="sshd reachable, stored entry without a pin; interactive edit reaches the host-key menu over a real PTY, Ctrl+C there -> exit 130, the offline menu never appears, config.json untouched"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs156"
  local ctr="bfs-e2e-${RUN_ID}-c156" vol="bfs-e2e-${RUN_ID}-v156"
  local port=2355
  local cfg="$vault/.bfs/config.json"
  local home="$SC_DIR/empty-home"
  mkdir -p "$home/.ssh"

  # Reads a field of the (single) SSH provider's connection config from config.json.
  ssh_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ssh");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" bfsuser bfspass /config

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the sshd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  local remote="${PV_SSH_REMOTE[2]}"

  # Drop the pin, the state an earlier "save without a pin" leaves. Through a
  # JSON config file rather than inline flags: Git Bash rewrites a bare
  # `/config` argument into a Windows path. Values inside the file are kept.
  local unpinned="$SC_DIR/unpinned.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"bfspass","path":"%s","host_key_fingerprint":""}\n' \
    "$port" "$remote" > "$unpinned"
  run_bfs "$vault" provider edit p2 --ci --config-file "$(winpath "$unpinned")"
  assert_ok
  [ -z "$(ssh_cfg_field host_key_fingerprint)" ] || _fail "could not clear the stored pin"
  local before
  before="$(sha256sum "$cfg" | cut -d' ' -f1)"

  # The menu answer is the Ctrl+C byte (ETX); the driver types it and Enter.
  local answers
  answers='[
    {"anchor":"SSH host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Authentication method","value":"1"},
    {"anchor":"Password:","value":"never-persisted"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"What would you like to do","value":"\u0003"}
  ]'
  HOME="$home" USERPROFILE="$(winpath "$home")" PTY_TIMEOUT=45000 \
    run_bfs_pty "$vault" "$answers" --lang en provider edit p2

  # The question really was the host-key menu of a reachable server - otherwise
  # Ctrl+C would have landed somewhere else and the phase proves nothing.
  assert_out_contains "presented a host key with fingerprint"
  if printf '%s' "$BFS_OUT" | grep -q "Could not reach"; then _fail "Ctrl+C at the host-key menu opened the offline menu"; fi
  # Exactly 130 (a cancelled prompt): a PTY timeout exits 124 and an aborted edit
  # exits 1, so neither can pass for the command having ended at the Ctrl+C.
  assert_exit 130
  [ "$(sha256sum "$cfg" | cut -d' ' -f1)" = "$before" ] || _fail "an interrupted edit changed config.json"

  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
