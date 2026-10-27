# shellcheck shell=bash
# Pull overwrites the working directory, so a run with no operator must not take
# that step on its own when the directory holds files. After recovery the state
# is working_version 0 with the operator's files still on disk - and the gate
# that decides the prompt keys on the directory's CONTENTS, not on working_version.
#
# The files on disk are made to differ from every version on the storage (an
# edit that is never pushed - `mutate_fixtures` writes the same bytes each time,
# so it cannot provide one), which makes an overwrite observable: a refused pull
# leaves the unpushed content, and a pull that overwrote would bring v2 back.
#
# Binding assertions: `pull --ci` fails, speaks of the files in the working
# directory (not of a version on disk) and points at --yes, and the unpushed
# content survives byte-for-byte. Positive control: `pull --ci --yes` gives
# consent and restores the newest version, so the refusal is specifically about
# missing consent.

SCENARIO_NAME="pull refuses to overwrite a directory of files with no operator"
SCENARIO_DESC="after recovery (working_version 0, files on disk), pull --ci refuses until --yes"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b2="$SC_DIR/v2.txt" b3="$SC_DIR/v3.txt" name="bfs135"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  run_bfs "$vault" push --new; assert_ok          # v1
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$b2"
  run_bfs "$vault" push --new; assert_ok          # v2 (the newest on the storage)

  # An edit that is never pushed: the files on disk now match no version on the
  # storage, so restoring the newest one over them would be visible.
  printf 'local edit, never pushed\n' >"$vault/hello.txt"
  snapshot_hashes "$vault" "$b3"
  if cmp -s "$b2" "$b3"; then _fail "the unpushed edit must differ from v2, or the overwrite check proves nothing"; fi

  # Catastrophe: lose .bfs/ and rebuild it. Recovery leaves working_version 0 and
  # does not touch the working files, so the unpushed content stays on disk.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  # No operator, files on disk: pull must refuse rather than overwrite them.
  run_bfs "$vault" pull --ci
  assert_fail
  assert_out_contains "overwriting the files in the working directory"
  assert_out_contains "--yes"
  assert_restored "$vault" "$b3"   # the unpushed content is untouched

  # Positive control: consent given up front restores the newest version.
  run_bfs "$vault" pull --ci --yes
  assert_ok
  assert_restored "$vault" "$b2"
}
