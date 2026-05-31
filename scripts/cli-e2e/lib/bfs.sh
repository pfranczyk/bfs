# shellcheck shell=bash
# run_bfs — invokes the bfs CLI in a given working directory and captures the
# result. Never aborts the caller (always returns 0) so it is safe under
# `set -e`; scenarios inspect the outcome through assertions.
#
# Usage:  run_bfs <workdir> <bfs-args...>
# Sets globals:
#   BFS_EXIT     numeric exit code
#   BFS_STDOUT   captured stdout
#   BFS_STDERR   captured stderr
#   BFS_OUT      stdout + stderr combined (for assert_out_*)
#
# stdin is fed from /dev/null: every command the harness runs uses a
# non-interactive flag path, so an unexpected prompt hits EOF and fails fast
# instead of hanging.
run_bfs() {
  local workdir="$1"
  shift

  if [ "${VERBOSE:-0}" = "1" ]; then
    printf '    \033[36m$ bfs %s\033[0m\n' "$*"
  fi

  local err_file
  err_file="$(mktemp "${RUN_WS:-/tmp}/bfs-stderr.XXXXXX")"

  BFS_STDOUT="$("$TSX" "$BFS_ENTRY" --cwd "$(winpath "$workdir")" "$@" 2>"$err_file" </dev/null)"
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
