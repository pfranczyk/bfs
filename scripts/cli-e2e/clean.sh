#!/usr/bin/env bash
#
# Remove leftover BFS CLI e2e test data — both the local temp workspaces
# (bfs-cli-e2e.*) and, when --ftp endpoints are given, every remote bfs-e2e-*
# directory on those servers. Leftovers accumulate only from runs invoked with
# --keep, or from a run interrupted before its cleanup trap fired; a normal run
# cleans up after itself.
#
# Usage:
#   bash scripts/cli-e2e/clean.sh                       # local temp only
#   bash scripts/cli-e2e/clean.sh --ftp "<spec>" ...    # local + remote FTP
#   bash scripts/cli-e2e/clean.sh --dry-run [--ftp ...] # list, delete nothing
#
# Safe by construction: locally only touches directories named bfs-cli-e2e.*;
# remotely only directories named bfs-e2e-* under each endpoint's base path.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export REPO_ROOT

dry=0
FTP_SPECS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run | -n) dry=1; shift ;;
    --ftp) FTP_SPECS+=("${2:?--ftp requires a value}"); shift 2 ;;
    *) echo "usage: clean.sh [--dry-run] [--ftp \"<spec>\"]..." >&2; exit 2 ;;
  esac
done

# ── Local temp workspaces ────────────────────────────────────────────────────
bases="$(printf '%s\n' "${TMPDIR:-/tmp}" "/tmp" | LC_ALL=C sort -u)"
found=0
total_kb=0
failed=0
while IFS= read -r base; do
  [ -d "$base" ] || continue
  for d in "$base"/bfs-cli-e2e.*; do
    [ -d "$d" ] || continue
    found=$((found + 1))
    kb="$(du -sk "$d" 2>/dev/null | cut -f1)"
    total_kb=$((total_kb + ${kb:-0}))
    if [ "$dry" = "1" ]; then
      printf '  would remove  %s  (%s KB)\n' "$d" "${kb:-?}"
      continue
    fi
    chmod -R u+w "$d" 2>/dev/null || true
    if rm -rf "$d" 2>/dev/null; then
      printf '  removed       %s  (%s KB)\n' "$d" "${kb:-?}"
    else
      printf '  FAILED (locked?)  %s\n' "$d" >&2
      failed=$((failed + 1))
    fi
  done
done <<EOF
$bases
EOF

if [ "$found" = "0" ]; then
  echo "No local bfs-cli-e2e.* workspaces found."
else
  verb="removed"; [ "$dry" = "1" ] && verb="would free"
  printf 'local: %d workspace(s), %s ~%d MB.\n' "$found" "$verb" "$((total_kb / 1024))"
fi

# ── Remote FTP test directories ──────────────────────────────────────────────
if [ "${#FTP_SPECS[@]}" -gt 0 ]; then
  TSX="$REPO_ROOT/node_modules/.bin/tsx"
  export TSX
  # shellcheck source=lib/providers.sh
  . "$SCRIPT_DIR/lib/providers.sh"
  # shellcheck source=lib/ftp-ops.sh
  . "$SCRIPT_DIR/lib/ftp-ops.sh"
  parse_ftp_specs
  if [ "$dry" = "1" ]; then
    echo "remote: would remove all bfs-e2e-* under $(ftp_count) FTP endpoint(s) (dry-run: skipped)."
  else
    echo "remote: removing all bfs-e2e-* from $(ftp_count) FTP endpoint(s)…"
    ftp_clean_all
  fi
fi

[ "$failed" -gt 0 ] && { echo "$failed local item(s) could not be removed (a process may still hold them open)." >&2; exit 1; }
exit 0
