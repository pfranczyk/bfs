# shellcheck shell=bash
# .bfs/config.json holds the backup's settings and every storage location. A
# process that dies while writing it must leave either the old content or the
# new one: a file cut in half is no longer JSON, every later command stops on a
# parser error, and the only way back is disaster recovery from the media.
#
# The death is injected into the real CLI (lib/fs-crash-hooks.mjs): the write
# lands half of its bytes and the process ends on the spot, with no chance to
# clean up or report. Sibling of 132, which does the same to state.json.
#
# Binding assertions: the interrupted `bfs config` dies with the injected exit
# code (so the death really happened inside that write); afterwards the CLI
# still reads its configuration, the interrupted setting is simply not there,
# and the configuration still reaches every storage - a fresh push and a
# restore end in a byte-for-byte round trip.

SCENARIO_NAME="config: a process killed mid-write leaves config.json readable"
SCENARIO_DESC="3L 2/1 --no-enc; bfs config killed halfway through writing config.json -> old config survives, push + pull round-trip"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="crashconfig"
  local work="$SC_DIR/work"
  mkdir -p "$work"

  build_pool "$SC_DIR" 3 0 "$vault"
  make_fixtures "$work"

  run_bfs "$work" init "$vault" --ci --no-enc --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$work" push
  assert_ok

  # --- The setting that dies while being saved --------------------------------
  run_bfs_crashing_on config.json "$work" config --max-ram 512
  assert_exit "$CRASH_EXIT"

  run_bfs "$work" config
  assert_ok
  if grep -qF '"max_ram_mb": 512' "$work/.bfs/config.json"; then
    _fail "interrupted config change was recorded"
  fi

  # --- The configuration still reaches every storage ---------------------------
  mutate_fixtures "$work"
  snapshot_hashes "$work" "$SC_DIR/v2.txt"
  run_bfs "$work" push
  assert_ok
  assert_state "$work" latest_version 2

  wipe_working_tree "$work"
  run_bfs "$work" pull --yes
  assert_ok
  assert_restored "$work" "$SC_DIR/v2.txt"

  return 0
}
