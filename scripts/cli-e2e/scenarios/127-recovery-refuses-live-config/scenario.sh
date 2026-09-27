# shellcheck shell=bash
# `bfs recovery` rebuilds .bfs/ for a directory that has lost it. Run in a
# directory whose .bfs/config.json still describes a backup, it would replace
# that configuration - the provider settings and the link to every version -
# and leave the old manifests behind as orphans. So it refuses whenever the
# file holds a readable configuration, whoever's backup that is, and it refuses
# before it writes anything: recovery empties .bfs/cache as its first step, and
# the cache is where `bfs push --cache` resumes an interrupted push from.
#
# A configuration that cannot be read is not a backup anyone can use, so an
# empty or unparsable file - or a .bfs/ left behind by an interrupted run -
# lets recovery start over. That is what keeps a failed recovery retryable.
#
# The advice has to work in the state it is printed in. The refusal names three
# ways out and all of them are followed here - the third one, recovering into
# another directory, is the only one that serves an operator who came for a
# DIFFERENT backup: the other two act on the one that is already here. A push
# after a recovery without --trust-locations refuses too, and its advice - redo
# the recovery with the flag - meets the refusal above unless it says to delete
# .bfs/ first.

SCENARIO_NAME="recovery refuses a directory that holds a backup"
SCENARIO_DESC="3L 2/1; recovery over a live config refuses and touches nothing; advice and leftovers-control followed"
REQUIRES_LOCAL=6
REQUIRES_FTP=0

# Removes everything in the working tree except .bfs/, so a restore has to
# bring every file back.
_wipe_tree() {
  find "$1" -mindepth 1 -maxdepth 1 ! -name .bfs -exec rm -rf {} +
}

_sha() { sha256sum "$1" | cut -d' ' -f1; }

scenario_run() {
  local vault="$SC_DIR/vault" other="$SC_DIR/other" name="bfs127" other_name="bfs127b"
  local baseline="$SC_DIR/baseline.txt" other_boot a_boot

  # -- A second backup, with media of its own -----------------------------------
  build_pool "$SC_DIR/b" 3 0 "$other_name"
  other_boot="$(winpath "${PV_LOCALDIR[0]}")"
  make_fixtures "$other"
  run_bfs "$other" init "$other_name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$other" push --new
  assert_ok

  # -- The backup that lives in the directory under test -----------------------
  build_pool "$SC_DIR/a" 3 0 "$name"
  a_boot="$(winpath "${PV_LOCALDIR[0]}")"
  make_fixtures "$vault"
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  snapshot_hashes "$vault" "$baseline"

  # A file in the cache stands for an interrupted push waiting to resume.
  mkdir -p "$vault/.bfs/cache"
  printf 'pending' >"$vault/.bfs/cache/sentinel"
  local cfg state man
  cfg="$(_sha "$vault/.bfs/config.json")"
  state="$(_sha "$vault/.bfs/state.json")"
  man="$(_sha "$vault/.bfs/manifests/v001.json")"

  # -- Recovery of the same backup, over its live configuration ----------------
  run_bfs "$vault" recovery --provider local --name "$name" --bootstrap "--path $a_boot"
  assert_fail
  assert_out_contains "already holds a backup named \"$name\""
  assert_out_contains 'bfs pull'
  assert_out_contains 'delete the .bfs directory'
  assert_out_contains 'in another directory'
  assert_file "$vault/.bfs/cache/sentinel"
  [ "$(_sha "$vault/.bfs/config.json")" = "$cfg" ] || _fail "config.json changed by a refused recovery"
  [ "$(_sha "$vault/.bfs/state.json")" = "$state" ] || _fail "state.json changed by a refused recovery"
  [ "$(_sha "$vault/.bfs/manifests/v001.json")" = "$man" ] || _fail "v001.json changed by a refused recovery"

  # -- Recovery of another backup into this directory --------------------------
  # The refusal names the backup that is HERE, not the one asked for.
  run_bfs "$vault" recovery --provider local --name "$other_name" --bootstrap "--path $other_boot"
  assert_fail
  assert_out_contains "already holds a backup named \"$name\""
  assert_file "$vault/.bfs/cache/sentinel"
  [ "$(_sha "$vault/.bfs/config.json")" = "$cfg" ] || _fail "config.json changed by a refused recovery of another backup"
  [ "$(_sha "$vault/.bfs/state.json")" = "$state" ] || _fail "state.json changed by a refused recovery of another backup"
  # Both backups have only v001, so the other one's manifest would land under
  # the same name - compare the bytes, not the listing.
  [ "$(_sha "$vault/.bfs/manifests/v001.json")" = "$man" ] || _fail "v001.json replaced by a refused recovery of another backup"

  # -- Advice 1: recover into another directory ---------------------------------
  # The way out for an operator who came for the other backup: it lands there,
  # and the backup living here is not touched.
  local elsewhere="$SC_DIR/elsewhere"
  mkdir -p "$elsewhere"
  run_bfs "$elsewhere" recovery --provider local --name "$other_name" --bootstrap "--path $other_boot"
  assert_ok
  assert_file "$elsewhere/.bfs/config.json"
  assert_file "$vault/.bfs/cache/sentinel"
  [ "$(_sha "$vault/.bfs/config.json")" = "$cfg" ] || _fail "config.json changed by a recovery into another directory"

  # -- Advice 2: work with the backup through its own commands ------------------
  _wipe_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$baseline"

  # -- Advice 3: delete .bfs/ and run recovery again ----------------------------
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" --bootstrap "--path $a_boot"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  _wipe_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$baseline"

  # -- Positive controls: what is left behind is not a configuration -----------
  # A run interrupted before its last step leaves manifests, state and cache
  # but no config.json.
  rm -f "$vault/.bfs/config.json"
  run_bfs "$vault" recovery --provider local --name "$name" --bootstrap "--path $a_boot"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  : >"$vault/.bfs/config.json"
  run_bfs "$vault" recovery --provider local --name "$name" --bootstrap "--path $a_boot"
  assert_ok
  printf '{"vault_na' >"$vault/.bfs/config.json"
  run_bfs "$vault" recovery --provider local --name "$name" --bootstrap "--path $a_boot"
  assert_ok

  # -- A push after recovery without --trust-locations -------------------------
  # Nobody is there to confirm the recovered locations, so push refuses and
  # points at redoing the recovery with the flag - which, in this directory,
  # only works once .bfs/ is gone.
  mutate_fixtures "$vault"
  run_bfs "$vault" push --new
  assert_fail
  assert_out_contains 'delete the .bfs directory here and redo the recovery'
  run_bfs "$vault" recovery --provider local --name "$name" --bootstrap "--path $a_boot" --trust-locations
  assert_fail
  assert_out_contains "already holds a backup named \"$name\""

  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" --bootstrap "--path $a_boot" --trust-locations
  assert_ok
  snapshot_hashes "$vault" "$baseline"
  run_bfs "$vault" push --new
  assert_ok
  _wipe_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$baseline"
  return 0
}
