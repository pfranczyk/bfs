# shellcheck shell=bash
#
# Scenario template — copy this directory to scenarios/NN-my-case/ and edit.
#
#   cp -r scripts/cli-e2e/scenarios/_template scripts/cli-e2e/scenarios/30-my-case
#
# A scenario declares metadata then a scenario_run() function. It runs in a
# subshell with `set -e`, so the first failed assertion aborts and run.sh marks
# the scenario FAIL (the captured log is printed). run_bfs never aborts on a
# non-zero exit — inspect the result with assertions instead.
#
# Available helpers (see lib/):
#   build_pool <sandbox> <n_local> <n_ftp> <vault>   — build provider arguments
#   "${PROVIDER_ARGS[@]}"                            — pass to `bfs init`
#   shard_file <provider-index> <version>            — local shard file path
#   run_bfs <workdir> <bfs-args...>  → BFS_EXIT / BFS_OUT / BFS_STDOUT / BFS_STDERR
#   make_fixtures <dir> / mutate_fixtures <dir> / make_large_file <dir> <bytes>
#   snapshot_hashes <dir> <file> / assert_restored <dir> <file>
#   assert_ok / assert_exit N / assert_fail
#   assert_out_contains <s> / assert_out_matches <regex>
#   assert_file / assert_no_file / assert_dir
#   assert_manifest_health <vault> <version> <healthy|degraded|damaged>
#   assert_manifest_contains <vault> <version> <literal>
#   assert_state <vault> <field> <value>
#   $SC_DIR  — this scenario's private sandbox directory (already created)

SCENARIO_NAME="template (does nothing)"
SCENARIO_DESC="copy me"
REQUIRES_LOCAL=0
REQUIRES_FTP=0

scenario_run() {
  : # implement me
}
