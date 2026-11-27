# shellcheck shell=bash
# An empty host-key pin is no pin: the connection treats it as none. It reaches
# the settings from a file (an offline `bfs provider edit` that chose "save
# without pinning" stores `"host_key_fingerprint": ""`, and the operator adds
# `"accept_new_host_key": true` next to it) or from an empty `--known-host`.
# The opt-in is consent given in this very invocation, so the presented key has
# to be captured and pinned - read as a pin, "" skips the capture and leaves a
# bare opt-in, which the next connection without an operator refuses: already
# the probe of `init --ci` itself, so the backup cannot be set up at all.
#
# Binding assertions: init --ci with such a --config-file pins the server's key
# in config.json (a non-empty SHA256 fingerprint for that storage), the next
# unattended push succeeds and lands its part on the server, and a restore that
# must read that part (one local part removed) matches the snapshot
# byte-for-byte.
#
# local/ftp: N/A - host-key TOFU is SSH-specific; an empty FTPS certificate pin
# in --config-file is already refused as an invalid fingerprint.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="init --ci over SSH pins the host key for an opt-in next to an empty pin"
SCENARIO_DESC="--config-file with accept_new_host_key true and host_key_fingerprint \"\" must capture and pin the key, so an unattended push then succeeds"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs155"
  local ctr="bfs-e2e-${RUN_ID}-c155" vol="bfs-e2e-${RUN_ID}-v155"
  local port=2354
  local home="$SC_DIR/home" cfgfile="$SC_DIR/p2.json"
  mkdir -p "$home/.ssh"

  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" "$DOCKER_SSH_USER" "$DOCKER_SSH_PASS" "$DOCKER_SSH_BASE"
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local   # p0, p1 - p2 (ssh) comes from the settings file

  # An empty pin as an offline "save without pinning" stores it, plus the opt-in.
  cat >"$cfgfile" <<JSON
{
  "host": "127.0.0.1",
  "port": ${port},
  "user": "${DOCKER_SSH_USER}",
  "password": "${DOCKER_SSH_PASS}",
  "path": "${DOCKER_SSH_BASE}",
  "accept_new_host_key": true,
  "host_key_fingerprint": ""
}
JSON

  # An empty HOME keeps the operator's own known_hosts from supplying trust.
  HOME="$home" USERPROFILE="$(winpath "$home")" run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}" \
    --provider "ssh:p2 --config-file $(winpath "$cfgfile")"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"
  HOME="$home" USERPROFILE="$(winpath "$home")" run_bfs "$vault" --ci push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  [ -n "$(ssh_sha "$se" "${DOCKER_SSH_BASE}/${name}/shard_2.bfs.1")" ] \
    || _fail "shard_2 missing on the SSH server after push"

  # The pin is in the settings, read from the entry of this storage only - a
  # match anywhere in the file could come from another storage.
  local pin
  pin="$(node -e '
    const cfg = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const p = cfg.providers.find((x) => x.id === "p2");
    process.stdout.write(p && typeof p.config.host_key_fingerprint === "string" ? p.config.host_key_fingerprint : "");
  ' "$(winpath "$vault/.bfs/config.json")")"
  case "$pin" in
    SHA256:?*) ;;
    *) _fail "init --ci must pin the presented host key for p2, got: '$pin'" ;;
  esac

  # One local part gone, so the restore has to read the part on the server
  # through the pinned key - two local parts of this 2/1 scheme would restore
  # on their own.
  rm -f "$(shard_file 0 1)"
  wipe_working_tree "$vault"
  HOME="$home" USERPROFILE="$(winpath "$home")" run_bfs "$vault" --ci pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
