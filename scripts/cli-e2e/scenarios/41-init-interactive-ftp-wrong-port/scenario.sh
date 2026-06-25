# shellcheck shell=bash
# Interactive `bfs init` recovers from a WRONG FTP PORT mid-flow, the same way it
# recovers from a wrong password (scenario 40) — proving the probe-retry behavior
# is not special-cased to credential (530) failures.
#
# Failure mode: the first FTP provider's port points at a CLOSED port on the
# real test host. basic-ftp's connect fails FAST with ECONNREFUSED (no waiting
# out FTP_TIMEOUT_MS), so the probe throws a ProviderError on the first attempt
# and the run stays well inside the PTY timeout. authenticate() then succeeds
# after RE-ENTER feeds the CORRECT port.
#
# Why a closed port, not an unreachable host: an unreachable host hangs the
# connect until FTP_TIMEOUT_MS (10s) per probe, which makes the PTY flaky unless
# PTY_TIMEOUT is raised. A closed port on the SAME reachable host refuses
# immediately — deterministic and fast. (Wrong-host is deliberately NOT covered
# here for exactly this reason.)
#
# Outcome asserted (mechanism-agnostic): a recovery prompt appears mid-flow,
# RE-ENTER with the correct port lets init finish, and a push/pull roundtrip
# restores byte-for-byte (SHA-256). This holds whether GREEN catches the bad
# port via the connectivity probe or an earlier validateConfig — what matters is
# that the operator gets a recovery prompt and the entered config is not lost.
#
# Coupling: the recovery prompt must contain RECOVERY_ANCHOR below — the same
# substring scenario 40 uses, from the i18n key probe_failed_prompt
# (src/i18n/en.ts + pl.ts). If that wording changes, update RECOVERY_ANCHOR in
# both scenarios to match en.ts.
#
# Run me (FTP required — local Docker FTP truncates parallel transfers, use the
# real test server):
#   bash scripts/cli-e2e/run.sh --ftp "<your-ftp-url>" \
#     --filter 41-init-interactive-ftp-wrong-port

SCENARIO_NAME="interactive init recovers from a wrong FTP port mid-flow"
SCENARIO_DESC="wrong FTP port (closed) during init → recovery prompt → re-enter → init completes, restore"
REQUIRES_LOCAL=0
REQUIRES_FTP=1

# Substring the GREEN fix's recovery prompt must contain (matches scenario 40).
RECOVERY_ANCHOR="Reconnection options"

# A port that is CLOSED on the test host: connect refuses immediately
# (ECONNREFUSED), so the probe fails fast instead of waiting out FTP_TIMEOUT_MS.
WRONG_PORT="9921"

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs41"
  make_fixtures "$vault"

  # Three FTP providers (2/1). build_pool creates each provider's remote base
  # directory up front and parses endpoint creds into FTP_* / PV_FTP_REMOTE.
  build_pool "$SC_DIR" 0 3 "$name"

  local host="${FTP_HOST[0]}" port="${FTP_PORT[0]}" user="${FTP_USER[0]}"
  local pass="${FTP_PASS[0]}" secure="${FTP_SECURE[0]}"
  local secure_ans="n"
  [ "$secure" = "true" ] && secure_ans="y"
  local r0="${PV_FTP_REMOTE[0]}" r1="${PV_FTP_REMOTE[1]}" r2="${PV_FTP_REMOTE[2]}"

  # Provider 0's FIRST port is WRONG (closed) → probe fails → recovery prompt →
  # RE-ENTER (choice 2: RETRY=1 / RE-ENTER=2 / ABORT=3) → re-run configure with
  # the CORRECT port → success. Providers 1 and 2 are correct from the start.
  local answers
  answers='[
    {"anchor":"Number of data copies","value":"2"},
    {"anchor":"Number of redundancy copies","value":"1"},
    {"anchor":"Provider name","value":"p0"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$WRONG_PORT"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$pass"'"},
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
  # The recovery prompt rendered and every scripted answer was fed — the bad port
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
