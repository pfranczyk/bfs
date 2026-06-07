# shellcheck shell=bash
# Restore a backup into a brand-new working directory that has never held this
# vault (e.g. a fresh machine): recover metadata from a provider, then pull.
# This is the supported "restore from the backup directory" path — `bfs pull`
# alone requires an existing .bfs/.

SCENARIO_NAME="restore on a fresh machine"
SCENARIO_DESC="recover .bfs/ into an empty dir from a provider, then pull"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" fresh="$SC_DIR/fresh" base="$SC_DIR/baseline.txt" name="bfs09"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # New, empty working directory — only the provider path + vault name are known.
  mkdir -p "$fresh"
  run_bfs "$fresh" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$fresh/.bfs/config.json"

  run_bfs "$fresh" pull --force --yes
  assert_ok
  assert_restored "$fresh" "$base"
}
