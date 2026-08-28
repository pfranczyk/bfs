# shellcheck shell=bash
# Assertions for scenarios. On failure each prints a diagnostic and exits the
# scenario subshell non-zero, so run.sh records FAIL and shows the captured log.
# `exit` (not `return`) is deliberate: bash `set -e` is unreliable for failures
# inside functions and inside `var=$(...)` assignments (which run_bfs uses for
# expected-failure cases), so we drive failure explicitly instead.

_fail() {
  echo "  [[X]] assertion failed: $*"
  exit 1
}

# Manifest path helper: <vault>/.bfs/manifests/vNNN.json
_manifest_path() {
  local vault="$1" version="$2" padded
  padded="$(printf '%03d' "$version")"
  printf '%s/.bfs/manifests/v%s.json' "$vault" "$padded"
}

assert_ok() {
  [ "${BFS_EXIT:-1}" = "0" ] || _fail "expected exit 0, got ${BFS_EXIT}. Output:
$BFS_OUT"
}

assert_exit() {
  local want="$1"
  [ "${BFS_EXIT:-}" = "$want" ] || _fail "expected exit $want, got ${BFS_EXIT}. Output:
$BFS_OUT"
}

# assert_fail - last bfs call must have exited non-zero (expected error path).
assert_fail() {
  [ "${BFS_EXIT:-0}" != "0" ] || _fail "expected non-zero exit, got 0. Output:
$BFS_OUT"
}

# assert_out_contains <literal-substring>
assert_out_contains() {
  printf '%s' "$BFS_OUT" | grep -qF -- "$1" || _fail "output missing substring: $1
--- output ---
$BFS_OUT"
}

# assert_out_matches <ERE-regex>
assert_out_matches() {
  printf '%s' "$BFS_OUT" | grep -qE -- "$1" || _fail "output not matching: $1
--- output ---
$BFS_OUT"
}

assert_file() {
  [ -f "$1" ] || _fail "expected file to exist: $1"
}

assert_no_file() {
  [ ! -e "$1" ] || _fail "expected path to be absent: $1"
}

assert_dir() {
  [ -d "$1" ] || _fail "expected directory to exist: $1"
}

# assert_lock_exists <vault> - fail unless .bfs/push.lock is present.
assert_lock_exists() {
  [ -f "$1/.bfs/push.lock" ] || _fail "expected push.lock to exist in $1"
}

# assert_lock_absent <vault> - fail if .bfs/push.lock is present.
assert_lock_absent() {
  [ ! -e "$1/.bfs/push.lock" ] || _fail "expected push.lock to be absent in $1"
}

# spawn_live_pid_holder <pid-out-file>
# Starts a detached node process whose only job is to stay alive and print its
# native OS pid. Reads that pid back and exports it as LIVE_PID - the bash $!
# of the holder is also exported as HOLDER_SHELL_PID for cleanup.
#
# Why: bash $$ / $! under Git Bash for Windows are POSIX-emulated pids that
# Node's process.kill(pid, 0) cannot see - they always trip the stale-lock
# branch instead of the concurrent-active branch. process.pid printed BY the
# spawned node IS a native pid that isPidAlive() recognises across Linux,
# WSL, Git Bash and macOS, so concurrent-lock scenarios become deterministic
# (and 0-disk-IO) on every platform without racing a multi-second push.
spawn_live_pid_holder() {
  local pid_file="$1"
  : >"$pid_file"
  node -e 'process.stdout.write(String(process.pid)+"\n"); setInterval(()=>{}, 1e9);' \
    >"$pid_file" 2>/dev/null &
  HOLDER_SHELL_PID=$!
  local waited=0
  while [ ! -s "$pid_file" ]; do
    sleep 0.05
    waited=$((waited + 1))
    [ "$waited" -lt 100 ] || _fail "live-pid holder never reported a pid (5s timeout)"
  done
  LIVE_PID="$(head -1 "$pid_file" | tr -d '\r\n ')"
  export LIVE_PID HOLDER_SHELL_PID
}

# cleanup_live_pid_holder - kill the live holder. Uses node's process.kill so
# the native pid resolves correctly on Git Bash (where bash kill syscall does
# not see native Windows pids). Also clears the bash bg entry. Idempotent.
cleanup_live_pid_holder() {
  if [ -n "${LIVE_PID:-}" ]; then
    node -e "try{process.kill(${LIVE_PID})}catch(_){}" 2>/dev/null || true
  fi
  [ -n "${HOLDER_SHELL_PID:-}" ] && wait "$HOLDER_SHELL_PID" 2>/dev/null || true
  unset LIVE_PID HOLDER_SHELL_PID
}

# assert_manifest_health <vault> <version> <healthy|degraded|damaged>
assert_manifest_health() {
  local vault="$1" version="$2" want="$3" mf
  mf="$(_manifest_path "$vault" "$version")"
  [ -f "$mf" ] || _fail "manifest missing: $mf"
  grep -q "\"health\": \"$want\"" "$mf" ||
    _fail "v$version health != $want. Got: $(grep '"health"' "$mf" || echo '<none>')"
}

# assert_manifest_contains <vault> <version> <literal> - generic JSON line check
# (e.g. '"compressed": true', '"encrypted": true').
assert_manifest_contains() {
  local vault="$1" version="$2" want="$3" mf
  mf="$(_manifest_path "$vault" "$version")"
  [ -f "$mf" ] || _fail "manifest missing: $mf"
  grep -qF "$want" "$mf" || _fail "manifest v$version missing: $want
--- manifest ---
$(cat "$mf")"
}

# assert_manifest_absent <vault> <version> <literal> - fail if the literal IS
# present (e.g. assert a version is NOT compressed).
assert_manifest_absent() {
  local vault="$1" version="$2" unwanted="$3" mf
  mf="$(_manifest_path "$vault" "$version")"
  [ -f "$mf" ] || _fail "manifest missing: $mf"
  if grep -qF "$unwanted" "$mf"; then
    _fail "manifest v$version unexpectedly contains: $unwanted"
  fi
}

# assert_state <vault> <field> <value> - checks .bfs/state.json field.
assert_state() {
  local vault="$1" field="$2" want="$3" sf="$1/.bfs/state.json"
  [ -f "$sf" ] || _fail "state.json missing: $sf"
  grep -q "\"$field\": $want" "$sf" ||
    _fail "state.$field != $want. Got: $(grep "\"$field\"" "$sf" || echo '<none>')"
}

# assert_file_mtime_epoch <file> <epoch> - fail unless <file>'s mtime, in whole
# seconds, equals <epoch>. GNU/MSYS `stat -c %Y` reads the same value on Windows
# Git Bash and on Linux, so mtime fidelity is asserted uniformly across OSes.
assert_file_mtime_epoch() {
  local file="$1" want="$2" got
  [ -f "$file" ] || _fail "expected file to exist for mtime check: $file"
  got="$(stat -c '%Y' "$file")"
  [ "$got" = "$want" ] || _fail "mtime epoch for $file: expected $want, got $got"
}

# assert_file_mode <file> <octal> - fail unless <file>'s POSIX permission bits
# equal <octal>. No-op on Windows (Git Bash / Cygwin / MSYS), where POSIX mode
# is not a real ACL and chmod does not take effect; there the check is skipped.
assert_file_mode() {
  local file="$1" want="$2" got
  case "$(uname -s)" in
    MINGW* | MSYS* | CYGWIN*) return 0 ;;
  esac
  [ -f "$file" ] || _fail "expected file to exist for mode check: $file"
  got="$(stat -c '%a' "$file")"
  [ "$got" = "$want" ] || _fail "mode for $file: expected $want, got $got"
}

# assert_config_provider <vault> <id> - the storage id must be present in
# .bfs/config.json (the id line as writeConfig serializes it).
assert_config_provider() {
  local id="$2" cf="$1/.bfs/config.json"
  [ -f "$cf" ] || _fail "config.json missing: $cf"
  grep -qE "\"id\": *\"$id\"" "$cf" || _fail "config.json lacks provider \"$id\". Got:
$(grep -E '"id":' "$cf" || echo '<none>')"
}

# assert_config_no_provider <vault> <id> - the storage id must be absent from
# .bfs/config.json.
assert_config_no_provider() {
  local id="$2" cf="$1/.bfs/config.json"
  [ -f "$cf" ] || _fail "config.json missing: $cf"
  if grep -qE "\"id\": *\"$id\"" "$cf"; then
    _fail "config.json unexpectedly holds provider \"$id\""
  fi
}
