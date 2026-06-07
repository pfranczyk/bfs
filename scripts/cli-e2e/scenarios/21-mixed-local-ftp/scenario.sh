# shellcheck shell=bash
# Hybrid pool with INTERLEAVED layout: local, ftp, local, ftp (3/1). Lose a
# local shard whose Reed-Solomon reconstruction must read the interspersed FTP
# shards, then restore byte-for-byte. Interleaving (rather than grouping all
# local first) ensures FTP shards are exercised as repair inputs, not just as
# trailing extras.

SCENARIO_NAME="hybrid local/ftp interleaved + repair"
SCENARIO_DESC="local,ftp,local,ftp 3/1; lose a local shard, RS-repair via FTP"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs21"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local ftp local ftp   # p0 L · p1 F · p2 L · p3 F

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Lose the local shard at p2 (middle of the layout). The surviving 3 of 4 —
  # p0 (local), p1 (ftp), p3 (ftp) — reconstruct it, so the repair path must
  # download two FTP shards.
  rm "$(shard_file 2 1)"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
