# shellcheck shell=bash
# push must REFUSE to upload over a DIFFERENT backup's shards at the same
# location. Two machines init "docs" against the SAME empty media (both inits
# pass - the location is still empty), then A pushes. Without the write-path
# guard B's push silently OVERWRITES A's shards; the loss only surfaces at read
# time. Correct: B's push aborts and A's shard is byte-identical afterwards.
#
# This is the concurrent-init race the init-time guard cannot catch (both inits
# saw an empty location) - the reason the guard also runs on push.

SCENARIO_NAME="push aborts before overwriting a foreign backup"
SCENARIO_DESC="concurrent-init race: B push onto A's shards must abort, not overwrite"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local name="docs" wsA="$SC_DIR/A" wsB="$SC_DIR/B"
  mkdir -p "$wsA" "$wsB"
  make_fixtures "$wsA"
  make_fixtures "$wsB"
  # Make B's tree distinct so its blob (and shards) differ from A's beyond the
  # differing vault_id - a defensive belt so the overwrite is unmistakable.
  printf 'B-only\n' > "$wsB/b-only.txt"

  build_pool "$SC_DIR" 3 0 "$name"

  # -- Both machines init against the SAME empty media (both pass) ------------
  run_bfs "$wsA" init "$name" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$wsB" init "$name" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  # -- A pushes first - its shards occupy the media --------------------------
  run_bfs "$wsA" push --new
  assert_ok
  assert_file "$(shard_file 0 1)"
  local a_sha
  a_sha="$(sha256sum "$(shard_file 0 1)" | cut -d' ' -f1)"

  # -- B pushes - must abort rather than overwrite A's foreign shards ---------
  run_bfs "$wsB" push --new
  assert_fail
  local after_sha
  after_sha="$(sha256sum "$(shard_file 0 1)" | cut -d' ' -f1)"
  if [ "$a_sha" != "$after_sha" ]; then
    _fail "B's push overwrote A's shard_0 (sha $a_sha -> $after_sha)"
  fi
}
