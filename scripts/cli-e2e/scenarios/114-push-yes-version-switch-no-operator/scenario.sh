# shellcheck shell=bash
# A push whose working copy sits on an older version than the latest reaches the
# version-switch confirmation. In a run with no operator - cron, closed stdin -
# that question can never be answered, so without consent the push refuses and
# names `bfs push --yes`. It must NOT name `bfs pull`: getting past pull's own
# confirmation overwrites the working directory, the single source of truth, so
# advice pointing there would trade a refused push for lost work.
#
# `--yes` carries the consent up front, so the same unattended run finishes:
# it creates the new version from the older working copy, and that version
# restores byte-for-byte. run_bfs feeds stdin from /dev/null, so every push here
# is genuinely non-interactive - the state the flag exists for.
#
# ftp/ssh: N/A - the gate is BFS's own and identical whatever the storage is.

SCENARIO_NAME="push --yes consents to the version switch with no operator"
SCENARIO_DESC="working copy on an older version: push refuses naming --yes (never bfs pull), push --yes completes and restores byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" name="bfs114"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  # v1 (baseline captured), then v2 so the latest runs ahead of the working copy.
  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new
  assert_ok
  mutate_fixtures "$vault"
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2

  # Drop the working copy back to v1: now working(1) < latest(2), the gate state.
  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$b1"
  assert_state "$vault" working_version 1

  # -- no consent, no operator: the push must refuse and name its own flag ------
  run_bfs "$vault" push
  assert_fail
  assert_out_contains "--yes"
  # ...and never `bfs pull`, whose confirmation would overwrite the working dir.
  if printf '%s' "$BFS_OUT" | grep -qF "bfs pull"; then
    _fail "push refusal sent the operator to bfs pull instead of push --yes"
  fi
  # The refusal changed nothing: no new version, working copy still on v1.
  assert_state "$vault" latest_version 2
  assert_state "$vault" working_version 1

  # -- the advice works: --yes finishes the same unattended push ---------------
  run_bfs "$vault" push --yes
  assert_ok
  assert_state "$vault" latest_version 3
  assert_state "$vault" working_version 3

  # The new version really carries the v1 working copy, and restores byte-for-byte.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$b1"
  return 0
}
