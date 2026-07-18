# shellcheck shell=bash
# Legitimate storage-directory change on the SAME SSH server (NOT a failure): the
# operator reorganises their storage, moving shard_2's directory to a new path on
# the same host:port. The data is intact at the new path, so `bfs repair
# --config-file` (no --rebuild) just repoints the provider and rewrites the
# location map in every shard's header. Distinct from a disk failure — here the
# bytes were deliberately moved, not lost. Proves repair repoints a path change
# without re-uploading the shard.

SCENARIO_NAME="repair: SSH storage directory (path) change"
SCENARIO_DESC="2L+1S 2/1; move the SSH shard dir on the same server, repair --config-file (no rebuild), prove no re-upload"
REQUIRES_LOCAL=2
REQUIRES_SSH=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs88"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = SSH

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Move the provider's storage directory on the same server (deliberate reorg).
  local e="${PV_SSH_ENDPOINT[2]}"
  local oldbase="${PV_SSH_REMOTE[2]}"
  local newbase="${oldbase}-moved-${name}"
  ssh_rename "$e" "$oldbase" "$newbase"

  local newshard="${newbase}/${name}/shard_2.bfs.1"
  local before
  before="$(ssh_sha "$e" "$newshard")"
  [ -n "$before" ] || _fail "shard not present at the new path after the move"

  # Repoint p2 at the new path — data intact, so NO --rebuild.
  local sshjson="$SC_DIR/ssh-p2.json"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s"}\n' \
    "${SSH_HOST[$e]}" "${SSH_PORT[$e]}" "${SSH_USER[$e]}" "${SSH_PASS[$e]}" "$newbase" >"$sshjson"
  run_bfs "$vault" repair --ci --version all p2 "--config-file $(winpath "$sshjson") --accept-new-host-key"
  assert_ok

  # Payload untouched (no re-upload); sidecar written at the new path.
  local after
  after="$(ssh_sha "$e" "$newshard")"
  [ "$after" = "$before" ] || _fail "shard body changed after path-change repair (unexpected re-upload): $before -> $after"
  ssh_sha "$e" "${newbase}/${name}/hdr_2.bfs.1" >/dev/null || _fail "header sidecar missing at the new path after repair"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
