# shellcheck shell=bash
# Environment setup: workspace, isolated global settings, path translation.
# Sourced by run.sh. Relies on $REPO_ROOT being exported by run.sh.

# winpath <posix-path> — converts a path for consumption by the native Windows
# node.exe when running under MSYS/Git Bash (cygpath -m → mixed form C:/foo,
# forward slashes so it survives shellParse inside --provider specs). On
# Linux/WSL (no cygpath) it is the identity function.
if command -v cygpath >/dev/null 2>&1; then
  winpath() { cygpath -m "$1"; }
else
  winpath() { printf '%s' "$1"; }
fi

# env_init — creates the per-run workspace and isolates global BFS settings so
# the harness never touches the user's real ~/.config/bfs. Sets:
#   RUN_ID        unique id for this invocation (timestamp + pid)
#   RUN_WS        root workspace dir (auto-removed unless --keep)
#   XDG_CONFIG_HOME  pointed inside RUN_WS, pre-seeded with language=en so CLI
#                    output is deterministic English (no --lang noise on stdout)
#   TSX, BFS_ENTRY   how to invoke bfs (tsx src/index.ts, like scripts/smoke.ts)
env_init() {
  RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
  RUN_WS="$(mktemp -d "${TMPDIR:-/tmp}/bfs-cli-e2e.XXXXXX")"
  export RUN_WS RUN_ID

  export XDG_CONFIG_HOME="$RUN_WS/.config"
  mkdir -p "$XDG_CONFIG_HOME/bfs"
  printf '{"language":"en"}' >"$XDG_CONFIG_HOME/bfs/settings.json"

  TSX="$REPO_ROOT/node_modules/.bin/tsx"
  BFS_ENTRY="$REPO_ROOT/src/index.ts"
  if [ ! -x "$TSX" ] && [ ! -f "$TSX" ]; then
    echo "FATAL: tsx not found at $TSX — run 'npm install' in $REPO_ROOT" >&2
    exit 2
  fi
  export TSX BFS_ENTRY
}

# env_cleanup — removes the local workspace AND this run's remote FTP/SSH
# namespace unless KEEP_WS=1. Registered as an EXIT trap by run.sh, so it also
# fires on Ctrl+C and on failure. Never touches anything outside RUN_WS locally,
# or anything but `bfs-e2e-<RUN_ID>` remotely.
env_cleanup() {
  if [ "${KEEP_WS:-0}" = "1" ]; then
    echo "[cli-e2e] workspace kept: $RUN_WS" >&2
    echo "[cli-e2e] remove later with: bash scripts/cli-e2e/clean.sh [--ftp \"<spec>\"] [--ssh \"<spec>\"]" >&2
    return 0
  fi
  [ -n "${RUN_WS:-}" ] && rm -rf "$RUN_WS"
  # Remote: drop this run's namespace from every FTP endpoint that was used.
  if declare -F ftp_clean_run >/dev/null 2>&1 &&
    [ "$(ftp_count 2>/dev/null || echo 0)" -gt 0 ]; then
    ftp_clean_run "$RUN_ID"
  fi
  # Remote: same for every SSH endpoint that was used.
  if declare -F ssh_clean_run >/dev/null 2>&1 &&
    [ "$(ssh_count 2>/dev/null || echo 0)" -gt 0 ]; then
    ssh_clean_run "$RUN_ID"
  fi
  # Drop every container/volume this run's docker-managed scenarios created.
  if declare -F docker_cleanup_run >/dev/null 2>&1; then
    docker_cleanup_run "$RUN_ID"
  fi
}
