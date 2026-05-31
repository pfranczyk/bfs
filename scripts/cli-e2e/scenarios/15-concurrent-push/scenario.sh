# shellcheck shell=bash
# Concurrent push: when .bfs/push.lock points at a live process, a second push
# must fail fast with LockConcurrentActiveError instead of corrupting the lock
# or starting a parallel upload. Covers src/vault/lockfile.ts
# assertNoActiveLock('push') live-PID branch (lockfile.ts:200-207).
#
# Deterministic across Linux / WSL / Git Bash on Windows: we spawn an idle
# node holder, take ITS native process.pid (printed by node itself — bash $$
# is POSIX-emulated under Git Bash and useless here), and stamp that pid into
# a hand-crafted push.lock. No race window, no large fixture, ~1 s of work.

SCENARIO_NAME="concurrent push blocked by live lock"
SCENARIO_DESC="push refuses while push.lock points at a live process"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs15"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_lock_absent "$vault"

  # Stand up a live holder so isPidAlive() returns true on every OS.
  spawn_live_pid_holder "$SC_DIR/holder.pid"
  trap cleanup_live_pid_holder EXIT

  local now; now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  cat >"$vault/.bfs/push.lock" <<EOF
{
  "format_version": 1,
  "operation": "push",
  "version": 1,
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

  # A real push now must observe the live lock and bail with the concurrent
  # active error — the exact branch we want to cover.
  run_bfs "$vault" push --new
  assert_fail
  assert_out_contains "another push in progress"
  assert_out_contains "PID ${LIVE_PID}"
  assert_lock_exists "$vault"

  # Stop pretending the lock is live, then prove that clearing it unblocks a
  # fresh push (so we cover the full lifecycle and don't leave forensic state
  # behind for the suite).
  cleanup_live_pid_holder
  trap - EXIT
  run_bfs "$vault" clear
  assert_ok
  assert_lock_absent "$vault"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_state "$vault" working_version 1
}
