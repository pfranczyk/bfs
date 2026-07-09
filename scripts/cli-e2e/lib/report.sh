# shellcheck shell=bash
# Result accumulation and reporting (mirrors the PASS/FAIL/SKIP style of
# scripts/smoke.ts). Scenario logs are buffered and only shown on failure.

REPORT_PASS=0
REPORT_FAIL=0
REPORT_SKIP=0
REPORT_FAILED_NAMES=()

# report_result <status> <name> <arg> <logfile>
#   status: PASS | FAIL | SKIP
#   For PASS/FAIL <arg> is the elapsed seconds; for SKIP it is the skip reason.
#   SKIP records a scenario deliberately not run (e.g. --local-only skipping an
#   FTP scenario) — reported and counted so the selection is never silent.
report_result() {
  local status="$1" name="$2" arg="$3" logfile="$4"
  case "$status" in
    PASS)
      REPORT_PASS=$((REPORT_PASS + 1))
      printf '  \033[32m✓\033[0m %-32s (%ss)\n' "$name" "$arg"
      ;;
    FAIL)
      REPORT_FAIL=$((REPORT_FAIL + 1))
      REPORT_FAILED_NAMES+=("$name")
      printf '  \033[31m✗\033[0m %-32s (%ss)\n' "$name" "$arg"
      if [ -f "$logfile" ]; then
        sed 's/^/      /' "$logfile"
      fi
      ;;
    SKIP)
      REPORT_SKIP=$((REPORT_SKIP + 1))
      printf '  \033[33m∅\033[0m %-32s (skip: %s)\n' "$name" "$arg"
      ;;
  esac
}

# report_summary — print totals; return 1 if any scenario failed.
report_summary() {
  echo
  echo "─────────────────────────────────────────────"
  printf '[cli-e2e] %d passed, %d failed, %d skipped\n' "$REPORT_PASS" "$REPORT_FAIL" "$REPORT_SKIP"
  if [ "$REPORT_FAIL" -gt 0 ]; then
    printf '          failed: %s\n' "${REPORT_FAILED_NAMES[*]}"
    return 1
  fi
  return 0
}
