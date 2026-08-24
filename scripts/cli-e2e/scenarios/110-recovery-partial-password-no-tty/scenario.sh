# shellcheck shell=bash
# Recovery of a backup whose versions carry DIFFERENT encryption passwords, run
# where nobody can answer a prompt (stdin closed - cron, CI, a pipeline). The
# password given opens the newest version; the older one cannot be opened, so it
# is skipped. Skipping a version must not cost the recovery: `.bfs/` has to end
# up complete (config + state + the manifests that were readable) and `pull`
# must restore what was recovered, byte for byte.
#
# The binding assertions are the rebuilt config/state and the SHA-256 roundtrip;
# the exit code alone proves nothing here, because the run reports success
# either way. The negative assertion pins the cause: a run with no terminal must
# not ask for the password at all - an unanswerable prompt empties the event
# loop and the process dies mid-recovery.

SCENARIO_NAME="recovery, older version's password missing, no terminal"
SCENARIO_DESC="two passwords, one supplied, stdin closed - .bfs/ still complete"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs110"
  local pw_old="old-secret-110" pw_new="new-secret-110"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  run_bfs "$vault" push --new --password "$pw_old"   # v1, old password
  assert_ok

  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new --password "$pw_new"   # v2, new password
  assert_ok

  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Only the newer password is supplied. run_bfs feeds stdin from /dev/null, so
  # this is a run with nobody at the keyboard.
  run_bfs "$vault" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")" --password "$pw_new"
  assert_ok

  # v1 is skipped and said so; v2 is rebuilt.
  assert_out_contains 'Version 1 skipped'
  assert_file "$vault/.bfs/manifests/v002.json"

  # The recovery has to leave a usable .bfs/, not a half-written one.
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/state.json"
  assert_state "$vault" latest_version 2

  # Nobody could answer, so nothing may be asked. Pinning the absence of the
  # prompt is what separates the fix from its symptom.
  if printf '%s' "$BFS_OUT" | grep -qF 'Enter password for version'; then
    _fail "recovery asked for a password with no terminal to answer it:
$BFS_OUT"
  fi

  # And what it recovered must restore byte for byte.
  run_bfs "$vault" pull --force --yes --password "$pw_new"
  assert_ok
  assert_restored "$vault" "$base"
}
