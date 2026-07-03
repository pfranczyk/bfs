# shellcheck shell=bash
#
# A length-preserving bit-flip in ONE data-shard's payload must NOT sink the
# restore: with N healthy shards + parity present, pull must detect the corrupt
# shard, exclude it, and erasure-decode the blob from the rest.
#
# Encrypted vault (V2 per-shard AES-256-GCM) → the flipped ciphertext byte
# breaks the shard's GCM auth tag, which surfaces as a stream error during
# decode. Today that aborts the whole pull (output.destroy) even though the
# redundancy to survive it is sitting in the other shards — the bug this
# scenario pins down.

SCENARIO_NAME="corrupt data-shard → pull rebuilds from parity (encrypted)"
SCENARIO_DESC="length-preserving bit-flip in one data-shard; N healthy + parity must reconstruct"
REQUIRES_LOCAL=1
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs45" pw="Secret123!"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard.ts"

  make_fixtures "$vault"
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Corrupt ONE data-shard's payload in place (length-preserving bit-flip).
  # Shard 0 is a data shard (0..N-1); shard 1 (data) + shard 2 (parity) stay
  # healthy — exactly N=2 good shards, which is enough to reconstruct.
  local shard0
  shard0="$(shard_file 0 1)"
  assert_file "$shard0"
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard0")" 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED"; then
    _fail "corrupt-shard driver did not report success: $BFS_OUT"
  fi

  # GREEN target: pull excludes the corrupt shard and rebuilds from shard 1 +
  # parity, restoring the tree byte-for-byte. RED today: pull aborts (GCM auth
  # tag → output.destroy) despite N healthy shards + parity being available.
  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
