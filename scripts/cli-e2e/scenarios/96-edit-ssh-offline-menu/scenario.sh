# shellcheck shell=bash
# Interactive `bfs provider edit <ssh>` — the OFFLINE MENU path through a real
# inquirer TTY. Changing the SSH host to an UNREACHABLE address (host identity
# changed) makes the edit try the server first, fail, and fall back to the
# offline menu; the operator picks "paste a fingerprint" and the pasted pin is
# persisted. This is the real-IO (rule #5) proof for the offline menu, which
# unit tests exercise only through a mocked ProviderIO.
#
# Determinism: the new host is a RFC-reserved `.invalid` name — never in
# ~/.ssh/known_hosts and never resolvable — so the online attempt fails fast and
# the menu carries exactly [paste / leave / cancel] on every machine, regardless
# of the operator's real known_hosts.
#
# local/ftp: N/A — host-key handling is SSH-specific.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="edit ssh offline menu: host changed to an unreachable address → paste a fingerprint via real inquirer"
SCENARIO_DESC="sshd pinned via --accept-new-host-key; edit changes host to an unreachable .invalid address → offline menu over a real PTY → paste SHA256 → exit 0, pin = pasted, host updated"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs96"
  local ctr="bfs-e2e-${RUN_ID}-c96" vol="bfs-e2e-${RUN_ID}-v96"
  local port=2334
  local cfg="$vault/.bfs/config.json"
  # A well-formed OpenSSH SHA-256 fingerprint (sha256 of the empty input) — passes
  # isValidFingerprint; deterministic and independent of any real key.
  local pasted="SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"
  local newhost="bfs-e2e-offline.invalid"

  # Reads a field of the (single) SSH provider's connection config from config.json.
  ssh_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.type==="ssh");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  # ── Genuine sshd on $port, pinned via the realistic first-contact path ──────
  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" bfsuser bfspass /config

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the managed sshd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$SC_DIR/baseline.txt"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local fp_before
  fp_before="$(ssh_cfg_field host_key_fingerprint)"
  [ -n "$fp_before" ] || _fail "no host_key_fingerprint pinned after init (expected --accept-new-host-key to pin it)"

  # ── Kill the server for real: the medium is now unreachable ─────────────────
  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"

  # ── Interactive edit changing the HOST (identity change) to an unreachable
  # address → online attempt fails → offline menu → "paste" (option 1, no
  # known_hosts candidates for the .invalid host) → paste a SHA256 fingerprint.
  local remote="${PV_SSH_REMOTE[2]}"
  local answers
  answers='[
    {"anchor":"SSH host","value":"'"$newhost"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Authentication method","value":"1"},
    {"anchor":"Password:","value":"bfspass"},
    {"anchor":"Base path on server","value":"'"$remote"'"},
    {"anchor":"Choose how to set","value":"1"},
    {"anchor":"Host-key fingerprint","value":"'"$pasted"'"}
  ]'
  run_bfs_pty "$vault" "$answers" --lang en provider edit p2

  # The edit must COMPLETE OFFLINE after the online attempt failed.
  assert_exit 0
  # The offline menu was rendered through the real inquirer prompt.
  assert_out_contains "Could not reach"

  # The pasted fingerprint replaced the pin, and the host was updated.
  local fp_after host_after
  fp_after="$(ssh_cfg_field host_key_fingerprint)"
  host_after="$(ssh_cfg_field host)"
  [ "$fp_after" = "$pasted" ] || _fail "pasted fingerprint not persisted: expected '$pasted', got '$fp_after'"
  [ "$host_after" = "$newhost" ] || _fail "host not updated by the edit: expected '$newhost', got '$host_after'"

  return 0
}
