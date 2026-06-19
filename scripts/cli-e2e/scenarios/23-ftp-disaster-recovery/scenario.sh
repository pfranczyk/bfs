# shellcheck shell=bash
# Disaster recovery over FTP: lose the whole .bfs/, rebuild metadata by
# bootstrapping from an FTP provider, then restore. Mirrors smoke Suite L
# recovery + tests/cli/recovery FTP bootstrap.

SCENARIO_NAME="FTP disaster recovery"
SCENARIO_DESC="lose .bfs/, recover from FTP bootstrap, restore"
REQUIRES_LOCAL=0
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs23"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 0 4 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Catastrophe: local metadata gone; only the FTP providers remain.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Bootstrap from provider p0's FTP endpoint and remote sub-path. Unattended
  # (CI) recovery: --trust-locations pre-approves the recovered hosts so the
  # per-host credential confirmation does not block a non-interactive run.
  run_bfs "$vault" recovery --provider ftp --name "$name" \
    --bootstrap "$(ftp_bootstrap_spec 0)" --trust-locations
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
