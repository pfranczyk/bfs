# shellcheck shell=bash
# S3 — "unconfirmed config after recovery" gate, exercised through a HEAL
# (`bfs provider remove --strategy relocate`) instead of a push.
#
# Same root cause as scenario 36: with encryption off a shard's location_map is
# raw JSON guarded only by an UNKEYED trailing SHA-256, so `bfs recovery` can
# rebuild .bfs/config.json with an attacker-controlled provider coordinate. The
# plan promises the unconfirmed-config gate fires on the FIRST write op after
# recovery — "push OR heal, whichever comes first".
#
# Escalation under test: a heal write path. `provider remove --strategy relocate`
# runs updateLocationMaps(), which authenticates to EVERY provider in the
# recovered config to rewrite shard headers — including the redirected one. After
# a disaster recovery from a forged map, the heal therefore logs in to the
# attacker's host without the operator ever confirming the locations.
#
# Setup models the net effect: a clean recovery rebuilds config from the remote
# headers, then one recovered provider entry (p1) is rewritten to point at the
# FTP trap — the untrusted coordinate an attacker would have planted. p0's shard
# is copied to a fresh dir so the relocate of p0 reaches updateLocationMaps.
#
# GREEN contract: recovery marks the config UNCONFIRMED
# (state.locations_confirmed=false), and the heal must have the operator confirm
# the provider locations BEFORE contacting any provider. A non-interactive run
# (no TTY) cannot satisfy that confirmation, so the heal aborts WITHOUT reaching
# the trap. Therefore the trap log stays EMPTY.
#
# RED contract (today): removeProvider has no gate, so relocate runs
# updateLocationMaps and logs in to the redirected p1 — the trap captures the
# USER/PASS handshake. A non-empty trap log after the heal is the RED FAIL.

SCENARIO_NAME="heal after recovery gate (untrusted recovered host must not leak during relocate)"
SCENARIO_DESC="recovery leaves config unconfirmed; provider remove --relocate must confirm provider locations before reaching an attacker host"
REQUIRES_LOCAL=1
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs37"
  local cfg="$vault/.bfs/config.json"
  local trap_log="$SC_DIR/trap.log"
  local trap_out="$SC_DIR/trap.out"
  local reldir="$SC_DIR/relocated"
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
  # location map: redirect provider p1 at the FTP trap.
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

  grep -qF '"127.0.0.1"' "$cfg" || _fail "trap host was not written into recovered config:
$(cat "$cfg")"

  # Copy p0's shard to a fresh address so the relocate of p0 passes its
  # shard-existence check and reaches updateLocationMaps (which contacts p1).
  mkdir -p "$reldir"
  cp -r "${PV_LOCALDIR[0]}/$name" "$reldir/$name"

  # ── HEAL after recovery (non-interactive: no TTY for confirmation) ─────────
  run_bfs "$vault" provider remove p0 --strategy relocate --path "$(winpath "$reldir")" --yes

  # Give the trap a beat to flush any captured handshake to disk.
  sleep 0.3

  # ── RED assertion: the heal must NOT reach the attacker host ───────────────
  # GREEN gate (unconfirmed config) forces a confirmation the non-interactive
  # heal cannot satisfy → relocate aborts before any FTP login → trap log empty.
  # RED today: relocate runs updateLocationMaps and logs in to the redirected
  # provider → USER/PASS land in the trap log.
  if [ -s "$trap_log" ]; then
    _fail "heal (relocate) after recovery reached the attacker host without confirmation — trap captured:
$(cat "$trap_log")"
  fi

  return 0
}
