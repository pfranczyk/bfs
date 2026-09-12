# shellcheck shell=bash
# `bfs verify` must say WHY a version lost a part, not only how many are left.
# "2/3" reads the same for a medium that is switched off and for a part that was
# deleted, yet the first calls for bringing the medium back and the second for
# `bfs repair <name> "" --rebuild` - so the two causes have to reach the operator as
# different sentences, through the real CLI.
#
# The two losses are injected one at a time so each cause is observed on its own:
# a deleted file while its medium still answers, then a medium taken away whole.

SCENARIO_NAME="verify names the cause of a lost part"
SCENARIO_DESC="3L 2/1; delete one part, then take a whole medium away - each cause named, exit 4 then 5"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs98"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- Positive control: an intact backup names no cause at all ----------------
  # Without this, a regression that emits the cause line for every medium - sound
  # ones included - would still turn both checks below green.
  run_bfs "$vault" verify
  assert_exit 0
  if printf '%s' "$BFS_OUT" | grep -qE 'Backup data missing on|Storage not reachable|Damaged backup data on'; then
    _fail "a healthy backup must not name any cause of loss:
$BFS_OUT"
  fi

  # -- The medium answers, its part is gone ------------------------------------
  rm "$(shard_file 2 1)"
  run_bfs "$vault" verify
  assert_exit 4
  assert_manifest_health "$vault" 1 degraded
  assert_out_contains 'Version v001 - Backup data missing on: p2.'
  # A medium that answered must not be blamed for being away.
  if printf '%s' "$BFS_OUT" | grep -qE 'Storage not reachable:.*p2'; then
    _fail "a reachable medium whose part was deleted must not be reported as unreachable:
$BFS_OUT"
  fi
  # One line per cause, naming media. The internal part files belong to
  # `bfs --debug verify`, not to the operator's report.
  if printf '%s' "$BFS_OUT" | grep -qE 'shard_[0-9]+\.bfs\.[0-9]+'; then
    _fail "the report must name media, not internal part files:
$BFS_OUT"
  fi

  # -- The whole medium is gone (drive unplugged, share unmounted) -------------
  rm -rf "${PV_LOCALDIR[1]}"
  run_bfs "$vault" verify
  assert_exit 5
  assert_manifest_health "$vault" 1 damaged
  assert_out_contains 'Version v001 - Storage not reachable: p1.'
  # Nothing was read from p1, so its data must not be called missing or damaged.
  if printf '%s' "$BFS_OUT" | grep -qE 'Backup data missing on:.*p1'; then
    _fail "an unreachable medium must not be reported as a missing file:
$BFS_OUT"
  fi
  if printf '%s' "$BFS_OUT" | grep -qE 'Damaged backup data on:.*p1'; then
    _fail "an unread medium must not be accused of holding corrupt data:
$BFS_OUT"
  fi
  return 0
}
