# shellcheck shell=bash
# `bfs prune` must not delete the last version that can still be restored.
#
# prune (src/vault/vault-manager.ts) picks versions by number alone and never
# looks at health, so a routine `--keep-last 1` on a backup whose newest version
# rotted deletes the operator's only good copy and keeps the unrecoverable one.
# This is the point where a stale or erased health verdict stops being a
# reporting problem and starts destroying data — prune is the first command that
# acts on that value.
#
# The guard must stay narrow: deleting a damaged version while a restorable one
# remains is normal housekeeping, and an operator who really means it keeps a way
# out (--force), so a backup can still be wiped deliberately.
#
# Layout: 3 LOCAL providers, 2 data + 1 parity, unencrypted, two versions. v2
# rots on two of three media (below N — unrecoverable), v1 stays intact.

SCENARIO_NAME="prune refuses to delete the last restorable version"
SCENARIO_DESC="damaged versions stay prunable and --force still wipes, but the last good copy is protected"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/v1-baseline.txt" name="bfs58c"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard.ts"

  make_fixtures "$vault"
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  mutate_fixtures "$vault"
  run_bfs "$vault" push --new
  assert_ok

  # v2 rots below N on two media; the deep check records that verdict.
  local i
  for i in 0 1; do
    BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$(shard_file "$i" 2)")" 2>&1)" || true
    printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED" || _fail "corrupt driver failed on shard_$i of v2: $BFS_OUT"
  done
  run_bfs "$vault" --lang en verify --deep
  assert_exit 5
  assert_manifest_health "$vault" 2 damaged

  # Housekeeping that would leave only the unrecoverable version must be refused.
  run_bfs "$vault" --lang en prune --keep-last 1 --yes
  assert_fail
  assert_out_contains "can still be restored"
  assert_file "$(shard_file 0 1)"
  assert_file "$(shard_file 1 1)"

  # v1 is untouched by the refusal and still restores byte for byte.
  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Deleting the damaged version is ordinary housekeeping — it must go through.
  run_bfs "$vault" --lang en prune 2 --yes
  assert_ok
  assert_no_file "$(shard_file 0 2)"

  # v1 is now the last restorable version: refused by default, wiped on --force.
  run_bfs "$vault" --lang en prune 1 --yes
  assert_fail
  assert_file "$(shard_file 0 1)"

  run_bfs "$vault" --lang en prune 1 --yes --force
  assert_ok
  assert_no_file "$(shard_file 0 1)"

  return 0
}
