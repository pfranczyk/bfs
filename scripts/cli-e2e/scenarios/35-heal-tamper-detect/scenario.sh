# shellcheck shell=bash
# Heal metadata cross-validation (S4).
#
# With encryption off, a shard header (blob_hash, vault_name, …) is guarded only
# by an UNKEYED trailing SHA-256: an attacker who can rewrite ONE shard can plant
# divergent metadata and re-seal it byte-valid (checksum recomputed).
#
# Heal (`bfs provider remove --strategy rebuild`) reconstructs a removed shard by
# Reed-Solomon repair over the remaining siblings, taking blob_hash / vault_name /
# format / scheme metadata from the FIRST available sibling it reads. If a
# different available sibling carries forged metadata, heal must NOT silently
# trust the first shard — it must cross-validate the available siblings and abort
# on divergence.
#
# Layout: 4 LOCAL providers, 3 data + 1 parity. Remove p0 by rebuilding its shard
# onto a fresh provider p4. shard_1 (an available sibling heal downloads) is
# forged: its header blob_hash is overwritten. shard_0 (removed, p0) is NOT read;
# shard_1/shard_2/shard_3 are read for the repair, and shard_1 now diverges from
# its honest siblings.
#
# GREEN contract: rebuild detects the metadata divergence between available
# siblings and ABORTS (exit != 0), leaving v1 not silently "repaired" against
# attacker-planted metadata.
#
# RED contract (today): extractShardMeta takes the first sibling's metadata and
# `break`s — no cross-validation — so rebuild completes exit 0 and reports the
# version healthy, having silently trusted a vault with a forged shard header.

SCENARIO_NAME="heal metadata tamper detect (forged sibling blob_hash)"
SCENARIO_DESC="forged sibling header metadata must abort RS rebuild, not be silently trusted"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs35"
  local newdir="$SC_DIR/rebuilt"
  local tamper_driver
  tamper_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/tamper-shard.ts"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Forge an AVAILABLE sibling (shard_1 on p1): overwrite its header blob_hash so
  # it diverges from its honest siblings. Re-sealed with a valid checksum.
  local shard1
  shard1="$(shard_file 1 1)"
  assert_file "$shard1"
  BFS_OUT="$("$TSX" "$(winpath "$tamper_driver")" "$(winpath "$shard1")" --meta blob_hash ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff 2>&1)" || true
  printf '%s' "$BFS_OUT" | grep -qF "TAMPERED meta blob_hash" || _fail "tamper helper did not forge shard_1 metadata. Output:
$BFS_OUT"

  # Trigger heal: rebuild the removed p0's shard onto a fresh provider p4. Heal
  # reads the available siblings (incl. the forged shard_1) to repair.
  mkdir -p "$newdir"
  run_bfs "$vault" provider remove p0 \
    --strategy rebuild --target p4 --new-type local \
    --path "$(winpath "$newdir")" --scope all --yes

  # ── RED assertion: rebuild must NOT silently succeed against forged metadata ─
  # GREEN aborts (exit != 0). Today the rebuild trusts the first sibling, ignores
  # the divergent shard_1, and exits 0 — that is the RED failure.
  if [ "${BFS_EXIT:-1}" = "0" ]; then
    _fail "rebuild succeeded despite a forged sibling header — metadata divergence not detected. Output:
$BFS_OUT"
  fi

  return 0
}
