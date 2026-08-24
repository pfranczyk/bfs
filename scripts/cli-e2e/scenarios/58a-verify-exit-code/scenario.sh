# shellcheck shell=bash
# `bfs verify` must carry its verdict in the exit code, not only in the table.
#
# A scheduled check is the main way an operator learns a backup rotted. Today
# registerVerify (src/cli/commands/verify.ts) prints the table and returns, so a
# damaged backup exits 0 and cron sees a success - the one signal automation can
# act on says nothing is wrong.
#
# Codes are distinct from the generic failure (CommandAbort default 1, used for
# "the command could not run"), so automation can tell "verify ran and the backup
# is degraded" from "verify itself failed": 0 healthy, 4 degraded, 5 damaged.
#
# Layout: 3 LOCAL providers, 2 data + 1 parity, unencrypted. One rotted part
# leaves the version restorable (degraded); a second drops it below N (damaged).

SCENARIO_NAME="verify exit code carries the health verdict"
SCENARIO_DESC="0 healthy / 4 degraded / 5 damaged, so a scheduled check can alarm"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs58a"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard.ts"

  make_fixtures "$vault"
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok

  run_bfs "$vault" --lang en verify
  assert_exit 0

  # One rotted part: still restorable from the remaining two.
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$(shard_file 0 1)")" 2>&1)" || true
  printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED" || _fail "corrupt driver failed on shard_0: $BFS_OUT"

  run_bfs "$vault" --lang en verify --deep
  assert_exit 4
  assert_manifest_health "$vault" 1 degraded

  # A second rotted part drops the version below N - unrecoverable.
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$(shard_file 1 1)")" 2>&1)" || true
  printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED" || _fail "corrupt driver failed on shard_1: $BFS_OUT"

  run_bfs "$vault" --lang en verify --deep
  assert_exit 5
  assert_manifest_health "$vault" 1 damaged

  return 0
}
