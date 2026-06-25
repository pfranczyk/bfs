# shellcheck shell=bash
# Interactive `bfs init` recovers from a bad FTP credential mid-flow, keeping
# the config the operator already entered.
#
# The promise protected: creating a backup is not a brittle all-or-nothing
# keystroke marathon. When a provider's connectivity probe fails, the operator
# is offered a recovery choice (retry / re-enter / abort) and fixes that one
# provider in place — every other value already entered is preserved.
#
# This scenario drives the real `bfs init` through a PTY, deterministically
# fumbles the FIRST FTP provider's password, asserts a recovery prompt appears,
# RE-ENTERs the correct password, and confirms init completes — followed by a
# push/pull roundtrip that restores byte-for-byte (SHA-256).
#
# Determinism: the failure is a WRONG-then-RIGHT password (not the flaky "530
# max connections"), so authenticate() fails on the first probe and succeeds
# after RE-ENTER, every run. --lang en keeps the PTY anchors stable.
#
# Coupling: the recovery prompt must contain the RE-ENTER anchor below
# ("Reconnection options"), which comes from the i18n key probe_failed_prompt
# (src/i18n/en.ts + pl.ts). If that wording changes, update RECOVERY_ANCHOR here
# to match the en.ts value.
#
# Run me (FTP required — local Docker FTP truncates parallel transfers, use the
# real test server):
#   bash scripts/cli-e2e/run.sh --ftp "<your-ftp-url>" \
#     --filter 40-init-interactive-ftp-recovery

SCENARIO_NAME="interactive init recovers from a bad FTP password mid-flow"
SCENARIO_DESC="wrong FTP password during init → recovery prompt → re-enter → init completes, restore"
REQUIRES_LOCAL=0
REQUIRES_FTP=1

# Substring the GREEN fix's recovery prompt must contain (see NOTE above).
RECOVERY_ANCHOR="Reconnection options"

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs40"
  make_fixtures "$vault"

  # Three FTP providers (2/1). build_pool creates each provider's remote base
  # directory up front (bfs init lists it), and parses the endpoint creds into
  # FTP_* / PV_FTP_REMOTE so we can type them into the interactive prompts.
  build_pool "$SC_DIR" 0 3 "$name"

  # Endpoint creds (all three FTP providers share one endpoint, distinct paths).
  local host="${FTP_HOST[0]}" port="${FTP_PORT[0]}" user="${FTP_USER[0]}"
  local pass="${FTP_PASS[0]}" secure="${FTP_SECURE[0]}"
  local secure_ans="n"
  [ "$secure" = "true" ] && secure_ans="y"
  local r0="${PV_FTP_REMOTE[0]}" r1="${PV_FTP_REMOTE[1]}" r2="${PV_FTP_REMOTE[2]}"
  local wrong="definitely-wrong-${RUN_ID}"

  # Interactive init answer script (fed in order as each anchor appears). enc and
  # compression are turned off via flags so only scheme + per-provider + push +
  # RAM prompts remain. Provider type is a rawlist: local=1, ftp=2 (registration
  # order). Provider 0's FIRST password is WRONG → authenticate() fails →
  # recovery prompt → RE-ENTER (choice 2: RETRY=1 / RE-ENTER=2 / ABORT=3) → the
  # provider's configure prompts re-run with the CORRECT password → success.
  local answers
  answers='[
    {"anchor":"Number of data copies","value":"2"},
    {"anchor":"Number of redundancy copies","value":"1"},
    {"anchor":"Provider name","value":"p0"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$wrong"'"},
    {"anchor":"Base path on server","value":"'"$r0"'"},
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
  # The recovery prompt must have rendered and been answered (every scripted
  # answer fed) — proves the bad credential surfaced mid-flow as a recoverable
  # prompt, not a crash.
  assert_out_contains "$RECOVERY_ANCHOR"
  assert_out_contains "PROMPTS_FED=35/35"
  # init completed: config + the three providers were persisted (entered config
  # was NOT discarded).
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
