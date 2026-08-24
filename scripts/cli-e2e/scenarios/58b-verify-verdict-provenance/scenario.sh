# shellcheck shell=bash
# A verdict reached by reading the payload must not be erased by a check that
# never looked at the payload - and only such a verdict may be sticky.
#
# `verifyVersion` (src/vault/verify.ts) writes manifest.health unconditionally and
# records nothing about how the verdict was reached, so the cheap header-window
# check overwrites the expensive payload check. Since the shallow check cannot
# observe rot at all, the stored state flips back to healthy and the evidence
# that the backup is unrecoverable is gone.
#
# The stickiness must be narrow: only detected payload rot survives a shallow
# pass. A part that was merely unreachable (medium offline, file temporarily
# gone) must NOT freeze a damaged verdict - otherwise a deep check run during an
# outage forces the operator to pull the whole backup over the network again just
# to clear a verdict that no longer describes reality.
#
# Layout: 3 LOCAL providers, 2 data + 1 parity, unencrypted. Sound copies of the
# parts are kept aside so the rot can be undone, proving a later deep check does
# clear the verdict once the data is sound again.

SCENARIO_NAME="deep verdict survives a shallow verify; an unreachable part does not freeze it"
SCENARIO_DESC="only detected payload rot is sticky, and a later deep check can clear it"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs58b" keep="$SC_DIR/sound"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard.ts"

  make_fixtures "$vault"
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 3 0 "$name"
  mkdir -p "$keep"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  cp "$(shard_file 0 1)" "$keep/shard_0"
  cp "$(shard_file 1 1)" "$keep/shard_1"

  # -- An unreachable part must not freeze the verdict --------------------------
  mv "$(shard_file 2 1)" "$keep/shard_2_away"
  run_bfs "$vault" --lang en verify --deep
  assert_exit 4
  assert_manifest_health "$vault" 1 degraded

  mv "$keep/shard_2_away" "$(shard_file 2 1)"
  run_bfs "$vault" --lang en verify
  assert_exit 0
  assert_manifest_health "$vault" 1 healthy

  # -- Detected payload rot must survive a shallow pass -------------------------
  local i
  for i in 0 1; do
    BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$(shard_file "$i" 1)")" 2>&1)" || true
    printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED" || _fail "corrupt driver failed on shard_$i: $BFS_OUT"
  done

  run_bfs "$vault" --lang en verify --deep
  assert_exit 5
  assert_manifest_health "$vault" 1 damaged

  run_bfs "$vault" --lang en verify
  assert_exit 5
  assert_manifest_health "$vault" 1 damaged
  # The operator must learn why a header-only check reports damage, and how to re-check.
  assert_out_contains "earlier deep check"

  # -- Once the data is sound again, a deep check clears the verdict ------------
  cp "$keep/shard_0" "$(shard_file 0 1)"
  cp "$keep/shard_1" "$(shard_file 1 1)"
  run_bfs "$vault" --lang en verify --deep
  assert_exit 0
  assert_manifest_health "$vault" 1 healthy

  return 0
}
