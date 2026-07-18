# shellcheck shell=bash
# Genuinely distributed SSH backup: N+K providers spread across THREE separate
# sshd endpoints (distinct ports/containers), one shard per server — so no single
# machine holds enough to reconstruct. Lose the whole server holding a DATA shard
# (= K consumed) and the pull must Reed-Solomon-reconstruct it from the surviving
# data shard + parity. This is the property an all-on-one-server layout (sub-paths)
# does NOT prove. Requires the three --ssh specs to be genuinely separate servers.

SCENARIO_NAME="SSH 2/1 across 3 endpoints, lose data-shard server"
SCENARIO_DESC="one shard per sshd; drop a data shard's whole server, reconstruct via RS"
REQUIRES_LOCAL=0
REQUIRES_SSH=3

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs82"
  make_fixtures "$vault"
  make_large_file "$vault/big.bin" 4194304
  build_pool_seq "$SC_DIR" "$name" ssh ssh ssh   # p0→ep0, p1→ep1, p2→ep2 (round-robin)

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Lose a whole server holding a DATA shard (shard_0, on its own endpoint). K=1 is
  # fully consumed; the survivors are shard_1 (data) + shard_2 (parity), so the
  # pull MUST Reed-Solomon-reconstruct shard_0's data from parity — not merely read
  # two intact data shards. Dropping the parity instead would let the two data
  # shards satisfy the restore with no reconstruction at all (a broken data-recovery
  # path would still pass).
  ssh_rm "${PV_SSH_ENDPOINT[0]}" "${PV_SSH_REMOTE[0]}/${POOL_VAULTNAME}/shard_0.bfs.1"
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  # Wipe the working tree (keep .bfs/) so the restore is a genuine reconstruction,
  # not a no-op over still-intact files — then reconstruct from the two surviving
  # servers.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/big.bin"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
