# shellcheck shell=bash
# `provider remove --strategy rebuild` onto a target that cannot take a single
# byte must fail as a failure: non-zero exit, a message naming the target and
# the step it failed at, and the configuration exactly as it was before the
# command - the old storage still in it, the unusable target withdrawn. Every
# version in scope is stamped degraded, because the operator has just declared
# the old storage lost and nothing was rebuilt to replace it.
#
# The target is a path under an existing FILE (`<file>/sub`): creating it
# fails inside the operating system on every platform, before any upload.
#
# Binding assertions: exit != 0 with the target named, config restored, no
# rebuilt part on the target, versions degraded; then the same command onto a
# usable target succeeds, `bfs verify` is healthy again and the restore
# matches the snapshot byte-for-byte.

SCENARIO_NAME="provider remove --strategy rebuild: unusable target is a failure, config untouched"
SCENARIO_DESC="3L 2/1, 2 versions; rebuild onto <file>/sub fails loudly, old storage kept, target withdrawn; retry onto a real dir succeeds"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs119"
  local blocker="$SC_DIR/blocker" rebuilt="$SC_DIR/rebuilt"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2
  assert_manifest_health "$vault" 1 healthy
  assert_manifest_health "$vault" 2 healthy

  # A file where the target's parent directory would have to be.
  printf 'not a directory\n' > "$blocker"

  run_bfs "$vault" provider remove p0 \
    --strategy rebuild --target p3 --new-type local \
    --path "$(winpath "$blocker")/sub" --scope all --yes
  assert_fail
  assert_out_contains 'Target storage "p3" is not usable'
  assert_out_contains 'same command'
  # Nothing moved, so the target is withdrawn - and the message must not claim
  # the configuration still holds it.
  assert_out_contains 'has been removed again'
  # Nothing was rebuilt, so the configuration is exactly what it was: the
  # storage the operator meant to remove is still in it, the target is not.
  assert_config_provider "$vault" p0
  assert_config_no_provider "$vault" p3
  assert_no_file "$blocker/sub"
  # The operator declared p0 lost and nothing replaced it - every version in
  # scope is degraded, none may still claim to be healthy.
  assert_manifest_health "$vault" 1 degraded
  assert_manifest_health "$vault" 2 degraded

  # The advice is to repeat the command once the target is usable.
  mkdir -p "$rebuilt"
  run_bfs "$vault" provider remove p0 \
    --strategy rebuild --target p3 --new-type local \
    --path "$(winpath "$rebuilt")" --scope all --yes
  assert_ok
  assert_config_no_provider "$vault" p0
  assert_config_provider "$vault" p3
  assert_file "$rebuilt/$name/shard_0.bfs.1"
  assert_file "$rebuilt/$name/shard_0.bfs.2"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_manifest_health "$vault" 2 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
