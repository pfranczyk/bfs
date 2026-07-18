# shellcheck shell=bash
# Interactive `bfs provider edit <ssh>` honours the offline-edit guarantee:
# rotating only the password, on an UNCHANGED host, SUCCEEDS even when the SSH
# server is DOWN — the edit-aware flow reuses the already-pinned
# host_key_fingerprint without contacting the medium and exits 0.
#
# Awaria wstrzyknięta REALNIE (reguła dowodu #3): the sshd container is KILLED
# (docker_sshd_down), not faked by directory manipulation on a live server.
#
# local/ftp: N/A — host-key handling is SSH-specific.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="edit ssh offline: password rotation on unchanged host succeeds with the server down"
SCENARIO_DESC="sshd pinned via --accept-new-host-key; kill it; interactive provider edit rotates ONLY the password → exit 0 offline, host_key_fingerprint unchanged"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs95"
  local ctr="bfs-e2e-${RUN_ID}-c95" vol="bfs-e2e-${RUN_ID}-v95"
  local port=2332
  local cfg="$vault/.bfs/config.json"

  # Reads a field of the (single) SSH provider's connection config from config.json.
  ssh_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ssh");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  # ── Genuine sshd on $port, pinned via the realistic first-contact path ──────
  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" bfsuser bfspass /config
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the managed sshd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Capture the pinned fingerprint and the current password BEFORE the edit.
  local fp_before pw_before
  fp_before="$(ssh_cfg_field host_key_fingerprint)"
  pw_before="$(ssh_cfg_field password)"
  [ -n "$fp_before" ] || _fail "no host_key_fingerprint pinned after init (expected --accept-new-host-key to pin it)"
  [ "$pw_before" = "bfspass" ] || _fail "unexpected stored password before edit: '$pw_before'"

  # ── Kill the server for real: the medium is now unreachable ─────────────────
  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"

  # ── Interactive edit rotating ONLY the password, host/port unchanged ────────
  # The edit-aware interactive flow prompts the same fields as configureInteractive
  # (host / port / user / auth-method rawlist / password / base-path), in that
  # order; because host+port are unchanged and a fingerprint is already pinned, it
  # reuses the pin WITHOUT any host-key prompt or server contact. The password
  # prompt is anchored on "Password:" (with colon) so it does not collide with the
  # rawlist option "Password" (no colon) rendered for the auth-method choice.
  local newpw="rotated-${RUN_ID}"
  local remote="${PV_SSH_REMOTE[2]}"
  local edit_answers
  edit_answers='[
    {"anchor":"SSH host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Authentication method","value":"1"},
    {"anchor":"Password:","value":"'"$newpw"'"},
    {"anchor":"Base path on server","value":"'"$remote"'"}
  ]'
  run_bfs_pty "$vault" "$edit_answers" --lang en provider edit p2

  # The edit must COMPLETE OFFLINE — not hang, not fail on the dead server.
  assert_exit 0

  # The host identity did not change, so the pinned fingerprint must be preserved
  # verbatim (no re-pin, no wipe), and only the password must have rotated.
  local fp_after pw_after
  fp_after="$(ssh_cfg_field host_key_fingerprint)"
  pw_after="$(ssh_cfg_field password)"
  [ "$fp_after" = "$fp_before" ] || _fail "host_key_fingerprint changed across an offline password edit: '$fp_before' -> '$fp_after'"
  [ "$pw_after" = "$newpw" ] || _fail "password not rotated by the edit: expected '$newpw', got '$pw_after'"

  return 0
}
