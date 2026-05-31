# shellcheck shell=bash
# Hybrid vault (local, ftp, local, ftp) where disaster recovery bootstraps from
# an FTP provider that is NOT shard_0. Confirms that an FTP shard's header
# carries the full location map and can rebuild .bfs/ for a mixed vault — the
# case grouped layouts (always bootstrapping from a local shard_0) never reach.

SCENARIO_NAME="hybrid recovery via FTP bootstrap"
SCENARIO_DESC="local,ftp,local,ftp; lose .bfs/, recover from an FTP shard"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs24"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local ftp local ftp   # p1, p3 are FTP

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Lose all local metadata.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Recover by bootstrapping from the FTP provider p1 (shard_1).
  run_bfs "$vault" recovery --provider ftp --name "$name" \
    --bootstrap "$(ftp_bootstrap_spec 1)"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
