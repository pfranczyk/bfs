# shellcheck shell=bash
# Bit-rot in ONE sibling's header must not stop a rebuild (S4 counterpart).
#
# `bfs provider remove --strategy rebuild` reads every available sibling of a
# version and cross-validates their headers: a divergence in vault_id,
# vault_name, blob_hash, blob_size, rs_stripe_size or kdf_salt aborts the whole
# repair as TamperDetectedError (extractShardMeta in src/vault/heal.ts). The
# shards it compares are whatever downloadAvailableShards managed to fetch -
# extractShardPayload only slices bytes, so a shard is never checked against its
# own trailing SHA-256 before its header joins the comparison.
#
# Consequence: a single flipped bit inside one shard's header - the plain disk
# bit-rot this repair exists to absorb - is indistinguishable here from a forged
# header, so the repair refuses and the operator is told the data may have been
# tampered with. Restore (src/vault/vault-manager.ts) and recovery already treat
# this case as damage: they adopt identity/salt only from a shard whose checksum
# verifies and fall back to a healthy sibling.
#
# The flipped byte lands in the 16-byte Argon2id salt (corrupt-shard-header.ts
# --kdf-salt), which every shard of a version carries identically, so the healthy
# siblings still hold the authoritative value. Nothing is re-sealed: the shard's
# own trailing checksum no longer matches, which is exactly what distinguishes
# bit-rot from the forged-but-byte-valid header of scenario 35 - that one must
# keep aborting.
#
# Layout: 5 LOCAL providers, 3 data + 2 parity, encrypted. p0 is removed and its
# shard rebuilt onto a fresh provider p5; shard_1 (a sibling heal downloads) has
# the bit-rotted salt. After the rebuild both shard_1 and one healthy original
# (shard_2) are dropped, so reaching N=3 at pull REQUIRES the rebuilt shard -
# proof that the repair produced usable bytes and not just exit 0.

SCENARIO_NAME="heal: bit-rot in a sibling header is damage, not tampering"
SCENARIO_DESC="rebuild must skip a shard failing its own checksum and repair from healthy siblings"
REQUIRES_LOCAL=5
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs56" pw="Secret56!"
  local newdir="$SC_DIR/rebuilt"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard-header.ts"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 5 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc \
    --data-shards 3 --parity-shards 2 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Bit-rot the salt inside shard_1's header. No checksum is recomputed, so the
  # shard fails its own integrity check - accidental damage, not a forgery.
  local shard1
  shard1="$(shard_file 1 1)"
  assert_file "$shard1"
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard1")" --kdf-salt 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "HEADER-CORRUPTED mode=kdf-salt"; then
    _fail "corrupt helper did not damage shard_1's salt. Output:
$BFS_OUT"
  fi

  # Rebuild p0's shard onto a fresh provider p5. Four siblings are available and
  # three of them (shard_2/shard_3/shard_4) are intact - enough for the RS
  # repair even with the damaged shard_1 set aside.
  mkdir -p "$newdir"
  run_bfs "$vault" --lang en provider remove p0 \
    --strategy rebuild --target p5 --new-type local \
    --path "$(winpath "$newdir")" --scope all --yes --password "$pw"
  assert_ok
  # The operator must learn which device was left out, not just see exit 0.
  assert_out_contains "failed its integrity check"

  # Make the rebuilt shard load-bearing: drop the damaged shard_1 and one
  # healthy original, so reaching N=3 requires the shard just rebuilt.
  rm "$shard1"
  rm "$(shard_file 2 1)"

  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"

  return 0
}
