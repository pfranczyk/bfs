# shellcheck shell=bash
#
# verify is blind to payload rot; `verify --deep` must catch it (path D2, local).
#
# Shallow `bfs verify` only inspects each shard's HEADER window - a
# length-preserving bit-flip in the PAYLOAD (past the header, before the
# trailing SHA-256) leaves the header intact, so shallow verify keeps reporting
# healthy. `bfs verify --deep` streams the whole shard and checks its trailing
# SHA-256, demoting the rotted data-shard to unavailable.
#
# Scheme 2/1 with one corrupt data-shard leaves exactly N=2 healthy shards =>
# degraded (still recoverable) - the health deep verify records after demoting
# the rotted shard.

SCENARIO_NAME="verify --deep catches payload rot (local)"
SCENARIO_DESC="header-intact payload bit-flip: shallow verify stays healthy, --deep must degrade"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs48"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard.ts"

  make_fixtures "$vault"
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok

  # Baseline: all 3 shards present and header-consistent -> healthy.
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Corrupt ONE data-shard's PAYLOAD in place (length-preserving bit-flip in the
  # middle, past the ~70B header and before the trailing 32B SHA-256). The header
  # stays byte-valid, so only a full-payload check can notice. Shard 0 is a data
  # shard (0..N-1); shards 1 (data) + 2 (parity) stay healthy.
  local shard0
  shard0="$(shard_file 0 1)"
  assert_file "$shard0"
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard0")" 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED"; then
    _fail "corrupt-shard driver did not report success: $BFS_OUT"
  fi

  # Shallow verify is header-only -> blind to the payload rot -> stays healthy.
  # (This assertion stays GREEN even after deep verify lands - proof the shallow
  # path legitimately cannot see payload corruption.)
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Deep verify streams the shard, fails its trailing SHA-256, drops shard 0 to
  # unavailable, and records degraded (2 of 3 = exactly N, still recoverable).
  run_bfs "$vault" verify --deep
  assert_exit 4
  assert_manifest_health "$vault" 1 degraded
}
