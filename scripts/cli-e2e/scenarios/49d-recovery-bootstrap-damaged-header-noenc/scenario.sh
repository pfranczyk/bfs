# shellcheck shell=bash
#
# The same fault on an UNENCRYPTED backup: the bootstrap provider's location map
# has rotted. No password exists here, so there is nothing to misattribute - the
# risk is the opposite one, that the operator is handed the parser's own words
# ("Location map JSON is invalid or corrupted") and no next step.
#
# The way out is the same as in 49c and it works: every sibling of the version
# carries the same map, so bootstrapping from any of them rebuilds .bfs/ (the
# damaged provider is then reported and the version comes back degraded).
#
# Both modes have to carry the same message: the same physical fault must not
# produce a helpful sentence on an encrypted backup and a dead end on an
# unencrypted one.
# No checksum is read on this path - the JSON does not parse, so the damage is
# already established where the message is produced.

SCENARIO_NAME="recovery refuses an unencrypted bootstrap provider whose map rotted, and names the way out"
SCENARIO_DESC="--no-enc 2/1, bootstrap FROM the damaged shard; refusal must be translatable and actionable"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" name="bfs49d"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard-header.ts"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new; assert_ok
  assert_manifest_health "$vault" 1 healthy

  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Rot the plain location map of p0 - the shard recovery is about to bootstrap
  # from. Unlike the encrypted case the map is JSON in the clear, so the damage
  # surfaces at parse time rather than as a failed decryption.
  local shard0v1
  shard0v1="$(shard_file 0 1)"
  assert_file "$shard0v1"
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard0v1")" --map 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "HEADER-CORRUPTED mode=map"; then
    _fail "corrupt-shard-header driver did not report a map corruption: $BFS_OUT"
  fi

  run_bfs "$vault" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_exit 1
  assert_out_contains "on this provider failed its integrity check"
  assert_out_contains "Recover from a different provider"
  # The raw internal literal must not be what reaches the operator.
  if printf '%s' "$BFS_OUT" | grep -qF "Location map JSON is invalid or corrupted"; then
    _fail "recovery surfaced the internal parser literal instead of a translatable, actionable message"
  fi
  assert_no_file "$vault/.bfs/config.json"

  # Execute the advice: the same damage, bootstrapped from a healthy sibling.
  run_bfs "$vault" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$b1"
}
