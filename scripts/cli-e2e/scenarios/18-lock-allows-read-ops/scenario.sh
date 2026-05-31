# shellcheck shell=bash
# A push.lock present in the vault must NOT block read-side operations. Only
# `push` calls assertNoActiveLock — pull / verify / versions / provider list
# must keep working even while a push appears to be in flight. Control
# assertion at the end confirms that the same lock IS recognized as live by
# a real push (LockConcurrentActiveError).
#
# Cross-platform determinism comes from a node-spawned live pid holder: bash
# $$ under Git Bash for Windows is POSIX-emulated and Node's process.kill
# cannot see it, so using $$ would silently trip the stale branch instead.

SCENARIO_NAME="push.lock does not block pull/verify/versions/prune"
SCENARIO_DESC="read commands ignore push.lock; only push observes it"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs18"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  # Baseline AFTER init so .bfsignore (created by init, round-trips via blob)
  # is captured — hash_tree skips only .bfs/, not .bfsignore.
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_lock_absent "$vault"

  # Inject a push.lock pointing at a live node holder.
  spawn_live_pid_holder "$SC_DIR/holder.pid"
  trap cleanup_live_pid_holder EXIT

  local now; now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  cat >"$vault/.bfs/push.lock" <<EOF
{
  "format_version": 1,
  "operation": "push",
  "version": 99,
  "pid": ${LIVE_PID},
  "command": "bfs push",
  "started_at": "${now}",
  "scheme": { "data_shards": 3, "parity_shards": 1 },
  "uploaded": [],
  "failed": [],
  "blob_pending_path": ""
}
EOF
  assert_lock_exists "$vault"

  # Read commands keep working — none of them call assertNoActiveLock.
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  run_bfs "$vault" versions
  assert_ok
  assert_out_contains "v001"

  run_bfs "$vault" provider list
  assert_ok

  # Control assertion: the lock IS still observed by push.
  assert_lock_exists "$vault"
  run_bfs "$vault" push --new
  assert_fail
  assert_out_contains "another push in progress"

  cleanup_live_pid_holder
  trap - EXIT
}
