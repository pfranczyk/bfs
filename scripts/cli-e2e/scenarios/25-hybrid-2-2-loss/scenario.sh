# shellcheck shell=bash
# Hybrid 2/2 at maximum tolerance: interleaved local,ftp,local,ftp; lose BOTH
# local shards (= K=2, the limit). Exactly N=2 shards survive — and both are on
# FTP — so reconstruction must download both FTP shards. Strong boundary test.

SCENARIO_NAME="hybrid 2/2, lose 2 (both local)"
SCENARIO_DESC="local,ftp,local,ftp; drop 2 local shards, repair from 2 FTP"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs25"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local ftp local ftp   # p0 L · p1 F · p2 L · p3 F

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 2 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Lose both local shards (p0, p2) — K=2 tolerance fully consumed; only the two
  # FTP shards (p1, p3) remain to reconstruct from.
  rm "$(shard_file 0 1)"
  rm "$(shard_file 2 1)"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
