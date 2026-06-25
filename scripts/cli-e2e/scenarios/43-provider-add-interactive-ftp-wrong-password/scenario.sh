# shellcheck shell=bash
# Interactive `bfs provider add` recovers from a bad FTP credential mid-flow,
# the same way interactive `bfs init` does (scenarios 40 / 42).
#
# The promise protected: extending an existing backup with another storage is
# not a brittle all-or-nothing keystroke marathon. When the new provider's
# connectivity probe fails, the operator is offered a recovery choice (retry /
# re-enter / abort) and fixes that one provider in place — the entered config is
# preserved and the add completes, instead of crashing out with the work lost.
#
# This scenario stands up a healthy 2/1 FTP vault (3 providers) via interactive
# init + push, then drives interactive `bfs provider add` through a PTY for a
# 4th FTP provider, deterministically fumbling its PASSWORD. A wrong password
# makes authenticate() fail with 530 on every compliant server — unlike a wrong
# path, which a permissive server may silently create and never reject — so the
# probe failure is deterministic. The scenario then RE-ENTERs the correct
# password + path, asserts the add completes, and confirms a push/pull roundtrip
# (now rebalanced to 2/2) restores byte-for-byte (SHA-256).
#
# Coupling: the recovery prompt must contain RECOVERY_ANCHOR below — the same
# substring scenarios 40 / 42 use, from the i18n key probe_failed_prompt
# (src/i18n/en.ts + pl.ts). If that wording changes, update RECOVERY_ANCHOR in
# all three scenarios to match the en.ts value.
#
# Mechanism: interactive `bfs provider add` routes its connectivity probe through
# the same recovery loop init uses. A wrong password fails the probe with 530
# mid-flow, the "Reconnection options" prompt appears, and RE-ENTER with the
# correct password lets the add finish — the entered config is fixed in place
# instead of the whole command aborting with the work lost.
#
# Run me (FTP required — local Docker FTP truncates parallel transfers, use the
# real test server):
#   bash scripts/cli-e2e/run.sh --ftp "<your-ftp-url>" \
#     --filter 43-provider-add-interactive-ftp-wrong-password

SCENARIO_NAME="interactive provider add recovers from a bad FTP password mid-flow"
SCENARIO_DESC="wrong FTP password during provider add → recovery prompt → re-enter → add completes, restore"
REQUIRES_LOCAL=0
REQUIRES_FTP=1

# Substring the GREEN fix's recovery prompt must contain (matches scenarios 40/42).
RECOVERY_ANCHOR="Reconnection options"

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs43"
  make_fixtures "$vault"

  # Three FTP providers (2/1). build_pool creates each provider's remote base
  # directory up front (bfs init lists it) and parses the endpoint creds into
  # FTP_* / PV_FTP_REMOTE so we can type them into the interactive prompts.
  build_pool "$SC_DIR" 0 3 "$name"

  # Endpoint creds (all FTP providers share one endpoint, distinct paths).
  local host="${FTP_HOST[0]}" port="${FTP_PORT[0]}" user="${FTP_USER[0]}"
  local pass="${FTP_PASS[0]}" secure="${FTP_SECURE[0]}"
  local secure_ans="n"
  [ "$secure" = "true" ] && secure_ans="y"
  local r0="${PV_FTP_REMOTE[0]}" r1="${PV_FTP_REMOTE[1]}" r2="${PV_FTP_REMOTE[2]}"

  # Healthy 2/1 backup: interactive init with all-correct values, then push.
  local init_answers
  init_answers='[
    {"anchor":"Number of data copies","value":"2"},
    {"anchor":"Number of redundancy copies","value":"1"},
    {"anchor":"Provider name","value":"p0"},
    {"anchor":"Provider type","value":"2"},
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
  run_bfs_pty "$vault" "$init_answers" --lang en init "$name" --no-enc --no-compress
  assert_ok
  assert_out_contains "PROMPTS_FED=28/28"
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Pre-create the 4th provider's CORRECT remote directory. build_pool only made
  # dirs for the three pooled providers, so the new one needs its own mkdir
  # (under this run's namespace, so env_cleanup removes it with the rest).
  local ep0="${PV_FTP_ENDPOINT[0]}"
  local r3="${FTP_BASE[$ep0]%/}/bfs-e2e-${RUN_ID}/p3"
  FC_PATHS="${r3}|" _ftp_op "$ep0" mkdir

  local wrong="definitely-wrong-${RUN_ID}"

  # Interactive `bfs provider add` for the 4th FTP provider. Prompt order:
  #   "New provider name:" → "Provider type:" (ftp=2) → FTP host / Port /
  #   Username / Password / Base path / Use FTPS.
  # The FIRST password is WRONG → authenticate() fails 530 → recovery prompt →
  # RE-ENTER (choice 2: RETRY=1 / RE-ENTER=2 / ABORT=3) → the provider's
  # configure prompts re-run with the CORRECT password → success.
  local add_answers
  add_answers='[
    {"anchor":"New provider name","value":"p3"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$wrong"'"},
    {"anchor":"Base path on server","value":"'"$r3"'"},
    {"anchor":"Use FTPS","value":"'"$secure_ans"'"},
    {"anchor":"'"$RECOVERY_ANCHOR"'","value":"2"},
    {"anchor":"FTP host","value":"'"$host"'"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"'"$user"'"},
    {"anchor":"Password","value":"'"$pass"'"},
    {"anchor":"Base path on server","value":"'"$r3"'"},
    {"anchor":"Use FTPS","value":"'"$secure_ans"'"}
  ]'
  run_bfs_pty "$vault" "$add_answers" --lang en provider add
  assert_ok
  # The recovery prompt rendered and every scripted answer was fed — the bad
  # credential surfaced mid-flow as a recoverable prompt, not a crash.
  assert_out_contains "$RECOVERY_ANCHOR"
  assert_out_contains "PROMPTS_FED=15/15"

  # The add persisted a 4th provider and bumped parity (2/1 → 2/2).
  if ! grep -q '"id": "p3"' "$vault/.bfs/config.json"; then
    _fail "provider p3 not persisted in config.json
--- config ---
$(cat "$vault/.bfs/config.json")"
  fi
  if ! grep -q '"parity_shards": 2' "$vault/.bfs/config.json"; then
    _fail "parity_shards not bumped to 2 after add
--- config ---
$(cat "$vault/.bfs/config.json")"
  fi

  # Roundtrip: a fresh push rebalances to 2/2 across all four providers; pull
  # restores the source byte-for-byte.
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 2 healthy
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
