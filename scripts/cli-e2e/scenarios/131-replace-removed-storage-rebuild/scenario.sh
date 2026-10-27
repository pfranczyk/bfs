# shellcheck shell=bash
# A storage dropped with `bfs provider remove --strategy remove` is replaced by a
# NEW, EMPTY one, and the version that recorded the old storage comes back to
# full health on it.
#
# The route is the one an operator reaches by themselves: the pool is short of
# the scheme, so it is matched to the survivors, the replacement is added, and
# the scheme goes back to what it was. The replacement goes in BEFORE any push -
# a storage already holding a part of a newer version is no longer free, and a
# name can only be brought back onto a free one.
#
# What this pins is the last step. The replacement is empty, so bringing the
# recorded name onto it is not a relocation: the part has to be reconstructed
# from the remaining ones. That is one command, and it is executed here rather
# than matched - a migration that renames the entry and leaves the part unbuilt
# reports success while leaving the version exactly as degraded as it was.

SCENARIO_NAME="a removed storage is replaced and the version that lost it is rebuilt"
SCENARIO_DESC="4L 3/1; remove -> scheme set -> add -> scheme set; one repair reconstructs the lost part onto the empty replacement"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs131" b1="$SC_DIR/v1.txt" spare="$SC_DIR/spare"
  make_fixtures "$vault"
  # 4 media at 3/1: the floor `--strategy remove` accepts without --force, and 2/1 is then the
  # only legal scheme for the 3 survivors.
  build_pool "$SC_DIR" 4 0 "$name"
  mkdir -p "$spare"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- The storage is gone, and with it the version's redundancy --------------
  run_bfs "$vault" provider remove p3 --strategy remove --yes
  assert_ok
  # The removal itself names the way back to a pool the scheme accepts.
  assert_out_contains 'bfs scheme set <N> <K>'
  assert_config_no_provider "$vault" p3
  assert_manifest_health "$vault" 1 degraded

  # -- Back to a pool the scheme accepts --------------------------------------
  run_bfs "$vault" scheme set 2 1
  assert_ok

  # -- The replacement, while it can still be free ----------------------------
  run_bfs "$vault" provider add --ci --name p4 --type local --path "$(winpath "$spare")"
  assert_ok
  assert_config_provider "$vault" p4
  # `provider add` raises parity, so the original scheme is restored by hand -
  # the pool is 4 again, which is exactly what 3/1 requires.
  run_bfs "$vault" scheme set 3 1
  assert_ok

  # -- The state before the repair ---------------------------------------------
  # A free entry stands where the lost storage was, and the backup still names
  # that storage under the version that lost it.
  run_bfs "$vault" verify
  assert_exit 4
  assert_out_contains 'Version v001 - Storage recorded in this backup but absent from the configuration: p3.'

  # -- A/B on the flag itself --------------------------------------------------
  # Without `--rebuild` the same pair is refused: a migration relocates a part it
  # expects to find, and the replacement has none. This is what makes the flag
  # load-bearing rather than decoration.
  run_bfs "$vault" repair --version all p4 "local:p3 --path $(winpath "$spare")"
  assert_fail
  assert_manifest_health "$vault" 1 degraded

  # -- Executed, in one command ------------------------------------------------
  run_bfs "$vault" repair --version all --rebuild p4 "local:p3 --path $(winpath "$spare")"
  assert_ok

  # The part is on the replacement and the version is whole again. Both are
  # asserted: a run that renamed the entry without reconstructing the part
  # reports success and leaves the version degraded.
  assert_file "$spare/$name/shard_3.bfs.1"
  run_bfs "$vault" verify
  assert_exit 0
  assert_manifest_health "$vault" 1 healthy

  # -- Binding proof that the rebuilt part carries the data -------------------
  # One sibling is taken away, so the restore cannot reach the file contents
  # without reading what was just reconstructed.
  rm -f "${PV_LOCALDIR[0]}/$name/shard_0.bfs.1"
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/hello.txt"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$b1"
  return 0
}
