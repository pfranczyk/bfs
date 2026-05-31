# shellcheck shell=bash
# `bfs push --cache` requires BOTH .bfs/push.lock and the cached blob to be
# present — it's a forensic resume, not a fresh push path. Every combination
# of missing artifact must emit PushCacheNoLockError naming exactly what is
# missing. Covers vault-manager.ts:943-952 (_initPushLock fromCache branch)
# and src/core/errors.ts:115-120.

SCENARIO_NAME="push --cache rejects missing lock and/or cache blob"
SCENARIO_DESC="3 variants of PushCacheNoLockError contract"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

write_live_push_lock() {
  local vault="$1" version="$2"
  mkdir -p "$vault/.bfs"
  local now; now="$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"
  # blob_pending_path mirrors what a real BFS push would write — `_initPushLock`
  # reports exactly this string in `PushCacheNoLockError.missing` when the file
  # itself does not exist, so the asserts on "push.blob.pending" hit the path
  # literal rather than a placeholder.
  local cache_path="$vault/.bfs/cache/push.blob.pending"
  cat >"$vault/.bfs/push.lock" <<EOF
{
  "format_version": 1,
  "operation": "push",
  "version": ${version},
  "pid": $$,
  "command": "bfs push",
  "started_at": "${now}",
  "scheme": { "data_shards": 3, "parity_shards": 1 },
  "uploaded": [],
  "failed": [],
  "blob_pending_path": "${cache_path}"
}
EOF
}

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs19"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_lock_absent "$vault"

  # Variant 1: neither lock nor cache present → both listed as missing.
  run_bfs "$vault" push --cache
  assert_fail
  assert_out_contains '`--cache` requires both'
  assert_out_contains 'push.lock'
  assert_out_contains 'push.blob.pending'

  # Variant 2: lock present, cache blob missing → only the blob is missing.
  write_live_push_lock "$vault" 1
  rm -f "$vault/.bfs/cache/push.blob.pending"
  run_bfs "$vault" push --cache
  assert_fail
  assert_out_contains '`--cache` requires both'
  local missing2; missing2="$(_missing_list "$BFS_OUT")"
  if ! printf '%s' "$missing2" | grep -qF 'push.blob.pending'; then
    _fail "variant 2: 'missing:' should list push.blob.pending. Got: $missing2"
  fi
  if printf '%s' "$missing2" | grep -qF 'push.lock'; then
    _fail "variant 2: 'missing:' should NOT list push.lock when the lock exists. Got: $missing2"
  fi
  rm -f "$vault/.bfs/push.lock"

  # Variant 3: cache blob present, lock missing → only the lock is missing.
  mkdir -p "$vault/.bfs/cache"
  : >"$vault/.bfs/cache/push.blob.pending"
  run_bfs "$vault" push --cache
  assert_fail
  assert_out_contains '`--cache` requires both'
  local missing3; missing3="$(_missing_list "$BFS_OUT")"
  if ! printf '%s' "$missing3" | grep -qF 'push.lock'; then
    _fail "variant 3: 'missing:' should list push.lock. Got: $missing3"
  fi
  if printf '%s' "$missing3" | grep -qF 'push.blob.pending'; then
    _fail "variant 3: 'missing:' should NOT list push.blob.pending when the blob exists. Got: $missing3"
  fi
}

# _missing_list <bfs-output> — extracts the comma-separated list of missing
# artifacts that PushCacheNoLockError appends after "missing:". Isolates the
# list from the surrounding "requires both .bfs/push.lock and cached blob"
# template, so per-variant assertions only inspect what is actually missing.
_missing_list() {
  printf '%s' "$1" | grep -F 'missing:' | head -1 | sed 's/.*missing: //'
}
