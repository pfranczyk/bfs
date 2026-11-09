# shellcheck shell=bash
# `bfs provider remove --strategy rebuild` onto a new storage that fails after
# rebuilding one version is finished by running the same command again - the
# advice the partial failure itself prints.
#
# The new storage is written to the configuration before the rebuild starts
# and stays there once a version has been rebuilt onto it, so between the two
# runs the pool holds one storage more than the scheme. The second run has to
# take the storage that is already configured as its target, rebuild only what
# is still missing and drop the removed storage, bringing the pool back to the
# scheme. Sibling of the repair scenario that pins the same resume. In between
# the two runs it also pins what every backup command says about that state.
#
# The interruption is real: the removed storage is gone and one sibling part
# of v2 is taken away, so v2 cannot be reconstructed while v1 can.

SCENARIO_NAME="provider remove --strategy rebuild interrupted after one version is finished by the same command"
SCENARIO_DESC="3L 2/1, v1+v2; p0 lost; rebuild onto p3 fails on v2 after v1; sibling back; same command finishes, pool back to 3"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/v2.txt" name="bfs142" rebuilt="$SC_DIR/rebuilt" held="$SC_DIR/held.2"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"
  mkdir -p "$rebuilt"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # -- p0 is lost; v2 is short of a sibling as well ----------------------------
  rm -rf "${PV_LOCALDIR[0]:?}/$name"
  mv "${PV_LOCALDIR[1]}/$name/shard_1.bfs.2" "$held"

  run_bfs "$vault" provider remove p0 \
    --strategy rebuild --target p3 --new-type local \
    --path "$(winpath "$rebuilt")" --scope all --yes
  assert_fail
  assert_out_contains 'Re-run the same command'
  assert_file "$rebuilt/$name/shard_0.bfs.1"
  assert_no_file "$rebuilt/$name/shard_0.bfs.2"
  assert_config_provider "$vault" p0
  assert_config_provider "$vault" p3

  # -- In between: every backup command names the unfinished rebuild ----------
  # One entry over the scheme; `bfs scheme set 2 2` would be accepted here and
  # count the new storage as holding parts it does not have yet, so it must not
  # be offered.
  run_bfs "$vault" pull --force --yes
  assert_fail
  assert_out_contains 'more storages than the scheme uses'
  assert_out_contains 'did not finish'
  if printf '%s' "$BFS_OUT" | grep -qF -- 'bfs scheme set'; then
    _fail "a pool left over its scheme by an unfinished rebuild must not be advised bfs scheme set
$BFS_OUT"
  fi

  # -- The cause fixed, the same command again ---------------------------------
  mv "$held" "${PV_LOCALDIR[1]}/$name/shard_1.bfs.2"
  run_bfs "$vault" provider remove p0 \
    --strategy rebuild --target p3 --new-type local \
    --path "$(winpath "$rebuilt")" --scope all --yes
  assert_ok
  assert_file "$rebuilt/$name/shard_0.bfs.2"
  assert_config_no_provider "$vault" p0
  assert_config_provider "$vault" p3
  [ "$(grep -cE '"id": *"p[0-9]+"' "$vault/.bfs/config.json")" = "3" ] ||
    _fail "expected 3 storages after the rebuild is finished. Got:
$(grep -E '"id":' "$vault/.bfs/config.json")"
  run_bfs "$vault" verify
  assert_exit 0
  assert_manifest_health "$vault" 1 healthy
  assert_manifest_health "$vault" 2 healthy

  # -- Binding proof: v2 restores through the part rebuilt on the second run ---
  rm -f "${PV_LOCALDIR[1]}/$name/shard_1.bfs.2"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
  return 0
}
