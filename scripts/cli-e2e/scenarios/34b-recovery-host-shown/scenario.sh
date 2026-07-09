# shellcheck shell=bash
# Recovery credential-phishing — PROCEDURAL-GATE path (no honest sibling
# reachable, so the consensus cross-check cannot save the operator).
#
# Layout: 3 LOCAL providers (2 data + 1 parity). shard_0 (bootstrap) is forged
# to redirect its entry for shard_1 at the FTP trap. The honest siblings are
# then made UNREACHABLE (their provider directories removed) so recovery has
# nothing to cross-check against — consensus is skipped and the only remaining
# defence is procedural: prove the connection target to the operator BEFORE
# asking for or sending any secret.
#
# GREEN contract: before collecting/sending the transport secret, recovery must
# surface the destination host:port to the operator. So the trap target
# "127.0.0.1:<trap_port>" MUST appear in recovery output before the secret is
# sent. (Positive assertion — proof the host was shown.)
#
# RED contract (today): the secret prompt only names the field + provider id
# (recovery_ask_transport_password) and never the host — so 127.0.0.1:<port>
# does NOT appear in the output → RED. Asserting on the host coordinate (not the
# i18n wording, which lands in GREEN) keeps the test robust.

SCENARIO_NAME="recovery host shown before secret (procedural gate, no honest sibling)"
SCENARIO_DESC="forged bootstrap, siblings unreachable; recovery must show the redirected host before any secret"
REQUIRES_LOCAL=1
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs34b"
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
  # Cleanup: shut the trap down over its port once we know it. Interpolate the
  # values into the trap string so the EXIT handler still has them after
  # scenario_run returns (a local read there comes back empty). See ftp_trap_stop.
  trap "ftp_trap_stop '$trap_port' '$trap_pid'" EXIT

  # ── Forge shard_0 (bootstrap): redirect its entry for shard_1 to the trap ──
  local shard0
  shard0="$(shard_file 0 1)"
  assert_file "$shard0"
  BFS_OUT="$("$TSX" "$(winpath "$tamper_driver")" "$(winpath "$shard0")" 1 127.0.0.1 "$trap_port" 2>&1)" || true
  printf '%s' "$BFS_OUT" | grep -qF "TAMPERED" || _fail "tamper helper did not forge the shard. Output:
$BFS_OUT"

  # Make the honest siblings UNREACHABLE so consensus is skipped: drop p1's and
  # p2's vault directories. The bootstrap shard on p0 survives; the only sibling
  # named in the forged map (shard_1 → trap) is what recovery tries to reach.
  rm -rf "${PV_LOCALDIR[1]:?}/$name" "${PV_LOCALDIR[2]:?}/$name"

  # Catastrophe: local metadata gone. Recovery must rebuild from the forged
  # bootstrap shard on p0.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Drive recovery through a PTY, answering the password prompt with the secret.
  # The trap rejects the login (530); a short timeout kills recovery afterward.
  local answers
  answers='[{"anchor":"required to reconnect during recovery","value":"'"$secret"'"}]'
  PTY_TIMEOUT=12000 run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"

  # ── RED assertion (positive): the redirected host MUST be shown to the ─────
  # operator. Match on the host coordinate, not the i18n wording (which is
  # written in GREEN), so the test is robust to message phrasing.
  local target="127.0.0.1:${trap_port}"
  if ! printf '%s' "$BFS_OUT" | grep -qF "$target"; then
    _fail "recovery did not show the redirected host ($target) before requesting the secret. Output:
$BFS_OUT"
  fi

  return 0
}
