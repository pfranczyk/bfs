# shellcheck shell=bash
# Full local .bfs/ loss → rebuild metadata from a single provider via
# `recovery --bootstrap`, then restore every version. Mirrors tests/e2e
# full-disaster-recovery + tests/cli/recovery.

SCENARIO_NAME="disaster recovery (rebuild .bfs/)"
SCENARIO_DESC="lose .bfs/, recover from one provider, restore v1+v2"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" b2="$SC_DIR/v2.txt" name="bfs08"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new; assert_ok          # v1
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$b2"
  run_bfs "$vault" push --new; assert_ok          # v2

  # Catastrophe: the whole .bfs/ metadata directory is gone.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Rebuild metadata by bootstrapping from provider p0.
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"
  assert_file "$vault/.bfs/manifests/v002.json"

  # Restore both versions from the recovered metadata.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$b2"

  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$b1"
}
