# shellcheck shell=bash
# `bfs init` in a directory that ALREADY describes a backup must refuse, instead
# of replacing its configuration.
#
# The one guard on this path (assertNoForeignVault) looks at the MEDIA, under the
# sub-directory named after the backup being created - so a second init under a
# DIFFERENT name finds that sub-directory empty, has nothing to report, and lets
# the run through. Nothing examines the working directory itself.
#
# What the operator loses when it goes through: config.json is rewritten with a
# fresh vault_id, state.json drops back to version 0, and the first backup's
# manifests stay behind describing versions the new configuration does not claim.
# The shards on the media still carry the OLD vault_id, so this directory no
# longer reaches the data it pushed a moment earlier.
#
# Correct: abort non-zero, config.json and state.json untouched, and the data
# pushed before the second init still restorable from this directory.

SCENARIO_NAME="init refuses a directory that already holds a backup"
SCENARIO_DESC="second init under a different name must not replace the existing configuration"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local ws="$SC_DIR/ws" baseline="$SC_DIR/baseline.txt"
  mkdir -p "$ws"
  make_fixtures "$ws"

  build_pool "$SC_DIR" 3 0 "docs"

  run_bfs "$ws" init "docs" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$ws" "$baseline"
  run_bfs "$ws" push --new
  assert_ok
  assert_file "$(shard_file 0 1)"
  assert_state "$ws" "latest_version" "1"

  local id_before
  id_before="$(grep -o '"vault_id": "[^"]*"' "$ws/.bfs/config.json")"
  [ -n "$id_before" ] || _fail "fixture must record a vault_id in config.json"

  # A DIFFERENT backup name, same media: the sub-directory that name resolves to
  # is empty, so the foreign-vault guard finds no evidence and stands aside. This
  # is the opening the working directory has no guard of its own to close.
  run_bfs "$ws" init "photos" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_fail

  # The refusal has to name what is in the way - the backup already here - and
  # not send the operator to `bfs clear`, which removes cache and locks and would
  # leave config.json exactly where it is.
  assert_out_contains "docs"
  # ...and it has to name a way out. The run below executes exactly this one, so
  # the pair is a positive proof rather than two facts standing side by side.
  assert_out_matches "another directory|innym katalogu"

  # Identity, name and version history all survive: this directory still
  # describes the SAME backup it did before the refused init.
  local id_after
  id_after="$(grep -o '"vault_id": "[^"]*"' "$ws/.bfs/config.json")"
  [ "$id_after" = "$id_before" ] || _fail "vault_id changed across a refused init:
  before: $id_before
  after:  $id_after"
  grep -q '"vault_name": "docs"' "$ws/.bfs/config.json" ||
    _fail "vault_name no longer 'docs'. Got: $(grep '"vault_name"' "$ws/.bfs/config.json" || echo '<none>')"
  assert_state "$ws" "latest_version" "1"
  assert_file "$ws/.bfs/manifests/v001.json"

  # The media must be untouched too: probing creates the target sub-directory,
  # so a refusal that ran the media loop first would leave "photos/" behind on
  # every one of them.
  assert_no_file "${PV_LOCALDIR[0]}/photos"
  assert_no_file "${PV_LOCALDIR[1]}/photos"
  assert_no_file "${PV_LOCALDIR[2]}/photos"

  # The binding proof: the data is still reachable FROM THIS DIRECTORY. A
  # config.json that merely looks intact would not establish that. Everything
  # except .bfs/ goes, so the check covers whatever make_fixtures lays down -
  # including the Unicode path a hand-written list would drift away from.
  find "$ws" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$ws" pull --version 1 --force
  assert_ok
  assert_restored "$ws" "$baseline"

  # Executing the way out the refusal just named: it has to actually work, or the
  # advice is worse than none.
  local fresh="$SC_DIR/fresh"
  mkdir -p "$fresh"
  run_bfs "$fresh" init "photos" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_file "$fresh/.bfs/config.json"
}
