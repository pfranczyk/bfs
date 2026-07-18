# shellcheck shell=bash
# Hybrid vault (local, ssh, local, ssh) where disaster recovery bootstraps from
# an SSH provider that is NOT shard_0. Confirms an SSH shard's header carries the
# full location map and can rebuild .bfs/ for a mixed vault — the case grouped
# layouts (always bootstrapping from a local shard_0) never reach.

SCENARIO_NAME="hybrid recovery via SSH bootstrap"
SCENARIO_DESC="local,ssh,local,ssh; lose .bfs/, recover from an SSH shard"
REQUIRES_LOCAL=2
REQUIRES_SSH=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs81"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local ssh local ssh   # p1, p3 are SSH

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Lose all local metadata.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Recover by bootstrapping from the SSH provider p1 (shard_1) — not shard_0.
  # Unattended (CI) recovery: --trust-locations pre-approves the recovered hosts
  # so the per-host credential confirmation does not block a non-interactive run.
  run_bfs "$vault" recovery --provider ssh --name "$name" \
    --bootstrap "$(ssh_bootstrap_spec 1)" --trust-locations
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
