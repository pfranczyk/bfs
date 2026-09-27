# shellcheck shell=bash
# A recovery nobody is watching cannot show the operator the FTP host a
# password is about to reach, so it sends none and skips that storage - and says
# how to get it back: check the recovered locations and redo the recovery with
# --trust-locations. That run ends by writing .bfs/config.json, and recovery
# refuses a directory that holds a configuration, so the advice only works when
# it says to delete .bfs/ first. Both halves are followed here: the redo in
# place is refused, and the redo after deleting .bfs/ reaches the FTP storage -
# proven by a restore that needs its part.

SCENARIO_NAME="FTP recovery without an operator: advice works as printed"
SCENARIO_DESC="local,local,ftp 2/1; recovery without --trust-locations skips FTP, advice (delete .bfs/, redo) followed"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

_wipe_tree() {
  find "$1" -mindepth 1 -maxdepth 1 ! -name .bfs -exec rm -rf {} +
}

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs128"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 is FTP

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # -- Recovery with nobody to confirm the FTP host ------------------------------
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider ftp --name "$name" --bootstrap "$(ftp_bootstrap_spec 2)"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_out_contains 'Nobody can confirm that'
  assert_out_contains 'delete the .bfs directory here and redo the recovery'
  if printf '%s' "$BFS_OUT" | grep -qE 'then redo the recovery with|or run it at a terminal'; then
    _fail "the advice still sends the operator to redo the recovery in place:
$BFS_OUT"
  fi

  # -- Redoing it in place meets the refusal --------------------------------------
  run_bfs "$vault" recovery --provider ftp --name "$name" --bootstrap "$(ftp_bootstrap_spec 2)" --trust-locations
  assert_fail
  assert_out_contains "already holds a backup named \"$name\""

  # -- Following the advice as printed ------------------------------------------
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider ftp --name "$name" --bootstrap "$(ftp_bootstrap_spec 2)" --trust-locations
  assert_ok
  if printf '%s' "$BFS_OUT" | grep -qF 'Nobody can confirm'; then
    _fail "with the locations approved the FTP storage must not be skipped:
$BFS_OUT"
  fi
  assert_manifest_health "$vault" 1 healthy

  # The restore needs the FTP part: one of the two local parts is gone.
  rm "$(shard_file 1 1)"
  _wipe_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
  return 0
}
