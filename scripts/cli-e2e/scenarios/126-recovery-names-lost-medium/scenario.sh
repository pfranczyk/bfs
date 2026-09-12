# shellcheck shell=bash
# `bfs recovery` rebuilds .bfs/ on a machine that has no configuration of its
# own, so the report it prints is everything the operator knows. It settles each
# version's health through the same check `bfs verify` runs, so a "degraded" row
# is proof the run already identified the medium short of its part. Printing the
# row without that name sends the operator hunting through every medium by hand.
#
# The sentence is the one verify prints for the same state (scenario 98), so the
# two commands cannot drift into describing one dead drive differently. Internal
# part files stay out of it - those belong to `bfs --debug`.
#
# Two losses, because they are classified differently and only the first is
# stable: a part deleted while its medium answers is `file_missing` under any
# model. A medium taken away whole depends on `authenticate()` silently
# recreating a missing base path - an open question, so the second case asserts
# only that the medium is NAMED, which is the contract, and leaves the choice of
# sentence to whichever classification wins.

SCENARIO_NAME="recovery names the medium that was lost"
SCENARIO_DESC="3L 2/1; lose .bfs/ plus a part, then a whole medium - recovery names it, exit 0"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs126"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- Positive control: a recovery that lost nothing names no cause -----------
  # Without this, a regression printing a cause line for every configured medium
  # would still turn both real checks below green.
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  if printf '%s' "$BFS_OUT" | grep -qE 'Backup data missing on|Storage not reachable|Damaged backup data on'; then
    _fail "a recovery with every medium present must not name any cause of loss:
$BFS_OUT"
  fi

  # -- The medium answers, its part is gone ------------------------------------
  # 2 of 3 parts survive, so the version is restorable - the run succeeds and the
  # only thing at stake is whether it says which medium is short.
  rm "$(shard_file 2 1)"
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_manifest_health "$vault" 1 degraded
  assert_out_contains 'Version v001 - Backup data missing on: p2.'
  # The surviving media must not be blamed, and the report must not fall back to
  # naming internal part files.
  if printf '%s' "$BFS_OUT" | grep -qE 'Backup data missing on:.*(p0|p1)'; then
    _fail "a medium that still holds its part must not be named as missing:
$BFS_OUT"
  fi
  if printf '%s' "$BFS_OUT" | grep -qE 'shard_[0-9]+\.bfs\.[0-9]+'; then
    _fail "the report must name media, not internal part files:
$BFS_OUT"
  fi

  # The backup is still restorable - the name is diagnostics, not an obstacle.
  run_bfs "$vault" pull --force --yes
  assert_ok

  # -- The whole medium is gone -------------------------------------------------
  # Same contract, different cause: whichever sentence the classification picks,
  # the report has to carry the medium's name on the line for this version.
  rm -rf "${PV_LOCALDIR[2]}"
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_out_matches 'Version v001 - .*p2'
}
