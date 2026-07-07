# shellcheck shell=bash
# bfs repair --rebuild onto an FTP provider: the FTP shard is physically lost;
# Reed-Solomon reconstructs it from the surviving (local) shards and re-uploads
# it over the network to the SAME FTP provider. The backup is healthy again and
# restores byte-for-byte. Exercises the rebuild upload path through a real socket,
# which the local-only rebuild scenarios (63/64) never touch.

SCENARIO_NAME="repair --rebuild: reconstruct a lost FTP shard"
SCENARIO_DESC="2L+1F 2/1; delete the FTP shard, repair --rebuild re-uploads it, verify healthy, pull SHA-256"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs68"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L · p1 L · p2 F

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Lose the FTP shard by renaming the file away (the remote base dir stays, so
  # the rebuilt shard re-uploads to the same location). Confirm degraded, then
  # RS-rebuild it back onto FTP.
  local e="${PV_FTP_ENDPOINT[2]}"
  local shard="${PV_FTP_REMOTE[2]}/${name}/shard_2.bfs.1"
  ftp_rename "$e" "$shard" "${shard}.gone"
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  run_bfs "$vault" repair --version 1 p2 "" --rebuild
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
