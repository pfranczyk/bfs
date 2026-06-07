# shellcheck shell=bash
# Stale push.lock from a crashed prior run: the next push must refuse with
# LockPartialStatePushError, `bfs clear` must drop the lock, and a fresh push
# must then succeed. Covers src/vault/lockfile.ts assertNoActiveLock('push')
# stale branch (lockfile.ts:208).

SCENARIO_NAME="stale push.lock blocks push, clear unblocks"
SCENARIO_DESC="dead-PID lock → PartialState error → bfs clear → fresh push ok"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

# write_fake_push_lock <vault> <pid> <version>
# Writes a syntactically valid PushLock JSON (see src/vault/lockfile.ts:44-59)
# with the given pid + started_at=now. Using a PID that is almost certainly
# not alive (999999) makes assertNoActiveLock treat it as stale across both
# POSIX and Windows.
write_fake_push_lock() {
  local vault="$1" pid="$2" version="$3"
  mkdir -p "$vault/.bfs"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  cat >"$vault/.bfs/push.lock" <<EOF
{
  "format_version": 1,
  "operation": "push",
  "version": ${version},
  "pid": ${pid},
  "command": "bfs push",
  "started_at": "${now}",
  "scheme": { "data_shards": 3, "parity_shards": 1 },
  "uploaded": [],
  "failed": [],
  "blob_pending_path": ""
}
EOF
}

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs16"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_lock_absent "$vault"

  # Simulate a crashed push: a leftover lock whose owning process is gone.
  write_fake_push_lock "$vault" 999999 2
  assert_lock_exists "$vault"

  # Fresh push must refuse — partial-state requires explicit cleanup.
  run_bfs "$vault" push --new
  assert_fail
  assert_out_contains "push.lock exists from partial-state push"

  # bfs clear drops the stale lock.
  run_bfs "$vault" clear
  assert_ok
  assert_lock_absent "$vault"

  # Now a fresh push goes through.
  run_bfs "$vault" push --new
  assert_ok
  assert_lock_absent "$vault"
  assert_manifest_health "$vault" 2 healthy
  assert_state "$vault" latest_version 2
}
