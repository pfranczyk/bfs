# shellcheck shell=bash
# init must REFUSE a target location that already holds a DIFFERENT backup of the
# same name (foreign vault_id). Machine A inits + pushes "docs" to three media;
# machine B (fresh .bfs/) then inits "docs" pointing at the SAME media. Without
# the write-path guard B's init succeeds, minting a second vault_id whose next
# push would silently overwrite A's shards — the collision only surfaces later at
# read time. Correct: abort exit!=0, no config.json for B.

SCENARIO_NAME="init aborts on foreign backup at target location"
SCENARIO_DESC="second init onto an occupied location (same name) must abort, not create a colliding vault"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local name="docs" wsA="$SC_DIR/A" wsB="$SC_DIR/B"
  mkdir -p "$wsA" "$wsB"
  make_fixtures "$wsA"

  build_pool "$SC_DIR" 3 0 "$name"

  # ── Machine A: init + push — shards land in the shared media ───────────────
  run_bfs "$wsA" init "$name" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$wsA" push --new
  assert_ok
  assert_file "$(shard_file 0 1)"

  # ── Machine B: fresh .bfs/, SAME media + SAME name → foreign vault present ──
  run_bfs "$wsB" init "$name" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_fail
  assert_no_file "$wsB/.bfs/config.json"
  # A's shard is still present (init never uploads, but confirm nothing was lost).
  assert_file "$(shard_file 0 1)"
}
