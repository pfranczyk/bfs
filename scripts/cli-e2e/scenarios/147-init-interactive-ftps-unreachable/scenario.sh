# shellcheck shell=bash
# Interactive `bfs init` whose FTPS storage does not answer while its
# certificate is being read: the operator gets the reconnection menu, and
# aborting there keeps the storages already set up.
#
# Configuring an FTPS storage reads the server certificate before anything is
# probed, so an unreachable server fails inside the configuration questions
# themselves. That failure has to reach the same menu as a failed probe
# (retry / re-enter / abort) instead of ending the command with the backup
# name, the scheme and every storage typed so far. Aborting at the menu ends
# with exit 1 and no stack trace, and the two local storages that passed before
# it are on disk - the next `bfs init` here resumes from them.
#
# The answers follow the order of the questions: push mode and the RAM limit
# come before the storages, so the file carries them from its first write.
#
# Needs no server: the FTPS endpoint is a port nothing listens on.

SCENARIO_NAME="interactive init offers the menu when an FTPS server does not answer"
SCENARIO_DESC="interactive init: two local storages, then FTPS on a dead port; the failed certificate read reaches the retry/re-enter/abort menu, abort exits 1 without a stack trace, both local storages stay recorded"
REQUIRES_LOCAL=2
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs147"
  local dead_port=2199
  local cfg="$vault/.bfs/config.json"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local   # the FTPS storage is typed by hand below

  # Provider type is a rawlist in registration order: local=1, ftp=2. The menu
  # is a rawlist too: 1 retry, 2 re-enter, 3 abort.
  local answers
  answers='[
    {"anchor":"Number of data copies","value":"2"},
    {"anchor":"Number of redundancy copies","value":"1"},
    {"anchor":"Push mode","value":"1"},
    {"anchor":"RAM limit","value":"1024"},
    {"anchor":"Provider name","value":"q0"},
    {"anchor":"Provider type","value":"1"},
    {"anchor":"Base directory path","value":"'"$(winpath "${PV_LOCALDIR[0]}")"'"},
    {"anchor":"Provider name","value":"q1"},
    {"anchor":"Provider type","value":"1"},
    {"anchor":"Base directory path","value":"'"$(winpath "${PV_LOCALDIR[1]}")"'"},
    {"anchor":"Provider name","value":"q2"},
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$dead_port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password","value":"bfspass"},
    {"anchor":"Base path on server","value":"/ftp/bfsuser"},
    {"anchor":"Use FTPS","value":"y"},
    {"anchor":"Reconnection options","value":"3"}
  ]'

  PTY_TIMEOUT=60000 run_bfs_pty "$vault" "$answers" --lang en init "$name" --no-enc --no-compress
  # Exactly 1, so a hang on an unanswered prompt (124) does not pass. The exit
  # code alone does not tell the menu from the failure ending the command - both
  # give 1 - so what decides is below: every answer fed (the menu rendered and
  # was answered) and the storages still recorded.
  assert_exit 1
  assert_out_contains "PROMPTS_FED=19/19"
  assert_out_contains "Re-enter this provider's settings"
  if printf '%s' "$BFS_OUT" | grep -qE '^[[:space:]]+at [^ ]+ \('; then
    _fail "the failed certificate read ended in a stack trace"
  fi

  assert_file "$cfg"
  local ids
  ids="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.providers.map((p)=>p.id).join(","))' "$(winpath "$cfg")")"
  [ "$ids" = "q0,q1" ] || _fail "the storages set up before the abort must stay recorded, got: '${ids}'"
  return 0
}
