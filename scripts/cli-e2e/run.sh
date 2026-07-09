#!/usr/bin/env bash
#
# BFS CLI end-to-end harness — drives the real `bfs` CLI through every
# create / restore / version-switch / disaster-recovery path, on local and FTP
# storage, and verifies each restore byte-for-byte (SHA-256).
#
# Mirrors the coverage of the automated suite (tests/e2e, tests/vault,
# tests/cli/{recovery,verify,prune,provider-remove}, tests/providers/ftp) but as
# a standalone, manually runnable shell script. Complements scripts/smoke.ts; it
# is dev tooling and is not shipped in the npm package.
#
# Usage:
#   bash scripts/cli-e2e/run.sh [options]
#
# Options:
#   --ftp "<spec>"   FTP credentials, repeatable. Spec grammar:
#                      [ftp[s]://]user:pass@host[:port]/basepath
#                    FTP scenarios are mandatory: without enough --ftp endpoints
#                    they FAIL (loudly) rather than silently skip.
#   --gdrive "<..>"  Reserved extension point for future built-in providers
#   --ssh    "<..>"  (collected but not yet wired — local + ftp are built in).
#   --filter <pat>   Run only scenarios whose directory name contains <pat>
#                    (e.g. --filter local, --filter 0, --filter ftp).
#   --exclude <pat>  Skip scenarios whose directory name contains <pat>
#                    (e.g. --exclude repair). Applied after --filter; the two
#                    split the suite into parallel CI jobs.
#   --local-only     Skip every scenario that requires FTP (REQUIRES_FTP > 0),
#                    selecting by metadata rather than name. Use on runners with
#                    no FTP container (e.g. windows-latest): all local scenarios
#                    run — including new ones — and FTP scenarios are reported
#                    SKIP instead of FAIL.
#   --ftp-only       Inverse of --local-only: skip every scenario that needs no
#                    FTP (REQUIRES_FTP == 0), running only FTP-requiring ones.
#                    Use to cover the FTP suite on a runner whose local scenarios
#                    are already exercised by a separate --local-only job (e.g. a
#                    Windows FTP job alongside the Windows local-only job).
#                    Mutually exclusive with --local-only.
#   --list           List discovered scenarios and their requirements, then exit.
#   --keep           Keep the temporary workspace for inspection (clean later
#                    with: bash scripts/cli-e2e/clean.sh).
#   --verbose, -v    Echo every `bfs` command sent and the response/exit code
#                    it returned (streams scenario output live).
#   --clean          Remove leftover --keep workspaces from temp, then exit
#                    (add --dry-run to only list them).
#   --dry-run        With --clean: list leftovers without deleting.
#   -h, --help       Show this help.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
export REPO_ROOT

# ── Argument parsing ─────────────────────────────────────────────────────────
FTP_SPECS=()
GDRIVE_SPECS=()
SSH_SPECS=()
RUN_FILTER=""
RUN_EXCLUDE=""
DO_LIST=0
LOCAL_ONLY=0
FTP_ONLY=0
KEEP_WS=0
DO_CLEAN=0
DRY_RUN=0
VERBOSE=0

usage() { sed -n '2,47p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ftp)    FTP_SPECS+=("${2:?--ftp requires a value}"); shift 2 ;;
    --gdrive) GDRIVE_SPECS+=("${2:?--gdrive requires a value}"); shift 2 ;;
    --ssh)    SSH_SPECS+=("${2:?--ssh requires a value}"); shift 2 ;;
    --filter) RUN_FILTER="${2:?--filter requires a value}"; shift 2 ;;
    --exclude) RUN_EXCLUDE="${2:?--exclude requires a value}"; shift 2 ;;
    --local-only) LOCAL_ONLY=1; shift ;;
    --ftp-only) FTP_ONLY=1; shift ;;
    --list)   DO_LIST=1; shift ;;
    --keep)   KEEP_WS=1; shift ;;
    --verbose|-v) VERBOSE=1; shift ;;
    --clean)  DO_CLEAN=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1" >&2; usage; exit 2 ;;
  esac
done
export KEEP_WS VERBOSE

# --local-only and --ftp-only partition the suite by FTP requirement; asking for
# both would skip every scenario, so it is a usage error rather than a no-op run.
if [ "$LOCAL_ONLY" = "1" ] && [ "$FTP_ONLY" = "1" ]; then
  echo "Options --local-only and --ftp-only are mutually exclusive." >&2
  exit 2
fi

# --clean dispatches to the standalone cleanup script and exits.
if [ "$DO_CLEAN" = "1" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    exec bash "$SCRIPT_DIR/clean.sh" --dry-run
  fi
  exec bash "$SCRIPT_DIR/clean.sh"
fi

# ── Load library ─────────────────────────────────────────────────────────────
# shellcheck source=lib/env.sh
. "$SCRIPT_DIR/lib/env.sh"
# shellcheck source=lib/bfs.sh
. "$SCRIPT_DIR/lib/bfs.sh"
# shellcheck source=lib/pty.sh
. "$SCRIPT_DIR/lib/pty.sh"
# shellcheck source=lib/assert.sh
. "$SCRIPT_DIR/lib/assert.sh"
# shellcheck source=lib/hash.sh
. "$SCRIPT_DIR/lib/hash.sh"
# shellcheck source=lib/fixtures.sh
. "$SCRIPT_DIR/lib/fixtures.sh"
# shellcheck source=lib/providers.sh
. "$SCRIPT_DIR/lib/providers.sh"
# shellcheck source=lib/ftp-ops.sh
. "$SCRIPT_DIR/lib/ftp-ops.sh"
# shellcheck source=lib/report.sh
. "$SCRIPT_DIR/lib/report.sh"

parse_ftp_specs

if [ ${#GDRIVE_SPECS[@]} -gt 0 ] || [ ${#SSH_SPECS[@]} -gt 0 ]; then
  echo "[cli-e2e] note: --gdrive/--ssh are reserved; only local + ftp providers" \
       "are built in, so those specs are currently ignored." >&2
fi

# ── Scenario discovery ───────────────────────────────────────────────────────
discover_scenarios() {
  local sc key
  for sc in "$SCRIPT_DIR"/scenarios/*/scenario.sh; do
    [ -f "$sc" ] || continue
    key="$(basename "$(dirname "$sc")")"
    case "$key" in _*) continue ;; esac
    if [ -n "$RUN_FILTER" ] && [[ "$key" != *"$RUN_FILTER"* ]]; then continue; fi
    if [ -n "$RUN_EXCLUDE" ] && [[ "$key" == *"$RUN_EXCLUDE"* ]]; then continue; fi
    printf '%s\n' "$sc"
  done | LC_ALL=C sort
}

# load_meta <scenario.sh> — source it and read its declared metadata into the
# globals SCENARIO_NAME/DESC/REQUIRES_LOCAL/REQUIRES_FTP and scenario_run().
load_meta() {
  SCENARIO_NAME=""; SCENARIO_DESC=""; REQUIRES_LOCAL=0; REQUIRES_FTP=0
  unset -f scenario_run 2>/dev/null || true
  # shellcheck disable=SC1090
  . "$1"
}

if [ "$DO_LIST" = "1" ]; then
  echo "Discovered scenarios (FTP endpoints available: $(ftp_count)):"
  while IFS= read -r sc; do
    [ -n "$sc" ] || continue
    load_meta "$sc"
    printf '  %-22s local=%s ftp=%s  %s\n' \
      "$(basename "$(dirname "$sc")")" "$REQUIRES_LOCAL" "$REQUIRES_FTP" "$SCENARIO_NAME"
  done < <(discover_scenarios)
  exit 0
fi

# ── Run ──────────────────────────────────────────────────────────────────────
env_init
# Clean up on normal exit AND on Ctrl+C / termination (INT/TERM exit → EXIT trap).
trap env_cleanup EXIT
trap 'exit 130' INT TERM

echo "[cli-e2e] workspace: $RUN_WS"
echo "[cli-e2e] bfs: tsx $BFS_ENTRY   |   FTP endpoints: $(ftp_count)"
echo

had_any=0
while IFS= read -r sc; do
  [ -n "$sc" ] || continue
  had_any=1
  key="$(basename "$(dirname "$sc")")"
  load_meta "$sc"

  SC_DIR="$RUN_WS/$key"
  SC_KEY="$key"
  mkdir -p "$SC_DIR"
  export SC_DIR SC_KEY
  log="$RUN_WS/$key.log"

  start=$SECONDS

  # --local-only: skip FTP scenarios by metadata (not name) so local-capable
  # runners (e.g. windows-latest, no FTP container) run every local scenario and
  # report the rest SKIP instead of FAIL. Selecting by REQUIRES_FTP means new
  # FTP scenarios are excluded automatically, with no name pattern to maintain.
  if [ "$LOCAL_ONLY" = "1" ] && [ "$REQUIRES_FTP" -gt 0 ]; then
    report_result SKIP "$key" "requires FTP" ""
    continue
  fi

  # --ftp-only: mirror of --local-only. Skip scenarios that need no FTP so a
  # dedicated FTP job runs only the FTP suite, without re-running local scenarios
  # already covered by a companion --local-only job. Selecting by REQUIRES_FTP
  # means new FTP scenarios join automatically, with no name pattern to maintain.
  if [ "$FTP_ONLY" = "1" ] && [ "$REQUIRES_FTP" -eq 0 ]; then
    report_result SKIP "$key" "local-only scenario" ""
    continue
  fi

  # FTP is mandatory: a scenario that needs more FTP endpoints than were
  # supplied fails with an actionable message instead of silently skipping.
  if [ "$REQUIRES_FTP" -gt "$(ftp_count)" ]; then
    {
      echo "scenario requires $REQUIRES_FTP FTP endpoint(s) but $(ftp_count) were provided."
      echo "supply them via repeated --ftp \"user:pass@host/path\" arguments."
    } >"$log"
    report_result FAIL "$key" "$((SECONDS - start))" "$log"
    continue
  fi

  # Run in a subshell as a standalone statement (NOT an `if` condition) and read
  # its exit code. Scenario failure is driven by _fail()/assertions calling
  # `exit 1`, so this is reliable regardless of bash `set -e` quirks.
  # --verbose streams the scenario's bfs commands + responses live (and still
  # tees to the log); otherwise output is captured and shown only on failure.
  if [ "$VERBOSE" = "1" ]; then
    echo "  ▶ $key — $SCENARIO_NAME"
    ( cd "$REPO_ROOT"; scenario_run ) 2>&1 | tee "$log"
    rc=${PIPESTATUS[0]}
  else
    ( cd "$REPO_ROOT"; scenario_run ) >"$log" 2>&1
    rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    report_result PASS "$key" "$((SECONDS - start))" "$log"
  else
    report_result FAIL "$key" "$((SECONDS - start))" "$log"
  fi
done < <(discover_scenarios)

if [ "$had_any" = "0" ]; then
  echo "No scenarios matched${RUN_FILTER:+ filter '$RUN_FILTER'}${RUN_EXCLUDE:+ exclude '$RUN_EXCLUDE'}." >&2
  exit 1
fi

report_summary
