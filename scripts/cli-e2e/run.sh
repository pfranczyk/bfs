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
#   --ssh "<spec>"   SSH/SFTP credentials, repeatable. Spec grammar:
#                      [ssh://]user:pass@host[:port]/basepath
#                    SSH scenarios are mandatory: without enough --ssh endpoints
#                    they FAIL (loudly) rather than silently skip.
#   --gdrive "<..>"  Reserved extension point for future built-in providers.
#   --filter <pat>   Run only scenarios whose directory name contains <pat>
#                    (e.g. --filter local, --filter 0, --filter ftp).
#   --exclude <pat>  Skip scenarios whose directory name contains <pat>,
#                    repeatable (e.g. --exclude repair --exclude ssh). Applied
#                    after --filter; together they split the suite into parallel
#                    CI jobs.
#   --local-only     Skip every scenario that requires FTP or SSH (REQUIRES_FTP
#                    > 0 or REQUIRES_SSH > 0), selecting by metadata rather than
#                    name. Use on runners with no FTP/SSH container (e.g.
#                    windows-latest): all pure-local scenarios run — including
#                    new ones — and remote scenarios are reported SKIP instead
#                    of FAIL.
#   --ftp-only       Inverse of --local-only: skip every scenario that needs no
#                    FTP (REQUIRES_FTP == 0), running only FTP-requiring ones.
#                    Use to cover the FTP suite on a runner whose local scenarios
#                    are already exercised by a separate --local-only job (e.g. a
#                    Windows FTP job alongside the Windows local-only job).
#                    Mutually exclusive with --local-only / --ssh-only.
#   --ssh-only       Like --ftp-only for SSH: skip every scenario that needs no
#                    SSH (REQUIRES_SSH == 0), running only SSH-requiring ones.
#                    Mutually exclusive with --local-only / --ftp-only.
#   --docker-only    Run ONLY docker-managed scenarios (REQUIRES_DOCKER > 0), which
#                    self-provision their own server and take NO external --ftp/--ssh
#                    endpoints. Mutually exclusive with the other --*-only flags.
#   --exclude-docker Skip docker-managed scenarios (REQUIRES_DOCKER > 0). A job that
#                    supplies external --ftp/--ssh endpoints MUST use this: the pool
#                    round-robins onto an external endpoint while the scenario asserts
#                    against its self-registered one, so it would falsely fail. Run
#                    the docker-managed scenarios in a companion --docker-only job.
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
RUN_EXCLUDE=()
DO_LIST=0
LOCAL_ONLY=0
FTP_ONLY=0
SSH_ONLY=0
DOCKER_ONLY=0
EXCLUDE_DOCKER=0
KEEP_WS=0
DO_CLEAN=0
DRY_RUN=0
VERBOSE=0

usage() { sed -n '2,62p' "${BASH_SOURCE[0]}" | sed 's/^#\{0,1\} \{0,1\}//'; }

while [ $# -gt 0 ]; do
  case "$1" in
    --ftp)    FTP_SPECS+=("${2:?--ftp requires a value}"); shift 2 ;;
    --gdrive) GDRIVE_SPECS+=("${2:?--gdrive requires a value}"); shift 2 ;;
    --ssh)    SSH_SPECS+=("${2:?--ssh requires a value}"); shift 2 ;;
    --filter) RUN_FILTER="${2:?--filter requires a value}"; shift 2 ;;
    --exclude) RUN_EXCLUDE+=("${2:?--exclude requires a value}"); shift 2 ;;
    --local-only) LOCAL_ONLY=1; shift ;;
    --ftp-only) FTP_ONLY=1; shift ;;
    --ssh-only) SSH_ONLY=1; shift ;;
    --docker-only) DOCKER_ONLY=1; shift ;;
    --exclude-docker) EXCLUDE_DOCKER=1; shift ;;
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

# --local-only / --ftp-only / --ssh-only partition the suite by remote
# requirement; asking for more than one would skip every scenario, so it is a
# usage error rather than a no-op run.
if [ $((LOCAL_ONLY + FTP_ONLY + SSH_ONLY + DOCKER_ONLY)) -gt 1 ]; then
  echo "Options --local-only, --ftp-only, --ssh-only and --docker-only are mutually exclusive." >&2
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
# shellcheck source=lib/ssh-ops.sh
. "$SCRIPT_DIR/lib/ssh-ops.sh"
# shellcheck source=lib/docker-endpoint.sh
. "$SCRIPT_DIR/lib/docker-endpoint.sh"
# shellcheck source=lib/report.sh
. "$SCRIPT_DIR/lib/report.sh"

parse_ftp_specs
parse_ssh_specs

if [ ${#GDRIVE_SPECS[@]} -gt 0 ]; then
  echo "[cli-e2e] note: --gdrive is reserved; no Google Drive provider is built" \
       "in yet, so those specs are currently ignored." >&2
fi

# ── Scenario discovery ───────────────────────────────────────────────────────
discover_scenarios() {
  local sc key pat
  for sc in "$SCRIPT_DIR"/scenarios/*/scenario.sh; do
    [ -f "$sc" ] || continue
    key="$(basename "$(dirname "$sc")")"
    case "$key" in _*) continue ;; esac
    if [ -n "$RUN_FILTER" ] && [[ "$key" != *"$RUN_FILTER"* ]]; then continue; fi
    local excluded=0
    for pat in "${RUN_EXCLUDE[@]:-}"; do
      [ -n "$pat" ] || continue
      if [[ "$key" == *"$pat"* ]]; then excluded=1; break; fi
    done
    [ "$excluded" = "1" ] && continue
    printf '%s\n' "$sc"
  done | LC_ALL=C sort
}

# load_meta <scenario.sh> — source it and read its declared metadata into the
# globals SCENARIO_NAME/DESC/REQUIRES_LOCAL/REQUIRES_FTP/REQUIRES_SSH and
# scenario_run().
load_meta() {
  SCENARIO_NAME=""; SCENARIO_DESC=""; REQUIRES_LOCAL=0; REQUIRES_FTP=0; REQUIRES_SSH=0; REQUIRES_DOCKER=0
  unset -f scenario_run 2>/dev/null || true
  # shellcheck disable=SC1090
  . "$1"
}

if [ "$DO_LIST" = "1" ]; then
  echo "Discovered scenarios (FTP endpoints: $(ftp_count), SSH endpoints: $(ssh_count)):"
  while IFS= read -r sc; do
    [ -n "$sc" ] || continue
    load_meta "$sc"
    printf '  %-22s local=%s ftp=%s ssh=%s docker=%s  %s\n' \
      "$(basename "$(dirname "$sc")")" "$REQUIRES_LOCAL" "$REQUIRES_FTP" "$REQUIRES_SSH" "$REQUIRES_DOCKER" "$SCENARIO_NAME"
  done < <(discover_scenarios)
  exit 0
fi

# ── Run ──────────────────────────────────────────────────────────────────────
env_init
# Clean up on normal exit AND on Ctrl+C / termination (INT/TERM exit → EXIT trap).
trap env_cleanup EXIT
trap 'exit 130' INT TERM

echo "[cli-e2e] workspace: $RUN_WS"
echo "[cli-e2e] bfs: tsx $BFS_ENTRY   |   FTP endpoints: $(ftp_count)   |   SSH endpoints: $(ssh_count)"
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

  # --local-only: skip remote scenarios by metadata (not name) so local-capable
  # runners (e.g. windows-latest, no FTP/SSH container) run every pure-local
  # scenario and report the rest SKIP instead of FAIL. Selecting by
  # REQUIRES_FTP/REQUIRES_SSH means new remote scenarios are excluded
  # automatically, with no name pattern to maintain.
  if [ "$LOCAL_ONLY" = "1" ] && { [ "$REQUIRES_FTP" -gt 0 ] || [ "$REQUIRES_SSH" -gt 0 ] || [ "$REQUIRES_DOCKER" -gt 0 ]; }; then
    report_result SKIP "$key" "requires remote provider" ""
    continue
  fi

  # Docker-managed scenarios self-provision their servers (real container
  # lifecycle). Without a usable Docker daemon they cannot run — SKIP (not FAIL:
  # there is no user-supplied endpoint to demand, and CI always has Docker).
  if [ "$REQUIRES_DOCKER" -gt 0 ] && ! docker_available; then
    report_result SKIP "$key" "requires Docker daemon" ""
    continue
  fi

  # --ftp-only: mirror of --local-only. Skip scenarios that need no FTP so a
  # dedicated FTP job runs only the FTP suite, without re-running local scenarios
  # already covered by a companion --local-only job. Selecting by REQUIRES_FTP
  # means new FTP scenarios join automatically, with no name pattern to maintain.
  if [ "$FTP_ONLY" = "1" ] && [ "$REQUIRES_FTP" -eq 0 ]; then
    report_result SKIP "$key" "not an FTP scenario" ""
    continue
  fi

  # A --ftp-only partition provides no SSH. A mixed scenario that ALSO needs SSH
  # (e.g. cross-type migration) is out of this job's scope — SKIP it (a companion
  # SSH job covers it) instead of tripping the "SSH mandatory" FAIL below.
  if [ "$FTP_ONLY" = "1" ] && [ "$REQUIRES_SSH" -gt 0 ] && [ "$(ssh_count)" -eq 0 ]; then
    report_result SKIP "$key" "also needs SSH — out of FTP-only scope" ""
    continue
  fi

  # --ssh-only: like --ftp-only for SSH. Run only SSH-requiring scenarios so a
  # dedicated SSH job (e.g. a Windows SSH job) covers just the SSH suite.
  if [ "$SSH_ONLY" = "1" ] && [ "$REQUIRES_SSH" -eq 0 ]; then
    report_result SKIP "$key" "not an SSH scenario" ""
    continue
  fi

  # Mirror of the FTP-only guard: a --ssh-only partition provides no FTP, so a
  # mixed scenario that ALSO needs FTP is out of scope — SKIP, not FAIL.
  if [ "$SSH_ONLY" = "1" ] && [ "$REQUIRES_FTP" -gt 0 ] && [ "$(ftp_count)" -eq 0 ]; then
    report_result SKIP "$key" "also needs FTP — out of SSH-only scope" ""
    continue
  fi

  # --docker-only: run ONLY docker-managed scenarios (they self-provision their
  # server and take no external endpoints). Mirror of --ssh-only.
  if [ "$DOCKER_ONLY" = "1" ] && [ "$REQUIRES_DOCKER" -eq 0 ]; then
    report_result SKIP "$key" "not a Docker-managed scenario" ""
    continue
  fi

  # --exclude-docker: a job supplying external --ftp/--ssh endpoints skips
  # docker-managed scenarios. Their self-registered endpoint is appended after the
  # external ones, but the round-robin pool picks endpoint 0 (external) while the
  # scenario asserts against its own — a false failure. Run them via --docker-only.
  if [ "$EXCLUDE_DOCKER" = "1" ] && [ "$REQUIRES_DOCKER" -gt 0 ]; then
    report_result SKIP "$key" "docker-managed (run via --docker-only)" ""
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

  # SSH is mandatory in the same way: too few --ssh endpoints is a loud FAIL,
  # never a silent skip.
  if [ "$REQUIRES_SSH" -gt "$(ssh_count)" ]; then
    {
      echo "scenario requires $REQUIRES_SSH SSH endpoint(s) but $(ssh_count) were provided."
      echo "supply them via repeated --ssh \"user:pass@host/path\" arguments."
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
  exclude_joined="${RUN_EXCLUDE[*]:-}"
  echo "No scenarios matched${RUN_FILTER:+ filter '$RUN_FILTER'}${exclude_joined:+ exclude '$exclude_joined'}." >&2
  exit 1
fi

report_summary
