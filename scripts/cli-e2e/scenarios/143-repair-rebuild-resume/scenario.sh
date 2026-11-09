# shellcheck shell=bash
# `bfs repair --rebuild` onto a replacement that fails after rebuilding one
# version is finished by running the same command again - the advice the
# partial failure itself prints.
#
# The rebuild adds the recorded name to the configuration before it rebuilds
# anything and keeps it once a version has been committed under it, because
# that part now lives there. Until the old entry goes, the pool holds one entry
# more than the scheme, so every backup command is refused until the rebuild
# is finished. The second run therefore has to accept a recorded
# name that the first run already put back, and carry on with the versions
# still missing their part.
#
# The interruption is real: one sibling part of v2 is taken away, so v2 cannot
# be reconstructed while v1 can. The part comes back before the retry - the
# "fix the cause" step - and nothing else changes between the two runs.

SCENARIO_NAME="repair --rebuild interrupted after one version is finished by the same command"
SCENARIO_DESC="4L 3/1, v1+v2; replacement for removed p3; rebuild fails on v2 after v1; sibling back; same repair finishes, pool back to 4"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs143" base="$SC_DIR/v2.txt" spare="$SC_DIR/spare" held="$SC_DIR/held.2"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"
  mkdir -p "$spare"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # -- p3 dropped, an empty replacement p4 configured at 3/1 -------------------
  # The replacement is configured through `scheme set`, which does not depend
  # on how `provider add` treats a short pool, so this scenario pins the resume
  # alone.
  run_bfs "$vault" provider remove p3 --strategy remove --yes
  assert_ok
  run_bfs "$vault" scheme set 2 1
  assert_ok
  run_bfs "$vault" provider add --ci --name p4 --type local --path "$(winpath "$spare")"
  assert_ok
  run_bfs "$vault" scheme set 3 1
  assert_ok

  # -- First run: v1 rebuilt, v2 cannot be ------------------------------------
  mv "${PV_LOCALDIR[1]}/$name/shard_1.bfs.2" "$held"
  run_bfs "$vault" repair --version all --rebuild p4 "local:p3 --path $(winpath "$spare")"
  assert_fail
  assert_out_contains 'retry after fixing the cause'
  assert_file "$spare/$name/shard_3.bfs.1"
  assert_no_file "$spare/$name/shard_3.bfs.2"
  assert_config_provider "$vault" p3

  # -- The cause fixed, the same command again ---------------------------------
  mv "$held" "${PV_LOCALDIR[1]}/$name/shard_1.bfs.2"
  run_bfs "$vault" repair --version all --rebuild p4 "local:p3 --path $(winpath "$spare")"
  assert_ok
  assert_file "$spare/$name/shard_3.bfs.2"
  # The free entry is gone and the pool matches its scheme again.
  assert_config_provider "$vault" p3
  assert_config_no_provider "$vault" p4
  [ "$(grep -cE '"id": *"p[0-9]+"' "$vault/.bfs/config.json")" = "4" ] ||
    _fail "expected 4 storages after the rebuild is finished. Got:
$(grep -E '"id":' "$vault/.bfs/config.json")"
  run_bfs "$vault" verify
  assert_exit 0
  assert_manifest_health "$vault" 1 healthy
  assert_manifest_health "$vault" 2 healthy

  # -- Binding proof: v2 restores through the part rebuilt on the second run ---
  rm -f "${PV_LOCALDIR[0]}/$name/shard_0.bfs.2"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
  return 0
}
