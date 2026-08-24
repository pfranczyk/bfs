# shellcheck shell=bash
# Bit-rot in a sibling's PAYLOAD must not be baked into the rebuilt shard.
#
# Companion to 56, which damages a sibling's HEADER. Here the damage is in the
# payload, which is what forces the repair to drop the shard from the erasure
# decode itself - not merely from the header cross-check. A fix that only skips
# the damaged shard while reading metadata still passes 56; it fails here.
#
# `bfs provider remove --strategy rebuild` feeds the downloaded siblings into
# _repairShardPayload (src/vault/heal.ts) as RS slots. downloadAvailableShards
# drops a sibling failing its own trailing SHA-256 before it can become a slot,
# because rebuildVersion records the hash of whatever comes out of the decode as
# the new shard_hash - a rotted slot would leave the manifest agreeing with
# itself over bytes that no longer reconstruct the backup.
#
# Encryption is off on purpose: with encryption on, the flipped byte breaks the
# per-shard GCM tag and the repair dies loudly instead, which is a different
# failure. Unencrypted is the silent one - the version keeps reporting healthy
# while a shard now holds bytes that cannot reconstruct the backup.
#
# Layout: 5 LOCAL providers, 3 data + 2 parity. p0 is removed and its shard
# rebuilt onto a fresh provider p5; shard_1's payload is bit-rotted. Three intact
# siblings (shard_2/shard_3/shard_4) remain - exactly N - so a repair that
# excludes the damaged shard has everything it needs. After the rebuild the
# damaged shard_1 and one healthy original are dropped, so reaching N=3 at pull
# requires the rebuilt shard: the SHA-256 comparison then proves whether the
# repair produced sound bytes or silently propagated the rot.

SCENARIO_NAME="heal: bit-rot in a sibling payload must not be rebuilt into the new shard"
SCENARIO_DESC="rebuild must erasure-decode from intact siblings only, not from a shard failing its checksum"
REQUIRES_LOCAL=5
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs57"
  local newdir="$SC_DIR/rebuilt"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard.ts"

  make_fixtures "$vault"
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 5 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 2 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Length-preserving bit-flip inside shard_1's payload. Nothing is re-sealed, so
  # the shard fails its own trailing checksum - accidental damage, not a forgery.
  local shard1
  shard1="$(shard_file 1 1)"
  assert_file "$shard1"
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard1")" 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED"; then
    _fail "corrupt-shard driver did not damage shard_1's payload. Output:
$BFS_OUT"
  fi

  # Rebuild p0's shard onto a fresh provider p5, with the rotted sibling present.
  mkdir -p "$newdir"
  run_bfs "$vault" --lang en provider remove p0 \
    --strategy rebuild --target p5 --new-type local \
    --path "$(winpath "$newdir")" --scope all --yes
  assert_ok
  # The operator must learn which device was left out, not just see exit 0.
  assert_out_contains "failed its integrity check"
  # The rotted sibling is still rotted, so the version now has one sound part
  # fewer than its scheme promises - a healthy stamp here would contradict what
  # `verify --deep` reads off the media and hide the second device that needs
  # attention. The healthy stamp asserted before the rebuild is the A/B control.
  assert_manifest_health "$vault" 1 degraded

  # Make the rebuilt shard load-bearing: drop the damaged shard_1 and one healthy
  # original, so reaching N=3 requires the shard just rebuilt.
  rm "$shard1"
  rm "$(shard_file 2 1)"

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  return 0
}
