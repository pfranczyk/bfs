# shellcheck shell=bash
# The payoff of the marker: a version recovery met but could not open is restored
# later, by the operator who finally remembers its password - without another
# recovery pass, and without the password ever being paid for versions nobody
# asks for.
#
# The password opens both the location map and the data, with the same key, so
# `pull` is the natural place to ask for it: the operator reaching for a version
# supplies it anyway. Recovery skips what it cannot open and marks it; `bfs pull
# --version N --password <old>` lists the storages from the config, finds that
# version's parts, opens the map from a header, restores, and only then writes
# the manifest - a run cut short leaves nothing half-written behind.
#
# Binding assertions: SHA-256 of the restored tree against the snapshot taken
# before that version was pushed, the manifest appearing only after success, and
# `bfs versions` no longer calling the version unrecovered.

SCENARIO_NAME="pull rebuilds a version recovery could not open"
SCENARIO_DESC="marker + the remembered password restores the version and completes its manifest"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base_v2="$SC_DIR/baseline-v2.txt" name="bfs117"
  local pw_old="old-secret-117" pw_new="new-secret-117"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  run_bfs "$vault" push --new --password "$pw_old"   # v1, password the operator still knows
  assert_ok

  # v2 carries the rotated password - and its own contents, which is what the
  # restore at the end has to reproduce.
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$base_v2"
  run_bfs "$vault" push --new --password "$pw_new"
  assert_ok

  # The storage bootstrap will read from never received v2, so recovery opens v1
  # and meets v2 only while listing the others.
  rm -f "$(shard_file 0 2)"
  assert_no_file "$(shard_file 0 2)"

  rm -rf "$vault/.bfs"
  run_bfs "$vault" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")" --password "$pw_old" --trust-locations
  assert_ok
  assert_out_contains 'Version 2 skipped'

  # v2 is known but not described: a marker stands where its manifest would be.
  local marker="$vault/.bfs/manifests/v002.json"
  assert_file "$marker"
  if [ "$(tr -d ' \n\r\t' < "$marker")" != "{}" ]; then
    _fail "expected v002 to be an unrecovered-version marker, got: $(cat "$marker")"
  fi

  # A wrong password must be named as such - sending the operator back to
  # `bfs recovery` is the answer from before this path existed, and it would not
  # help: they just handed that password to this very command. And the attempt
  # must leave no half-written manifest behind.
  run_bfs "$vault" --lang en pull --version 2 --force --yes --password "wrong-secret-117"
  assert_fail
  assert_out_contains 'does not open version 2'
  if printf '%s' "$BFS_OUT" | grep -qi 'bfs recovery'; then
    _fail "the refusal must not send the operator to recovery with a password this command already tried:
$BFS_OUT"
  fi
  if [ "$(tr -d ' \n\r\t' < "$marker")" != "{}" ]; then
    _fail "a failed attempt must leave the marker untouched, got: $(cat "$marker")"
  fi

  # The operator remembers the password: pull opens the map, restores the data,
  # and only then records the version.
  run_bfs "$vault" --lang en pull --version 2 --force --yes --password "$pw_new"
  assert_ok
  assert_restored "$vault" "$base_v2"

  # The marker is gone - v2 is now a version like any other.
  assert_manifest_contains "$vault" 2 '"shards"'
  assert_manifest_health "$vault" 2 degraded
  assert_state "$vault" working_version 2

  run_bfs "$vault" --lang en versions
  assert_ok
  assert_out_contains 'v002'
  if printf '%s' "$BFS_OUT" | grep -qi 'not recovered'; then
    _fail "v002 was restored, so nothing may still call it unrecovered:
$BFS_OUT"
  fi
}
