# shellcheck shell=bash
# `bfs clear` removes leftovers from interrupted operations: cached pending
# blobs and stale push/repair locks. Mirrors tests/cli/clear.

SCENARIO_NAME="clear pending cache + locks"
SCENARIO_DESC="bfs clear removes pending blobs and lock files"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs14"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok

  # Simulate leftovers from aborted operations.
  mkdir -p "$vault/.bfs/cache"
  : >"$vault/.bfs/cache/push.blob.pending"
  : >"$vault/.bfs/cache/pull.blob.pending"
  : >"$vault/.bfs/push.lock"

  run_bfs "$vault" clear
  assert_ok
  assert_no_file "$vault/.bfs/cache/push.blob.pending"
  assert_no_file "$vault/.bfs/cache/pull.blob.pending"
  assert_no_file "$vault/.bfs/push.lock"
}
