# shellcheck shell=bash
# `bfs init` whose SSH storage does not answer resumes with the same command
# once the server is up.
#
# init records each storage as it passes its probe. The middle storage is an
# sshd that is not running yet, so the first run must stop there with the
# storage before it already in .bfs/config.json. Starting the server and
# repeating the exact same command finishes the SAME backup (vault_id kept)
# with the host key of the SSH storage pinned.
#
# Correct: first run non-zero with only p0 recorded; second run exit 0 with
# p0,p1,p2 and the same vault_id; push + pull through the SSH part gives a
# SHA-256 roundtrip (a local part is removed first, so the restore has to read
# the part the resumed init set up).

SCENARIO_NAME="init resumes after an SSH storage that was down"
SCENARIO_DESC="init --ci stops at a dead sshd keeping p0; sshd up; same command finishes the same backup; push + pull through the SSH part SHA-256"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs146"
  local ctr="bfs-e2e-${RUN_ID}-c146" vol="bfs-e2e-${RUN_ID}-v146"
  local port=2352
  local cfg="$vault/.bfs/config.json"

  docker_volume_reset "$vol"
  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" "$DOCKER_SSH_USER" "$DOCKER_SSH_PASS" "$DOCKER_SSH_BASE"
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local ssh local   # p1 = the sshd

  # The host key is learned up front and passed as --known-host: with
  # --accept-new-host-key the flags themselves connect to the server while they
  # are parsed, so a dead server would stop init before any storage is probed -
  # not the interruption this scenario is about. The key lives in the volume,
  # so the server started again below presents the same one.
  local keyprobe="$SC_DIR/keyprobe"
  mkdir -p "$keyprobe"
  run_bfs "$keyprobe" init "${name}key" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  local fp
  fp="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=j.providers.find((x)=>x.id==="p1");process.stdout.write(String(p.config.host_key_fingerprint||""))' "$(winpath "$keyprobe/.bfs/config.json")")"
  case "$fp" in SHA256:*) ;; *) _fail "setup: could not learn the host key of p1 (got: '${fp}')" ;; esac
  PROVIDER_ARGS[3]="${PROVIDER_ARGS[3]/--accept-new-host-key/--known-host $fp}"
  case "${PROVIDER_ARGS[3]}" in *"--known-host $fp"*) ;; *) _fail "setup: p1 spec not rewritten: ${PROVIDER_ARGS[3]}" ;; esac

  # The storage that does not answer during the first init.
  docker_sshd_down "$ctr"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_fail
  # The run stops on the server that does not answer (with --known-host its
  # flags do not connect, so this is the probe of p1).
  assert_out_matches "SSH operation failed on 127\.0\.0\.1:${port}"
  assert_file "$cfg"
  local ids_first
  ids_first="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.providers.map((p)=>p.id).join(","))' "$(winpath "$cfg")")"
  [ "$ids_first" = "p0" ] || _fail "the storage probed before the dead sshd must be recorded alone, got: '${ids_first}'"
  local id_before
  id_before="$(grep -o '"vault_id": "[^"]*"' "$cfg")"

  docker_sshd_up "$ctr" "$port" "$vol" || _fail "could not start sshd again on port $port"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  local ids_done
  ids_done="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.providers.map((p)=>p.id).join(","))' "$(winpath "$cfg")")"
  [ "$ids_done" = "p0,p1,p2" ] || _fail "the resumed init must record all three storages, got: '${ids_done}'"
  local id_after
  id_after="$(grep -o '"vault_id": "[^"]*"' "$cfg")"
  [ "$id_after" = "$id_before" ] || _fail "the resumed init minted a new backup:
  before: $id_before
  after:  $id_after"
  local pinned
  pinned="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));const p=j.providers.find((x)=>x.id==="p1");process.stdout.write(String(p.config.host_key_fingerprint||""))' "$(winpath "$cfg")")"
  [ "$pinned" = "$fp" ] || _fail "the resumed init must pin the key given by --known-host (expected '${fp}', got '${pinned}')"

  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  [ -n "$(ssh_sha "$se" "${PV_SSH_REMOTE[1]}/${name}/shard_1.bfs.1")" ] \
    || _fail "shard_1 missing on the SSH server after push"

  # Without a local part the restore has to read the SSH one.
  rm -f "$(shard_file 0 1)"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_sshd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
