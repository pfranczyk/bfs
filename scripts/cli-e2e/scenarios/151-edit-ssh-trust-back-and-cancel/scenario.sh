# shellcheck shell=bash
# The host-key decision during an interactive edit has three exits, not two.
# Refusing a host key usually does not mean "I distrust this server" - it means
# "I aimed at the wrong one, and I only noticed now, at this question". With a
# yes/no decision that mistake costs the operator every field already entered:
# address, user, password, path. So the decision offers going back to them.
#
# Two phases against two REAL sshd servers with different host keys:
#   (a) cancel  -> the edit ends with exit 1, the stored config is untouched;
#   (b) go back -> the fields are collected again, the corrected address is saved.
#
# Failure injected for real: the wrong target is a second sshd container with
# its own generated host key, not a faked answer.
#
# HOME and USERPROFILE point at an empty directory for the edits, so the
# operator's own ~/.ssh/known_hosts cannot trust server B and skip the menu.
#
# This is the SSH twin of 105-edit-ftps-trust-back-and-cancel; the pair is the
# A/B control that the three exits hold per medium.
# local: N/A - no server identity to decide about.
# Docker-managed: self-provisions both sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="edit ssh host-key menu: cancel leaves the config alone, going back re-collects the fields"
SCENARIO_DESC="two sshd servers with different host keys; an edit aimed at the wrong one is first cancelled (exit 1, config untouched), then repeated and taken back to the prompts, where the corrected address and a new password are saved; restore reads through the corrected storage"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs151"
  local ctrA="bfs-e2e-${RUN_ID}-c151a" volA="bfs-e2e-${RUN_ID}-v151a"
  local ctrB="bfs-e2e-${RUN_ID}-c151b" volB="bfs-e2e-${RUN_ID}-v151b"
  local portA=2343 portB=2344
  local cfg="$vault/.bfs/config.json"
  local home="$SC_DIR/empty-home"
  mkdir -p "$home/.ssh"

  # Reads a field of the (single) SSH provider's connection config from config.json.
  ssh_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ssh");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  # -- The intended server (A), pinned at init --------------------------------
  docker_volume_reset "$volA"
  docker_sshd_up "$ctrA" "$portA" "$volA" || _fail "could not start sshd A on port $portA"
  register_ssh_endpoint 127.0.0.1 "$portA" bfsuser bfspass /config

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = server A

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local remote="${PV_SSH_REMOTE[2]}" fpA
  fpA="$(ssh_cfg_field host_key_fingerprint)"
  [ -n "$fpA" ] || _fail "init did not pin server A's host key"
  [ "$(ssh_cfg_field password)" = "bfspass" ] || _fail "unexpected stored password before the edits"

  # -- The server the operator aims at by mistake (B), its own host key -------
  docker_volume_reset "$volB"
  docker_sshd_up "$ctrB" "$portB" "$volB" || _fail "could not start sshd B on port $portB"

  # -- (a) Aim at server B, then CANCEL at the host-key decision --------------
  # Option 3 is cancel. The command must end and leave the stored config alone.
  local cancel_answers
  cancel_answers='[
    {"anchor":"SSH host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$portB"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Authentication method","value":"1"},
    {"anchor":"Password:","value":"never-persisted"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"What would you like to do","value":"3"}
  ]'
  HOME="$home" USERPROFILE="$(winpath "$home")" PTY_TIMEOUT=45000 \
    run_bfs_pty "$vault" "$cancel_answers" --lang en provider edit p2

  # Exactly 1, not merely non-zero: a PTY timeout exits 124, so `assert_fail`
  # alone would also accept a flow that hung waiting for an answer nobody gave.
  assert_exit 1
  # The decision has to be a menu, not a yes/no question - otherwise "3" would be
  # read as a refusal and this phase would pass for the wrong reason.
  assert_out_contains "What would you like to do"
  assert_out_matches "X .*was not trusted"
  [ "$(ssh_cfg_field host_key_fingerprint)" = "$fpA" ] || _fail "a cancelled edit changed the pinned host key"
  [ "$(ssh_cfg_field password)" = "bfspass" ] || _fail "a cancelled edit persisted the password"
  [ "$(ssh_cfg_field port)" = "$portA" ] || _fail "a cancelled edit persisted the wrong port"

  # -- (b) Aim at B again, then GO BACK and correct the address ---------------
  # Option 2 is go back. The second pass points at server A and supplies the
  # password the server actually accepts; the address then matches what is
  # stored, so the pin is reused without contact.
  #
  # The stored password is spoiled first, so that seeing `bfspass` afterwards can
  # only mean the SECOND pass reached the config - without it the phase would
  # pass for an edit that aborted and changed nothing. Through a JSON config file
  # rather than inline flags: Git Bash rewrites a bare `/config` argument into a
  # Windows path. Values inside the file are never touched.
  local spoil="$SC_DIR/spoil.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"spoiled-before-the-edit","path":"%s","host_key_fingerprint":"%s"}\n' \
    "$portA" "$remote" "$fpA" > "$spoil"
  run_bfs "$vault" provider edit p2 --ci --config-file "$(winpath "$spoil")"
  assert_ok
  [ "$(ssh_cfg_field password)" = "spoiled-before-the-edit" ] || _fail "could not spoil the stored password"

  # Every answer of the second pass waits for text printed after the menu: the
  # field labels are already in the output from the first pass.
  local back_answers
  back_answers='[
    {"anchor":"SSH host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$portB"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Authentication method","value":"1"},
    {"anchor":"Password:","value":"typed-at-the-wrong-server"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"What would you like to do","value":"2"},
    {"after":"Going back to the connection settings","anchor":"SSH host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$portA"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Authentication method","value":"1"},
    {"anchor":"Password:","value":"bfspass"},
    {"anchor":"Base path on server","value":"'"$remote"'"}
  ]'
  HOME="$home" USERPROFILE="$(winpath "$home")" PTY_TIMEOUT=60000 \
    run_bfs_pty "$vault" "$back_answers" --lang en provider edit p2

  assert_exit 0
  [ "$(ssh_cfg_field port)" = "$portA" ] || _fail "the corrected address was not saved: port '$(ssh_cfg_field port)', expected '$portA'"
  [ "$(ssh_cfg_field password)" = "bfspass" ] || _fail "the second pass did not reach the config: password '$(ssh_cfg_field password)'"
  [ "$(ssh_cfg_field host_key_fingerprint)" = "$fpA" ] || _fail "going back disturbed the pinned host key: '$fpA' -> '$(ssh_cfg_field host_key_fingerprint)'"

  # Server B has done its job; the restore runs against server A alone.
  docker_sshd_down "$ctrB"
  docker_volume_rm "$volB"

  # The corrected config has to actually work, not merely look right. One local
  # part is removed, so reconstruction cannot avoid the SSH server - a restore
  # that still succeeds proves the address, the password and the pin all landed.
  rm -f "$(shard_file 0 1)"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctrA"
  docker_volume_rm "$volA"
  return 0
}
