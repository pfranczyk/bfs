# shellcheck shell=bash
# `bfs versions` tells the operator how many files a version holds and how much
# they weigh. Those figures come from the blob's file table, which a V2 blob
# carries per user file whether or not the data section is compressed - and
# compression is the default, so a resumed push is the ordinary case here, not
# an edge one.
#
# Reporting zero is worse than reporting nothing: the table prints `?` when a
# figure is unknown, so a zero reads as "this version is empty" - about a version
# that restores a full directory. Nothing corrects it later either.

SCENARIO_NAME="versions reports real figures after a resumed push"
SCENARIO_DESC="partial push -> push --cache on a compressed backup -> versions shows files, not 0"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs100"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  # No --no-compress: this is the default path, and the one the figures go
  # missing on.
  run_bfs "$vault" init "$name" --ci --no-enc \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  # Break p2 so the push goes partial and leaves a cache to resume from.
  local broken="${PV_LOCALDIR[2]}"
  rm -rf "$broken"
  : >"$broken"

  run_bfs "$vault" push --new
  assert_exit 1
  assert_manifest_health "$vault" 1 degraded
  # Without the cache there is nothing to resume from, and a missing one would
  # show up misleadingly as a plain success further down.
  assert_file "$vault/.bfs/cache/push.blob.pending"

  rm -f "$broken"
  mkdir -p "$broken"

  run_bfs "$vault" push --cache --overwrite
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # The operator-facing table first: this is the surface the defect shows on.
  run_bfs "$vault" versions
  assert_ok
  if printf '%s' "$BFS_OUT" | grep -qE '(^|[^0-9])0 B([^a-zA-Z]|$)'; then
    _fail "versions must not report a populated version as 0 B. Output: $BFS_OUT"
  fi

  # And the manifest the table reads it from - a zero in the file is what the
  # table prints as fact, and nothing repairs it later.
  assert_manifest_absent "$vault" 1 '"file_count": 0'
  assert_manifest_absent "$vault" 1 '"total_size": 0'

  # The version really does restore the whole tree - so the figures describe
  # something that exists.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
