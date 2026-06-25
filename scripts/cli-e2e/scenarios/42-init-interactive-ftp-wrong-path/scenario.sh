# shellcheck shell=bash
# Interactive `bfs init` recovers from a WRONG FTP BASE PATH mid-flow, the same
# way it recovers from a wrong password (scenario 40) — proving the probe-retry
# behavior is not special-cased to credential (530) failures and covers the 550
# "directory operation failed" class too.
#
# Failure mode: the first FTP provider's base path is nested UNDER a regular
# file that exists on the server (…/obstacle/nested). probeConnection() calls
# ensureDir() on {basePath}/{vault}, whose first directory op steps into the
# file → the server answers 550 → ProviderError on the first probe. RE-ENTER
# then feeds the CORRECT (pre-created) remote path and the next probe succeeds.
#
# Why a file obstacle, not a merely-nonexistent path: a nonexistent path is
# silently created by ensureDir() on any account that may make directories, so
# the probe would SUCCEED on a permissive server and the recovery prompt would
# never fire. A path segment that is a file fails a directory op on every
# compliant FTP server, so this trigger is deterministic regardless of the
# account's create-directory permissions.
#
# Outcome asserted (mechanism-agnostic): a recovery prompt appears mid-flow,
# RE-ENTER with the correct path lets init finish, and a push/pull roundtrip
# restores byte-for-byte (SHA-256). GREEN may catch a bad path either at the
# connectivity probe (550) OR at an earlier validateConfig step — this scenario
# asserts only the OUTCOME (recovery prompt → re-enter → init completes →
# roundtrip), never which internal step fired. The wrong path used here is
# ABSOLUTE and well-formed (it just steps into a file), so a validateConfig that
# only rejects non-absolute paths would NOT short-circuit it — the failure must
# surface as a recoverable prompt the same way.
#
# Coupling: the recovery prompt must contain RECOVERY_ANCHOR below — the same
# substring scenario 40 uses, from the i18n key probe_failed_prompt
# (src/i18n/en.ts + pl.ts). If that wording changes, update RECOVERY_ANCHOR in
# both scenarios to match en.ts.
#
# Run me (FTP required):
#   bash scripts/cli-e2e/run.sh --ftp "<your-ftp-url>" \
#     --filter 42-init-interactive-ftp-wrong-path

SCENARIO_NAME="interactive init recovers from a wrong FTP base path mid-flow"
SCENARIO_DESC="wrong FTP base path (550 nonexistent) during init → recovery prompt → re-enter → init completes, restore"
REQUIRES_LOCAL=0
REQUIRES_FTP=1

# Substring the GREEN fix's recovery prompt must contain (matches scenario 40).
RECOVERY_ANCHOR="Reconnection options"

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs42"
  make_fixtures "$vault"

  # Three FTP providers (2/1). build_pool creates each provider's CORRECT remote
  # base directory up front and parses endpoint creds. The WRONG path below is
  # deliberately NOT among those — it does not exist on the server.
  build_pool "$SC_DIR" 0 3 "$name"

  local host="${FTP_HOST[0]}" port="${FTP_PORT[0]}" user="${FTP_USER[0]}"
  local pass="${FTP_PASS[0]}" secure="${FTP_SECURE[0]}"
  local secure_ans="n"
  [ "$secure" = "true" ] && secure_ans="y"
  local r0="${PV_FTP_REMOTE[0]}" r1="${PV_FTP_REMOTE[1]}" r2="${PV_FTP_REMOTE[2]}"

  # Plant a regular FILE inside this run's namespace, then point provider 0's
  # first base path at a directory NESTED UNDER it. ensureDir() in
  # probeConnection() steps into the file → 550 on any compliant server,
  # regardless of create-directory permissions (a merely-nonexistent path would
  # be auto-created on a permissive server and never fail). The obstacle lives
  # under bfs-e2e-<RUN_ID>, so env_cleanup removes it with the rest. Absolute
  # and well-formed, so a non-absolute-only validateConfig does not short it.
  local ep0="${PV_FTP_ENDPOINT[0]}"
  local obstacle="${FTP_BASE[$ep0]%/}/bfs-e2e-${RUN_ID}/obstacle"
  ftp_touch "$ep0" "$obstacle"
  local wrong_path="${obstacle}/nested"

  # Provider 0's FIRST base path is WRONG (steps into a file) → probe 550 → recovery
  # prompt → RE-ENTER (choice 2: RETRY=1 / RE-ENTER=2 / ABORT=3) → re-run
  # configure with the CORRECT path → success. Providers 1 and 2 are correct.
  local answers
  answers='[
    {"anchor":"Number of data copies","value":"2"},
    {"anchor":"Number of redundancy copies","value":"1"},
    {"anchor":"Provider name","value":"p0"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$pass"'"},
    {"anchor":"Base path on server","value":"'"$wrong_path"'"},
    {"anchor":"Use FTPS","value":"'"$secure_ans"'"},
    {"anchor":"'"$RECOVERY_ANCHOR"'","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$pass"'"},
    {"anchor":"Base path on server","value":"'"$r0"'"},
    {"anchor":"Use FTPS","value":"'"$secure_ans"'"},
    {"anchor":"Provider name","value":"p1"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$pass"'"},
    {"anchor":"Base path on server","value":"'"$r1"'"},
    {"anchor":"Use FTPS","value":"'"$secure_ans"'"},
    {"anchor":"Provider name","value":"p2"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$pass"'"},
    {"anchor":"Base path on server","value":"'"$r2"'"},
    {"anchor":"Use FTPS","value":"'"$secure_ans"'"},
    {"anchor":"Push mode","value":"1"},
    {"anchor":"RAM limit","value":"1024"}
  ]'

  run_bfs_pty "$vault" "$answers" --lang en init "$name" --no-enc --no-compress
  assert_ok
  # The recovery prompt rendered and every scripted answer was fed — the bad path
  # surfaced mid-flow as a recoverable prompt, not a crash.
  assert_out_contains "$RECOVERY_ANCHOR"
  assert_out_contains "PROMPTS_FED=35/35"
  # init completed: entered config was persisted, not discarded.
  assert_file "$vault/.bfs/config.json"

  # Roundtrip: the recovered config authenticates, so push/pull restore the
  # source byte-for-byte.
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
