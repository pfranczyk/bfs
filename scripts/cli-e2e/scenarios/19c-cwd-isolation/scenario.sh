# shellcheck shell=bash
# Explicit guard: `bfs --cwd <vault>` invoked from an unrelated process cwd
# must place every artifact (.bfs/, cache, push.lock, manifests, shards) under
# <vault>, not under the spawn cwd. Run the full create→partial→resume cycle
# through the flag and assert the spawn cwd stays empty the whole time.
#
# Other scenarios already exercise --cwd implicitly (run_bfs always passes it),
# but they live in $REPO_ROOT — they would let a hypothetical bug "writes to
# process.cwd() instead of --cwd" land in the repository unnoticed. This
# scenario uses a dedicated, expected-empty spawn cwd so the negative
# assertion is precise.

SCENARIO_NAME="--cwd × cache isolation (spawn cwd stays untouched)"
SCENARIO_DESC="bfs --cwd <vault> from unrelated cwd; full push/partial/resume; spawn cwd empty"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

# run_bfs_from <spawn-cwd> <vault> <bfs-args...>
# Mirrors run_bfs but lets the caller pick the process cwd of the spawned
# tsx. Same globals (BFS_EXIT / BFS_OUT / …) so existing asserts apply.
run_bfs_from() {
  local spawn_cwd="$1" vault="$2"
  shift 2

  if [ "${VERBOSE:-0}" = "1" ]; then
    printf '    \033[36m$ (cd %s; bfs --cwd %s %s)\033[0m\n' \
      "$spawn_cwd" "$vault" "$*"
  fi

  local err_file
  err_file="$(mktemp "${RUN_WS:-/tmp}/bfs-stderr.XXXXXX")"

  BFS_STDOUT="$(
    cd "$spawn_cwd" && \
    "$TSX" "$BFS_ENTRY" --cwd "$(winpath "$vault")" "$@" \
      2>"$err_file" </dev/null
  )"
  BFS_EXIT=$?
  BFS_STDERR="$(cat "$err_file")"
  rm -f "$err_file"
  BFS_OUT="$BFS_STDOUT
$BFS_STDERR"

  if [ "${VERBOSE:-0}" = "1" ]; then
    printf '    \033[2m→ exit %s\033[0m\n' "$BFS_EXIT"
    [ -n "$BFS_OUT" ] && printf '%s\n' "$BFS_OUT" | sed 's/^/      | /'
  fi
  return 0
}

# assert_spawn_cwd_empty <spawn-cwd>
# Fail if anything appears in the spawn cwd. Hidden entries (.bfs) included.
assert_spawn_cwd_empty() {
  local d="$1"
  local leftovers
  leftovers="$(ls -A "$d" 2>/dev/null || true)"
  if [ -n "$leftovers" ]; then
    _fail "spawn cwd $d should stay empty, but contains:
$leftovers"
  fi
}

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs19c"
  local spawn_cwd="$SC_DIR/spawn-cwd"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"
  mkdir -p "$spawn_cwd"
  assert_spawn_cwd_empty "$spawn_cwd"

  # ── init from unrelated cwd ────────────────────────────────────────────────
  run_bfs_from "$spawn_cwd" "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_spawn_cwd_empty "$spawn_cwd"

  # ── healthy push from unrelated cwd ────────────────────────────────────────
  run_bfs_from "$spawn_cwd" "$vault" push --new
  assert_ok
  assert_lock_absent "$vault"
  assert_no_file "$vault/.bfs/cache/push.blob.pending"
  assert_manifest_health "$vault" 1 healthy
  assert_state "$vault" working_version 1
  assert_file "$(shard_file 0 1)"
  assert_file "$(shard_file 3 1)"
  assert_spawn_cwd_empty "$spawn_cwd"

  # ── partial push from unrelated cwd → forensic state lands in vault ───────
  local broken="${PV_LOCALDIR[2]}"
  rm -rf "$broken"
  : >"$broken"

  run_bfs_from "$spawn_cwd" "$vault" push --new
  assert_exit 1
  assert_out_contains "degraded"
  assert_manifest_health "$vault" 2 degraded
  assert_lock_exists "$vault"
  assert_file "$vault/.bfs/cache/push.blob.pending"
  assert_spawn_cwd_empty "$spawn_cwd"

  # ── resume via --cache --overwrite from unrelated cwd ──────────────────────
  rm -f "$broken"
  mkdir -p "$broken"

  run_bfs_from "$spawn_cwd" "$vault" push --cache --overwrite
  assert_ok
  assert_out_contains "healthy"
  assert_manifest_health "$vault" 2 healthy
  assert_lock_absent "$vault"
  assert_no_file "$vault/.bfs/cache/push.blob.pending"
  assert_spawn_cwd_empty "$spawn_cwd"

  # ── pull from unrelated cwd into the vault directory ──────────────────────
  run_bfs_from "$spawn_cwd" "$vault" pull --force --yes
  assert_ok
  assert_spawn_cwd_empty "$spawn_cwd"

  # ── clear from unrelated cwd: cwd still empty afterwards ──────────────────
  # Seed a stale lock so clear has work to do, then verify it targets vault.
  : >"$vault/.bfs/push.lock"
  run_bfs_from "$spawn_cwd" "$vault" clear
  assert_ok
  assert_lock_absent "$vault"
  assert_spawn_cwd_empty "$spawn_cwd"
}
