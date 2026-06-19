# shellcheck shell=bash
# Recovery credential-phishing — CONSENSUS path (≥2 honest siblings reachable).
#
# With encryption off, a shard's location_map is raw JSON guarded only by an
# UNKEYED trailing SHA-256: an attacker who rewrites ONE shard can redirect a
# sibling provider's coordinates to a host they control, and the re-sealed shard
# is byte-valid (the checksum still matches).
#
# Layout: 3 LOCAL providers (2 data + 1 parity). Only shard_0 (the bootstrap
# source) is forged — its location_map entry for shard_1 is redirected at the
# FTP trap. shard_1 and shard_2 are left HONEST and reachable; their own headers
# carry the genuine location_map. So bootstrap has ≥2 honest siblings to cross-
# check against the forged bootstrap shard.
#
# GREEN contract: recovery cross-checks the bootstrap shard's location_map
# against the reachable honest siblings, detects the divergence, and ABORTS
# BEFORE collecting or sending any secret. Therefore:
#   - the operator's secret must NOT reach the trap, AND
#   - the password prompt must NOT fire (consensus aborts earlier).
#
# RED contract (today): bootstrap performs no location_map cross-check, so it
# connects to the forged sibling (trap) and/or prompts for the secret — the
# secret leaks and/or the prompt fires. Either is a RED FAIL here.

SCENARIO_NAME="recovery consensus abort (forged bootstrap, honest siblings reachable)"
SCENARIO_DESC="forged bootstrap shard diverges from honest siblings; recovery must abort before any secret"
REQUIRES_LOCAL=1
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs34a"
  local secret="S3CRET-victim-pw"
  local trap_log="$SC_DIR/trap.log"
  local trap_out="$SC_DIR/trap.out"
  local trap_driver
  trap_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/ftp-trap.mjs"
  local tamper_driver
  tamper_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/tamper-shard.ts"

  make_fixtures "$vault"
  # p0/p1/p2 all LOCAL. 2 data + 1 parity = exactly 3 providers (N>=2 required).
  build_pool_seq "$SC_DIR" "$name" local local local

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # ── Start the attacker trap server on an ephemeral 127.0.0.1 port ──────────
  : >"$trap_log"
  node "$(winpath "$trap_driver")" "$(winpath "$trap_log")" 0 >"$trap_out" 2>&1 &
  local trap_pid=$!
  # shellcheck disable=SC2317  # invoked via trap below
  _trap_cleanup() { kill "$trap_pid" 2>/dev/null || true; }
  trap _trap_cleanup EXIT

  local trap_port="" waited=0
  while [ -z "$trap_port" ]; do
    if [ -s "$trap_out" ]; then
      trap_port="$(grep -oE 'LISTENING [0-9]+' "$trap_out" | head -1 | awk '{print $2}')"
    fi
    [ -n "$trap_port" ] && break
    sleep 0.1
    waited=$((waited + 1))
    [ "$waited" -lt 100 ] || _fail "trap server never reported LISTENING (10s). Output:
$(cat "$trap_out" 2>/dev/null)"
  done

  # ── Forge ONLY shard_0 (bootstrap): redirect its entry for shard_1 ─────────
  # shard_1 and shard_2 stay honest, so their headers still describe shard_1 as
  # a local provider — diverging from the forged bootstrap map.
  local shard0
  shard0="$(shard_file 0 1)"
  assert_file "$shard0"
  BFS_OUT="$("$TSX" "$(winpath "$tamper_driver")" "$(winpath "$shard0")" 1 127.0.0.1 "$trap_port" 2>&1)" || true
  printf '%s' "$BFS_OUT" | grep -qF "TAMPERED" || _fail "tamper helper did not forge the shard. Output:
$BFS_OUT"

  # Catastrophe: local metadata gone. Recovery must rebuild from the (forged)
  # bootstrap shard on p0 — but honest siblings p1/p2 remain reachable.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Drive recovery through a PTY. If the (buggy) code prompts for the trap
  # password we answer with the secret — that is precisely the leak we assert
  # must NOT happen. The trap rejects the login (530); a short timeout kills
  # recovery after any leak has already occurred.
  local answers
  answers='[{"anchor":"required to reconnect during recovery","value":"'"$secret"'"}]'
  PTY_TIMEOUT=12000 run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"

  # Give the trap a beat to flush any captured PASS line to disk.
  sleep 0.3

  # ── RED assertion 1: the operator's secret must NOT reach the attacker host ─
  if grep -qF "$secret" "$trap_log"; then
    _fail "secret leaked to attacker host — captured in trap log:
$(cat "$trap_log")"
  fi

  # ── RED assertion 2: the password prompt must NOT have fired ───────────────
  # Consensus must abort before reaching the secret-collection step. The PTY
  # driver prints PROMPTS_FED=N/M on clean exit and "prompts fed: N/M" on
  # timeout; in both forms a fed count > 0 means a secret prompt ran.
  if printf '%s' "$BFS_OUT" | grep -qE 'PROMPTS_FED=[1-9]|prompts fed: [1-9]'; then
    _fail "password prompt fired — consensus did not abort before secret collection. Output:
$BFS_OUT"
  fi

  return 0
}
