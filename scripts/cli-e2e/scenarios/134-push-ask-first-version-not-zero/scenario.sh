# shellcheck shell=bash
# Version 0 means "no backup yet" - it is what state.json holds after init. Under
# push_mode=ask the first push has nothing to overwrite, so it must create
# version 1 like every other first push - version 0 is never a push target.
#
# The push runs on a real terminal (run_bfs_pty), the only place the overwrite
# question can be asked; should it still come, it is answered with "Overwrite".
# local only - the version number is decided in core, the same for every medium.

SCENARIO_NAME="push_mode ask: the first push creates version 1, never version 0"
SCENARIO_DESC="init --push-mode ask; first push on a terminal; parts land as v1, none as v0; pull restores byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs134"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress --push-mode ask \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  # The rawlist puts "New version" first and "Overwrite" second.
  run_bfs_pty "$vault" '[{"anchor":"or overwrite v0","value":"2"}]' --lang en push
  assert_exit 0

  local i
  for i in 0 1 2; do
    assert_no_file "$(shard_file "$i" 0)"
    assert_file "$(shard_file "$i" 1)"
  done
  assert_state "$vault" latest_version 1
  assert_manifest_health "$vault" 1 healthy

  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_restored "$vault" "$base"
  return 0
}
