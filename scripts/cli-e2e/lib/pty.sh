# shellcheck shell=bash
# run_bfs_pty — like run_bfs, but drives `bfs` through a pseudo-terminal so
# real inquirer prompts (e.g. interactive `bfs recovery` on a stripped vault)
# can be answered. Backed by lib/pty-run.mjs + @lydell/node-pty (devDependency).
#
# Usage:  run_bfs_pty <workdir> <answers-json> <bfs-args...>
#   <answers-json>  JSON array, fed in order:
#                   '[{"anchor":"required to reconnect","value":"bfspass"}]'
#                   The value is typed + Enter the first time its anchor
#                   substring appears in the terminal output.
# Sets the same globals as run_bfs: BFS_EXIT / BFS_STDOUT / BFS_STDERR / BFS_OUT.
# Never aborts the caller (always returns 0); scenarios assert on the outcome.

PTY_DRIVER="${PTY_DRIVER:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pty-run.mjs}"

run_bfs_pty() {
  local workdir="$1"
  shift
  local answers="$1"
  shift

  if [ "${VERBOSE:-0}" = "1" ]; then
    printf '    \033[36m$ bfs(pty) %s\033[0m\n' "$*"
    printf '    \033[2manswers: %s\033[0m\n' "$answers"
  fi

  BFS_STDOUT="$(PTY_ANSWERS="$answers" PTY_TIMEOUT="${PTY_TIMEOUT:-90000}" \
    node "$PTY_DRIVER" "$(winpath "$BFS_ENTRY")" "$(winpath "$workdir")" "$@" 2>&1)"
  BFS_EXIT=$?
  BFS_STDERR=""
  BFS_OUT="$BFS_STDOUT"

  if [ "${VERBOSE:-0}" = "1" ]; then
    printf '    \033[2m→ exit %s\033[0m\n' "$BFS_EXIT"
    [ -n "$BFS_OUT" ] && printf '%s\n' "$BFS_OUT" | sed 's/^/      | /'
  fi

  return 0
}
