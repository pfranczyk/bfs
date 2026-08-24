# shellcheck shell=bash
# A restore that cannot go ahead must say WHY, naming the media it is talking
# about - that is what decides the operator's next move.
#
# pull knows exactly which parts failed and how: it builds that map to exclude
# them from the decode, and the failure it raises carries the same knowledge -
# otherwise someone goes checking cables while the real problem is rot on a disk
# that is plugged in and answering.
#
# Layout: 3 LOCAL providers, 2 data + 1 parity, unencrypted. Two parts rot (below
# N - unrecoverable), the third stays sound and must NOT be implicated. A second
# pass turns one of the two into a missing file, so the message has to keep the
# two causes apart rather than lumping them together.

SCENARIO_NAME="failed pull names the damaged media and the cause"
SCENARIO_DESC="damage, absence and a healthy medium must be told apart in the failure message"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs59"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard.ts"

  make_fixtures "$vault"
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok

  # Two parts rot on their media; nothing is re-sealed, so each fails its checksum.
  local i
  for i in 0 1; do
    BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$(shard_file "$i" 1)")" 2>&1)" || true
    printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED" || _fail "corrupt driver failed on shard_$i: $BFS_OUT"
  done

  run_bfs "$vault" --lang en pull --force --yes
  assert_fail
  assert_out_matches "Damaged backup data on: *p0, *p1"
  # Guard the sentences the other causes actually print - the word "offline"
  # appears in none of them, so grepping for it proves nothing.
  if printf '%s' "$BFS_OUT" | grep -qF "Storage not reachable:"; then
    _fail "failure blamed an unreachable medium although the media answered and the data is damaged:
$BFS_OUT"
  fi
  if printf '%s' "$BFS_OUT" | grep -qF "Backup data missing on:"; then
    _fail "failure reported damaged data as missing:
$BFS_OUT"
  fi
  if printf '%s' "$BFS_OUT" | grep -qE '\bp2\b'; then
    _fail "the healthy medium p2 must not be implicated:
$BFS_OUT"
  fi

  # One medium loses its part entirely: absence and damage must not be conflated.
  rm "$(shard_file 1 1)"
  run_bfs "$vault" --lang en pull --force --yes
  assert_fail
  # Anchor on the attribution sentences: "missing on storage ..." is also a
  # per-shard warning emitted regardless, so only the colon form proves the
  # failure itself separated the two causes.
  assert_out_matches "Damaged backup data on: *p0"
  assert_out_matches "missing on: *p1"

  return 0
}
