#!/usr/bin/env bash
# shellcheck shell=bash
# Backward compatibility test: create a backup with an old BFS version (via Docker),
# then restore it with the current BFS. Tests both bfs pull and bfs recovery paths.
#
# Usage:
#   bash scripts/compat-fixtures/run.sh              # run all versions
#   bash scripts/compat-fixtures/run.sh 0.5.0        # run one version
#   bash scripts/compat-fixtures/run.sh --verbose    # run all, always show logs
#   bash scripts/compat-fixtures/run.sh 0.5.0 -v     # run one version verbosely
#
# Requires: docker, bfs (current version — see setup below)
# Windows note: run from WSL, not Git Bash — Docker volume mounts need Linux paths.
#
# WSL setup (one-time, or after code changes):
#   cd /mnt/d/projects/BFS
#   npm ci && npm run build && npm pack
#   npm install -g bfs-vault-*.tgz && rm bfs-vault-*.tgz

if command -v cygpath >/dev/null 2>&1; then
  echo "ERROR: Run this script in WSL or Linux, not Git Bash." >&2
  echo "       Open a WSL terminal: bash scripts/compat-fixtures/run.sh $*" >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERBOSE=0
VERSIONS=()

for arg in "$@"; do
  case "$arg" in
    --verbose|-v) VERBOSE=1 ;;
    --*) echo "Unknown flag: $arg" >&2; exit 1 ;;
    *) VERSIONS+=("$arg") ;;
  esac
done

# Auto-discover all v*.sh if no version given
if [ ${#VERSIONS[@]} -eq 0 ]; then
  while IFS= read -r f; do
    VERSIONS+=("$(basename "$f" .sh | sed 's/^v//')")
  done < <(ls -v "$SCRIPT_DIR"/v*.sh 2>/dev/null)
fi

if [ ${#VERSIONS[@]} -eq 0 ]; then
  echo "ERROR: No version scripts found in $SCRIPT_DIR" >&2; exit 1
fi

# Verify bfs is available and working (catches argon2 native binding issues)
if ! bfs -V >/dev/null 2>&1; then
  echo "ERROR: 'bfs' not found or not working. In WSL, run:" >&2
  echo "  cd /mnt/d/projects/BFS" >&2
  echo "  npm ci && npm run build && npm pack" >&2
  echo "  npm install -g bfs-vault-*.tgz && rm bfs-vault-*.tgz" >&2
  exit 1
fi

# ── Helpers ───────────────────────────────────────────────────────────────────

PASS_COUNT=0
FAIL_COUNT=0

_sep() { echo "--- $1 ---"; }

_show_log() {
  local label="$1" logfile="$2"
  echo ""
  _sep "$label"
  cat "$logfile"
  _sep "end"
}

# Run a command, capture output. Print it only on failure (or always if VERBOSE).
_run() {
  local label="$1"; shift
  local logfile; logfile="$(mktemp)"

  if [ "$VERBOSE" = "1" ]; then
    printf '    $ %s\n' "$*"
    "$@" 2>&1 | tee "$logfile"
    local rc=${PIPESTATUS[0]}
  else
    "$@" > "$logfile" 2>&1
    local rc=$?
  fi

  if [ $rc -ne 0 ] && [ "$VERBOSE" != "1" ]; then
    _show_log "$label" "$logfile"
  fi

  rm -f "$logfile"
  return $rc
}

# Run Docker with version script via stdin, capture output.
_run_docker() {
  local label="$1" base="$2" vault="$3" script="$4"
  local logfile; logfile="$(mktemp)"

  if [ "$VERBOSE" = "1" ]; then
    echo "    $ docker run bfs-vault@${OLD_VERSION}"
    docker run --rm -i -v "$base:$base" node:24-alpine \
      sh -s "$base" "$vault" < "$script" 2>&1 | tee "$logfile"
    local rc=${PIPESTATUS[0]}
  else
    docker run --rm -i -v "$base:$base" node:24-alpine \
      sh -s "$base" "$vault" < "$script" > "$logfile" 2>&1
    local rc=$?
  fi

  if [ $rc -ne 0 ] && [ "$VERBOSE" != "1" ]; then
    _show_log "$label" "$logfile"
  fi

  rm -f "$logfile"
  return $rc
}

_tick() { printf '  \033[32m✓\033[0m\n'; }
_cross(){ printf '  \033[31m✗\033[0m\n'; }

_verify_files() {
  local dir="$1" ok=1
  for f in hello.txt readme.md subdir/nested.txt binary.bin; do
    if [ ! -f "$dir/$f" ]; then
      echo "  MISSING: $f" >&2; ok=0
    fi
  done
  [ $ok -eq 0 ] && return 1
  local h
  h=$(sha256sum "$dir/hello.txt"         | awk '{print $1}'); [ "$h" = "$HASH_HELLO"  ] || { echo "  HASH MISMATCH: hello.txt"         >&2; return 1; }
  h=$(sha256sum "$dir/readme.md"         | awk '{print $1}'); [ "$h" = "$HASH_README" ] || { echo "  HASH MISMATCH: readme.md"         >&2; return 1; }
  h=$(sha256sum "$dir/subdir/nested.txt" | awk '{print $1}'); [ "$h" = "$HASH_NESTED" ] || { echo "  HASH MISMATCH: subdir/nested.txt" >&2; return 1; }
  h=$(sha256sum "$dir/binary.bin"        | awk '{print $1}'); [ "$h" = "$HASH_BINARY" ] || { echo "  HASH MISMATCH: binary.bin"        >&2; return 1; }
}

# ── Test one version ──────────────────────────────────────────────────────────

test_version() {
  local OLD_VERSION="$1"
  local BASE="/tmp/bfs-compat-$(echo "$OLD_VERSION" | tr '.' '-')"
  local VAULT_NAME="mytest"

  printf '\033[1mbfs@%s\033[0m → current\n' "$OLD_VERSION"

  local VERSION_SCRIPT="$SCRIPT_DIR/v${OLD_VERSION}.sh"
  if [ ! -f "$VERSION_SCRIPT" ]; then
    echo "  ERROR: no fixture script: $VERSION_SCRIPT" >&2
    FAIL_COUNT=$((FAIL_COUNT + 1))
    return 1
  fi

  # Clean up any leftover from a previous run (may be root-owned from Docker)
  sudo rm -rf "$BASE" 2>/dev/null || rm -rf "$BASE"
  mkdir -p "$BASE"/{src,p1,p2,p3,recovery-dir}
  mkdir -p "$BASE/src/subdir"
  export XDG_CONFIG_HOME="$BASE/.config"
  mkdir -p "$XDG_CONFIG_HOME/bfs"
  printf '{"language":"en"}' > "$XDG_CONFIG_HOME/bfs/settings.json"

  printf 'Hello from bfs@%s backward compat test\n' "$OLD_VERSION" > "$BASE/src/hello.txt"
  printf '# BFS backward compat\n\nLine 2\nLine 3\n'               > "$BASE/src/readme.md"
  printf 'Nested content inside subdir\n'                           > "$BASE/src/subdir/nested.txt"
  head -c 4096 /dev/urandom                                         > "$BASE/src/binary.bin"

  local HASH_HELLO HASH_README HASH_NESTED HASH_BINARY
  HASH_HELLO=$(sha256sum  "$BASE/src/hello.txt"          | awk '{print $1}')
  HASH_README=$(sha256sum "$BASE/src/readme.md"          | awk '{print $1}')
  HASH_NESTED=$(sha256sum "$BASE/src/subdir/nested.txt"  | awk '{print $1}')
  HASH_BINARY=$(sha256sum "$BASE/src/binary.bin"         | awk '{print $1}')

  local failed=0

  # Step 1 — Docker: create backup with old BFS
  printf '  [1/3] Docker: bfs@%s init + push... ' "$OLD_VERSION"
  if _run_docker "docker bfs@${OLD_VERSION}" "$BASE" "$VAULT_NAME" "$VERSION_SCRIPT"; then
    sudo chown -R "$(id -u):$(id -g)" "$BASE"
    _tick
  else
    _cross
    failed=1
  fi

  if [ $failed -eq 0 ]; then
    # Step 2 — Scenario A: pull
    printf '  [2/3] Scenario A: bfs pull...       '
    rm -f "$BASE/src/hello.txt" "$BASE/src/readme.md" \
          "$BASE/src/subdir/nested.txt" "$BASE/src/binary.bin"
    if _run "bfs pull" bfs --cwd "$BASE/src" pull --yes && _verify_files "$BASE/src"; then
      _tick
    else
      _cross
      failed=1
    fi
  fi

  if [ $failed -eq 0 ]; then
    # Step 3 — Scenario B: recovery + pull
    printf '  [3/3] Scenario B: bfs recovery...   '
    if _run "bfs recovery" bfs --cwd "$BASE/recovery-dir" recovery \
        --provider local --name "$VAULT_NAME" \
        --bootstrap "--path $BASE/p1" \
      && _run "bfs pull (recovery)" bfs --cwd "$BASE/recovery-dir" pull --yes \
      && _verify_files "$BASE/recovery-dir"; then
      _tick
    else
      _cross
      failed=1
    fi
  fi

  sudo rm -rf "$BASE" 2>/dev/null || rm -rf "$BASE"

  if [ $failed -eq 0 ]; then
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

# ── Main ──────────────────────────────────────────────────────────────────────

for v in "${VERSIONS[@]}"; do
  test_version "$v"
done

echo ""
if [ $FAIL_COUNT -eq 0 ]; then
  printf '\033[32m✓ All %d version(s) passed\033[0m\n' "$PASS_COUNT"
  exit 0
else
  printf '\033[31m✗ %d failed, %d passed\033[0m\n' "$FAIL_COUNT" "$PASS_COUNT"
  exit 1
fi
