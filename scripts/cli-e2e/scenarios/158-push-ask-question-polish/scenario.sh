# shellcheck shell=bash
# Under push_mode=ask, push with a version on disk asks whether to create a new
# version or overwrite the current one. That question speaks the interface
# language like every other one, and the answer is honoured in that language:
# "Overwrite" picked from the Polish menu keeps the version number.
#
# A/B: the same overwrite is taken in English first, so a failure of the Polish
# run points at the language, not at the overwrite itself. A push that created a
# new version instead of overwriting is caught by latest_version and by the
# absent v2 parts; each push changes the content and is restored against its own
# snapshot, so an overwrite that did not store the new content fails too.
# local only - the question is asked in core, the same for every medium.

SCENARIO_NAME="push_mode ask: the overwrite question speaks Polish and Polish Overwrite keeps the version"
SCENARIO_DESC="init --push-mode ask; push v1; overwrite via the English menu (A/B), then via the Polish menu; no v2 on any medium; pull restores each push byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs158" i
  # A private language store: --lang pl records the language, and in the run's
  # shared store it would switch the scenarios that follow to Polish.
  export XDG_CONFIG_HOME="$SC_DIR/.config"
  mkdir -p "$XDG_CONFIG_HOME/bfs"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress --push-mode ask \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" --lang en push
  assert_ok
  assert_state "$vault" latest_version 1

  # A/B control - English. The rawlist puts "New version" first and "Overwrite" second.
  mutate_fixtures "$vault"
  printf 'english overwrite\n' > "$vault/ab-en.txt"
  snapshot_hashes "$vault" "$SC_DIR/baseline-en.txt"
  PTY_TIMEOUT=30000 run_bfs_pty "$vault" '[{"anchor":"or overwrite v1","value":"2"}]' --lang en push
  assert_exit 0
  assert_state "$vault" latest_version 1
  for i in 0 1 2; do assert_no_file "$(shard_file "$i" 2)"; done
  wipe_working_tree "$vault"
  run_bfs "$vault" --lang en pull --yes
  assert_ok
  assert_restored "$vault" "$SC_DIR/baseline-en.txt"

  # The same overwrite through the Polish menu. The anchor stays ASCII so the
  # terminal's encoding cannot keep it from matching; the full Polish question
  # is asserted on the output below.
  printf 'polish overwrite\n' > "$vault/ab-pl.txt"
  snapshot_hashes "$vault" "$SC_DIR/baseline-pl.txt"
  PTY_TIMEOUT=30000 run_bfs_pty "$vault" '[{"anchor":"czy nadpisa","value":"2"}]' --lang pl push
  if printf '%s' "$BFS_OUT" | grep -qF 'Create new version'; then
    _fail "the overwrite question is asked in English under --lang pl"
  fi
  assert_out_contains 'Utworzyć nową wersję v2 czy nadpisać v1?'
  assert_out_contains 'Nadpisz (v1)'
  assert_exit 0
  assert_state "$vault" latest_version 1
  for i in 0 1 2; do assert_no_file "$(shard_file "$i" 2)"; done
  wipe_working_tree "$vault"
  run_bfs "$vault" --lang en pull --yes
  assert_ok
  assert_restored "$vault" "$SC_DIR/baseline-pl.txt"
  return 0
}
