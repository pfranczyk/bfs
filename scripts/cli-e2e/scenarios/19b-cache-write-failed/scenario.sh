# shellcheck shell=bash
# Partial push where the emergency RAM→disk cache dump itself cannot land
# (broken cache dir). The lock must explicitly record blob_pending_path=null;
# `bfs push --cache` must refuse with PushCacheUnavailableError instead of
# the misleading "missing file" message; recovery is bfs clear + fresh push.

SCENARIO_NAME="partial push: cache write fails, lock records null"
SCENARIO_DESC="broken cache dir → push.lock with blob_pending_path=null → bfs push --cache refuses cleanly"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs19b"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  # Break provider p2 the same way as scenario 17 (ENOTDIR on its base dir).
  local broken_provider="${PV_LOCALDIR[2]}"
  rm -rf "$broken_provider"
  : >"$broken_provider"

  # Break the cache blob path specifically: cacheDir itself must stay a real
  # directory (push() does _validateConfigDir + fs.mkdir on it before pack
  # and would abort before the upload loop otherwise). Make push.blob.pending
  # a *directory*, so fs.writeFile on that path inside the emergency dump
  # hits EISDIR and mutates lock.blob_pending_path to null.
  mkdir -p "$vault/.bfs/cache/push.blob.pending"

  # Partial push: exit 1, manifest degraded, warn about cache write failure,
  # blob_pending_path stays a directory (writeFile failed).
  run_bfs "$vault" push --new
  assert_exit 1
  assert_out_contains "degraded"
  assert_manifest_health "$vault" 1 degraded
  assert_lock_exists "$vault"
  assert_out_contains "Cache write failed"
  [ -d "$vault/.bfs/cache/push.blob.pending" ] \
    || _fail "expected .bfs/cache/push.blob.pending to remain a directory (write failed)"

  # Lock must record blob_pending_path=null. Use grep -F on the raw JSON
  # rather than parsing — scenarios are bash, no jq dependency.
  grep -qF '"blob_pending_path": null' "$vault/.bfs/push.lock" \
    || _fail "expected push.lock.blob_pending_path === null. Got:
$(cat "$vault/.bfs/push.lock")"

  # bfs push --cache must refuse with the dedicated message — not the
  # generic "missing: <path>" one, because the lock is honest about cache
  # never being persisted.
  run_bfs "$vault" push --cache
  assert_fail
  assert_out_contains "indicates"
  assert_out_contains "cache"
  # Distinct from PushCacheNoLockError — that one says "requires both"
  if printf '%s' "$BFS_OUT" | grep -qF '\`--cache\` requires both'; then
    _fail "expected PushCacheUnavailableError text, got PushCacheNoLockError text:
$BFS_OUT"
  fi

  # Recovery: clean up the artificial directory at the cache path (a real
  # ENOSPC / EACCES write failure would have left nothing on disk; we created
  # the dir manually to force EISDIR), then `bfs clear`, fix providers, push.
  rm -rf "$vault/.bfs/cache/push.blob.pending"
  run_bfs "$vault" clear
  assert_ok
  assert_lock_absent "$vault"

  rm -rf "$broken_provider"
  mkdir -p "$broken_provider"

  run_bfs "$vault" push --overwrite
  assert_ok
  assert_out_contains "healthy"
  assert_manifest_health "$vault" 1 healthy
  assert_lock_absent "$vault"
}
