# shellcheck shell=bash
# Prune old versions from an SSH provider and confirm the pruned versions' shards
# are actually DELETED from the server — not just dropped from the manifest. The
# local prune scenario (06) only checks manifests; this exercises the SSH delete
# path and guards against orphaned remote shards (a silent storage leak).

SCENARIO_NAME="prune versions on SSH (remote shards deleted)"
SCENARIO_DESC="2L+1S; push v1/v2/v3, prune v1 and keep-last 1, assert pruned SSH shards are gone"
REQUIRES_LOCAL=2
REQUIRES_SSH=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs90"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = SSH

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  run_bfs "$vault" push --new; assert_ok   # v1
  run_bfs "$vault" push --new; assert_ok   # v2
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new; assert_ok   # v3

  local e="${PV_SSH_ENDPOINT[2]}"
  local sdir="${PV_SSH_REMOTE[2]}/${name}"
  # All three versions' shards are present on the SSH server.
  [ -n "$(ssh_sha "$e" "${sdir}/shard_2.bfs.1")" ] || _fail "v1 SSH shard missing after push"
  [ -n "$(ssh_sha "$e" "${sdir}/shard_2.bfs.2")" ] || _fail "v2 SSH shard missing after push"
  [ -n "$(ssh_sha "$e" "${sdir}/shard_2.bfs.3")" ] || _fail "v3 SSH shard missing after push"

  # Prune v1 by id — its remote shard must be deleted from the server.
  run_bfs "$vault" prune 1 --yes
  assert_ok
  assert_no_file "$vault/.bfs/manifests/v001.json"
  if ssh_sha "$e" "${sdir}/shard_2.bfs.1" >/dev/null 2>&1; then
    _fail "pruned v1 SSH shard is still on the server (orphaned remote data)"
  fi
  [ -n "$(ssh_sha "$e" "${sdir}/shard_2.bfs.2")" ] || _fail "v2 SSH shard wrongly removed by prune of v1"

  # Keep only the latest — v2's remote shard must go too.
  run_bfs "$vault" prune --keep-last 1 --yes
  assert_ok
  assert_no_file "$vault/.bfs/manifests/v002.json"
  if ssh_sha "$e" "${sdir}/shard_2.bfs.2" >/dev/null 2>&1; then
    _fail "pruned v2 SSH shard is still on the server (orphaned remote data)"
  fi
  [ -n "$(ssh_sha "$e" "${sdir}/shard_2.bfs.3")" ] || _fail "surviving v3 SSH shard missing after prune"

  # The surviving version still restores byte-for-byte.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
