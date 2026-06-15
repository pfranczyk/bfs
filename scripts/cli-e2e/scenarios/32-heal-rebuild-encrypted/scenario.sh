# shellcheck shell=bash
# Heal by rebuild on an ENCRYPTED (default) backup: the rebuilt shard must be
# byte-compatible with the V2 striped + per-shard-GCM format the rest of the
# version uses, so that a later pull can reconstruct from it.
#
# Difference from scenario 11 (which passes today): 11 rebuilds an
# UNENCRYPTED, single-stripe backup, where the heal path's V1/flat/plaintext
# output happens to coincide with what pull expects. This scenario uses the
# encrypted default, where the rebuilt shard is produced unencrypted with a V1
# header over an RS-of-ciphertext payload — incompatible with the V2 decrypt +
# striped decode path.
#
# To expose it, the rebuilt shard is made load-bearing: after rebuild we drop
# one healthy original shard, so reaching N data shards REQUIRES the rebuilt
# one. With a correct heal the pull restores byte-for-byte; with the current
# heal the rebuilt shard is undecryptable, pull falls short of N, and the
# restore fails. verify reports the version Healthy regardless — it inspects
# only the header window — which is the masking part of the finding.

SCENARIO_NAME="heal: rebuild on encrypted backup is decodable"
SCENARIO_DESC="rebuilt shard must reconstruct an encrypted V2 backup at pull"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs32" pw="Secret123!"
  local newdir="$SC_DIR/rebuilt"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  # Remove p0 by rebuilding its shard (index 0) onto a new local provider "p4".
  mkdir -p "$newdir"
  run_bfs "$vault" provider remove p0 \
    --strategy rebuild --target p4 --new-type local \
    --path "$(winpath "$newdir")" --scope all --yes --password "$pw"
  assert_ok

  # Masking: verify only reads the header window, so it still says Healthy
  # even though the rebuilt payload is broken.
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Make the rebuilt shard_0 load-bearing: drop one healthy original (shard_1
  # on p1). Reaching N=3 now requires the rebuilt shard_0. A correct heal still
  # restores; the current heal cannot.
  rm "$(shard_file 1 1)"

  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
