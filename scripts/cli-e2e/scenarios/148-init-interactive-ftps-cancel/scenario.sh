# shellcheck shell=bash
# Interactive `bfs init`: choosing "Cancel (end the command)" at an unknown FTPS
# certificate ends the command - it is a decision about the server, not a
# connection failure, so it never reaches the retry / re-enter / abort menu.
#
# The adapter's own questions run inside the same recovery loop as the
# connection test (an unreachable server while reading the certificate gets the
# menu - 147). The operator's refusal must not be caught by that loop: the trust
# menu promises the command ends.
#
# Correct: exit 1, the refusal names the certificate as not trusted, no
# reconnection menu, every scripted answer consumed, and the local storage
# typed before the FTPS one stays recorded (init writes storages as they pass).
#
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="interactive init ends when the operator cancels at an FTPS certificate"
SCENARIO_DESC="interactive init: one local storage, then FTPS with an unpinned cert; Cancel in the trust menu exits 1 without the reconnection menu, the local storage stays recorded"
REQUIRES_LOCAL=1
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificate"

  local vault="$SC_DIR/vault" name="bfs148"
  local ctr="bfs-e2e-${RUN_ID}-c148" vol="bfs-e2e-${RUN_ID}-v148"
  local port=2169 pmin=21410 pmax=21420
  local cert="$SC_DIR/cert.pem" key="$SC_DIR/key.pem"
  local cfg="$vault/.bfs/config.json"

  gen_selfsigned_cert "$cert" "$key" bfs-ftps-148 || _fail "could not generate the test certificate"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$cert" "$key" \
    || _fail "could not start FTPS server on port $port"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local   # q0 = local; the FTPS storage is typed by hand

  # Provider type is a rawlist in registration order: local=1, ftp=2. The trust
  # menu is a rawlist too: 1 trust, 2 go back, 3 cancel.
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
    {"anchor":"Provider type","value":"2"},
    {"anchor":"FTP host","value":"127.0.0.1"},
    {"anchor":"Port","value":"'"$port"'"},
    {"anchor":"Username","value":"bfsuser"},
    {"anchor":"Password","value":"bfspass"},
    {"anchor":"Base path on server","value":"/ftp/bfsuser"},
    {"anchor":"Use FTPS","value":"y"},
    {"anchor":"What would you like to do?","value":"3"}
  ]'

  PTY_TIMEOUT=60000 run_bfs_pty "$vault" "$answers" --lang en init "$name" --no-enc --no-compress
  # Exactly 1, so a hang on an unanswered menu (124) does not pass.
  assert_exit 1
  assert_out_contains "PROMPTS_FED=16/16"
  assert_out_contains "was not trusted"
  if printf '%s' "$BFS_OUT" | grep -qF "Reconnection options"; then
    _fail "the operator's refusal reached the reconnection menu instead of ending the command"
  fi

  assert_file "$cfg"
  local ids
  ids="$(node -e 'const j=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(j.providers.map((p)=>p.id).join(","))' "$(winpath "$cfg")")"
  [ "$ids" = "q0" ] || _fail "only the local storage typed before the refusal must be recorded, got: '${ids}'"

  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
