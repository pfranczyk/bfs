# shellcheck shell=bash
# .bfs/state.json records which version the working directory holds and the
# highest version on the media - push numbers the next version from it. A
# process that dies while writing it must leave either the old content or the
# new one: a file cut in half is no longer JSON, and every later command that
# reads the state stops on a parser error.
#
# The death is injected into the real CLI (lib/fs-crash-hooks.mjs): the write
# lands half of its bytes and the process ends on the spot, with no chance to
# clean up or report. Sibling of 132b, which does the same to config.json -
# kept apart so a regression in one writer cannot hide the other.
#
# Binding assertions: the interrupted pull dies with the injected exit code
# (so the death really happened inside that write); afterwards the CLI still
# reads its state, the interrupted change is simply not there, and the backup
# keeps working - a restore ends in a byte-for-byte round trip.

SCENARIO_NAME="state: a process killed mid-write leaves state.json readable"
SCENARIO_DESC="3L 2/1 --no-enc; pull killed halfway through writing state.json -> old state survives, restore round-trips"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="crashstate"
  local work="$SC_DIR/work"
  mkdir -p "$work"

  build_pool "$SC_DIR" 3 0 "$vault"
  make_fixtures "$work"

  run_bfs "$work" init "$vault" --ci --no-enc --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$work" push
  assert_ok

  mutate_fixtures "$work"
  snapshot_hashes "$work" "$SC_DIR/v2.txt"
  run_bfs "$work" push
  assert_ok
  assert_state "$work" latest_version 2

  # --- The pull that dies while recording the version it restored ------------
  run_bfs_crashing_on state.json "$work" pull --version 1 --yes
  assert_exit "$CRASH_EXIT"

  run_bfs "$work" status
  assert_ok
  # The interrupted pull never got to record version 1, so the state still
  # describes what was there before it.
  assert_state "$work" latest_version 2
  assert_state "$work" working_version 2

  # --- The backup keeps working ------------------------------------------------
  wipe_working_tree "$work"
  run_bfs "$work" pull --version 2 --yes
  assert_ok
  assert_restored "$work" "$SC_DIR/v2.txt"
  assert_state "$work" working_version 2

  return 0
}
