# shellcheck shell=bash
# The FTP counterpart of 90: prune old versions and confirm the pruned versions'
# shards are actually DELETED from the FTP server. Discriminates whether the
# prune-orphans-remote-shards bug (90, SSH) is SSH-specific or affects every
# remote provider.

SCENARIO_NAME="prune versions on FTP (remote shards deleted)"
SCENARIO_DESC="2L+1F; push v1/v2/v3, prune v1 and keep-last 1, assert pruned FTP shards are gone"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs91"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = FTP

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  run_bfs "$vault" push --new; assert_ok   # v1
  run_bfs "$vault" push --new; assert_ok   # v2
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new; assert_ok   # v3

  local e="${PV_FTP_ENDPOINT[2]}"
  local sdir="${PV_FTP_REMOTE[2]}/${name}"
  [ -n "$(ftp_sha "$e" "${sdir}/shard_2.bfs.1")" ] || _fail "v1 FTP shard missing after push"
  [ -n "$(ftp_sha "$e" "${sdir}/shard_2.bfs.2")" ] || _fail "v2 FTP shard missing after push"
  [ -n "$(ftp_sha "$e" "${sdir}/shard_2.bfs.3")" ] || _fail "v3 FTP shard missing after push"

  run_bfs "$vault" prune 1 --yes
  assert_ok
  assert_no_file "$vault/.bfs/manifests/v001.json"
  if ftp_sha "$e" "${sdir}/shard_2.bfs.1" >/dev/null 2>&1; then
    _fail "pruned v1 FTP shard is still on the server (orphaned remote data)"
  fi
  [ -n "$(ftp_sha "$e" "${sdir}/shard_2.bfs.2")" ] || _fail "v2 FTP shard wrongly removed by prune of v1"

  run_bfs "$vault" prune --keep-last 1 --yes
  assert_ok
  assert_no_file "$vault/.bfs/manifests/v002.json"
  if ftp_sha "$e" "${sdir}/shard_2.bfs.2" >/dev/null 2>&1; then
    _fail "pruned v2 FTP shard is still on the server (orphaned remote data)"
  fi
  [ -n "$(ftp_sha "$e" "${sdir}/shard_2.bfs.3")" ] || _fail "surviving v3 FTP shard missing after prune"

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
