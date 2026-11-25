# shellcheck shell=bash
# `bfs config` takes several settings in one command. Every setting typed is
# applied, and the output lists what was set - including when --on / --off
# stands next to a directory, RAM or push-mode setting. A setting that is
# dropped while the command reports success is found out only by its effect:
# the next push writes where it was told not to, or overwrites the version the
# operator meant to keep.
#
# Binding assertions: after `--on compress --temp-dir <dir>` the next push is
# compressed AND uses that temp dir; after `--off compress --push-mode
# overwrite` the next push replaces the current version instead of adding one,
# uncompressed; one invalid value refuses the whole command and leaves
# config.json byte-identical; the restore matches the snapshot byte-for-byte.

SCENARIO_NAME="config: --on/--off next to other settings applies all of them"
SCENARIO_DESC="3L 2/1; config --on + --temp-dir, then --off + --push-mode overwrite, each proven by the next push; an invalid value refuses all"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs150"
  local goodtemp="$SC_DIR/good-temp"
  local cfg="$vault/.bfs/config.json" cfgcopy="$SC_DIR/config-before.json"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 1
  assert_manifest_absent "$vault" 1 '"compressed": true'

  # -- --on next to a directory setting ---------------------------------------
  run_bfs "$vault" config --on compress --temp-dir "$(winpath "$goodtemp")"
  assert_ok
  if ! grep -q '"temp_dir": ".*good-temp"' "$cfg"; then
    _fail "a temp dir typed next to --on must reach config.json:
$(cat "$cfg")"
  fi
  assert_out_matches 'Settings updated:'
  assert_out_matches 'temp-dir:.*good-temp'
  assert_out_matches 'compression:[[:space:]]+enabled'

  # `bfs config` does not create the leaf, so its presence after push proves
  # the push used the stored temp dir.
  if [ -d "$goodtemp" ]; then
    _fail "the temp dir must not exist before the push that uses it: $goodtemp"
  fi
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2
  assert_manifest_contains "$vault" 2 '"compressed": true'
  assert_dir "$goodtemp"

  # -- --off next to the push mode ---------------------------------------------
  run_bfs "$vault" config --off compress --push-mode overwrite
  assert_ok
  assert_out_matches 'push-mode:[[:space:]]+overwrite'
  assert_out_matches 'compression:[[:space:]]+disabled'

  # Plain push: the stored mode decides. Overwrite keeps the version number and
  # replaces version 2 - uncompressed, since compression was switched off.
  run_bfs "$vault" push --yes
  assert_ok
  assert_state "$vault" latest_version 2
  assert_manifest_absent "$vault" 2 '"compressed": true'

  # -- One invalid value refuses the whole command -----------------------------
  cp "$cfg" "$cfgcopy"
  run_bfs "$vault" config --on compress --push-mode OVERWRITE
  assert_exit 1
  assert_out_contains 'Invalid --push-mode: "OVERWRITE"'
  if ! cmp -s "$cfg" "$cfgcopy"; then
    _fail "a refused command must leave config.json untouched - compression included:
$(cat "$cfg")"
  fi

  # -- The settings did not disturb the backup ---------------------------------
  snapshot_hashes "$vault" "$base"
  mutate_fixtures "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
