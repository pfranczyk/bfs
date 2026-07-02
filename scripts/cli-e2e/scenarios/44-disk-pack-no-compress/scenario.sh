# shellcheck shell=bash
# Happy-path roundtrip that forces the DISK pack path (packBlobToFile), i.e.
# no compression and blob written to .bfs/cache instead of RAM.
#
# Path selection lives in src/vault/push-pipeline.ts (_packFreshBlob): with
# compression off, `useRamPath = estimated < computeRamThreshold(maxRamMb,N,K)`.
# `--max-ram 1` drives resolveRamBudget to 1 MiB; computeRamThreshold subtracts
# the RS overhead ((N+K) × 256 MiB) and clamps at 0, so the threshold is 0 and
# no blob can take the RAM path — packBlobToFile is chosen for any input.
#
# This is a GREEN guard: it proves the disk/no-compress pack path does a clean
# init→push→pull SHA-256 roundtrip, so a later TOCTOU fix on that path cannot
# silently regress it.

SCENARIO_NAME="local 2/1 disk pack (no-compress, forced --max-ram)"
SCENARIO_DESC="init/push --no-compress --max-ram 1 forces packBlobToFile, pull SHA-256 roundtrip"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs44"
  make_fixtures "$vault"
  # A larger file exercises striped reads from the on-disk blob (fd-backed).
  make_large_file "$vault" $((512 * 1024))
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"

  # --max-ram 1 + --no-compress => estimated < threshold(=0) is false => disk path.
  run_bfs "$vault" push --new --no-compress --max-ram 1
  assert_ok
  assert_out_contains "healthy"
  assert_manifest_health "$vault" 1 healthy
  assert_file "$(shard_file 0 1)"
  assert_file "$(shard_file 1 1)"
  assert_file "$(shard_file 2 1)"

  # Full restore over the top of the working tree, byte-for-byte SHA-256 match.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
