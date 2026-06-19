# shellcheck shell=bash
# S3 — "unconfirmed config after recovery" gate, exercised through the FIRST
# push after a disaster recovery.
#
# With encryption off, a shard's location_map is raw JSON guarded only by an
# UNKEYED trailing SHA-256, so an attacker who can rewrite a shard can redirect
# a sibling provider's coordinates to a host they control. `bfs recovery`
# rebuilds .bfs/config.json straight from that untrusted map, so an attacker
# host can land in the operator's local config.
#
# Escalation under test: the NEXT `bfs push` packs the local directory and ships
# a shard to whatever the recovered config says — i.e. to the attacker's host —
# leaking the operator's own data (and any reused transport secret) to the trap.
#
# Setup models the net effect: a clean recovery rebuilds config from the remote
# headers (recovery's own connect-to-attacker behaviour is covered by 34a/34b),
# then one recovered provider entry is rewritten to point at the FTP trap — the
# untrusted coordinate an attacker would have planted in the location map. The
# assertion is on the FIRST push after recovery.
#
# GREEN contract: recovery marks the recovered config UNCONFIRMED
# (state.locations_confirmed=false), and the first write op (push) must have the
# operator confirm the provider locations BEFORE uploading. A non-interactive
# push (no TTY) cannot satisfy that confirmation, so push must abort WITHOUT
# contacting the attacker host. Therefore the trap log stays EMPTY after push.
#
# RED contract (today): push has no gate, so it connects to the rewritten FTP
# provider and tries to log in — the trap captures the USER/PASS handshake. A
# non-empty trap log after the first push is the RED FAIL.

SCENARIO_NAME="push after recovery gate (untrusted recovered host must not leak first push)"
SCENARIO_DESC="recovery leaves config unconfirmed; the first push must confirm provider locations before reaching an attacker host"
REQUIRES_LOCAL=1
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs36"
  local cfg="$vault/.bfs/config.json"
  local trap_log="$SC_DIR/trap.log"
  local trap_out="$SC_DIR/trap.out"
  local trap_driver
  trap_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/ftp-trap.mjs"

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

  # Catastrophe: local metadata gone. The three local providers survive, so a
  # bootstrap from p0 rebuilds config + manifests from the (honest) remote map.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$cfg"

  # Plant the untrusted coordinate an attacker would have injected into the
  # location map: redirect provider p1 at the FTP trap. node -e for a
  # cross-platform JSON edit (Git Bash on Windows, Linux/Ubuntu on CI).
  node -e '
    const fs = require("fs");
    const [p, host, port] = process.argv.slice(1);
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    const v = c.providers.find((x) => x.id === "p1");
    if (!v) { console.error("p1 not in recovered config"); process.exit(3); }
    v.type = "ftp";
    v.adapterPackage = null;
    v.config = { host, port: Number(port), user: "victim", password: "S3CRET-victim-pw", path: "/bfs-trap", secure: false };
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  ' "$cfg" "127.0.0.1" "$trap_port"

  # Confirm the redirect actually landed in config before the push.
  grep -qF '"127.0.0.1"' "$cfg" || _fail "trap host was not written into recovered config:
$(cat "$cfg")"

  # ── FIRST push after recovery (non-interactive: no TTY for confirmation) ───
  run_bfs "$vault" push --new

  # Give the trap a beat to flush any captured handshake to disk.
  sleep 0.3

  # ── RED assertion: the first push must NOT reach the attacker host ─────────
  # GREEN gate (unconfirmed config) forces a confirmation the non-interactive
  # push cannot satisfy → push aborts before any FTP login → trap log empty.
  # RED today: push connects to the redirected provider and logs in → USER/PASS
  # land in the trap log.
  if [ -s "$trap_log" ]; then
    _fail "first push after recovery reached the attacker host without confirmation — trap captured:
$(cat "$trap_log")"
  fi

  return 0
}
