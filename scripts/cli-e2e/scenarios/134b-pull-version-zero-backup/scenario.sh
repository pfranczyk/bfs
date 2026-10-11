# shellcheck shell=bash
# A backup that 0.14.4 wrote as version 0 (push_mode=ask, "Overwrite (v0)" on
# the very first push) sits on the storage whole: manifest v000.json, one part
# per storage, listed as healthy. Version 0 is also the "nothing pushed" marker,
# so `bfs pull` has to look for that manifest before it reports that there is
# no backup - otherwise the data on the storage cannot be restored by anyone.
#
# The backup comes from tests/fixtures/v0-backup-0.14.4, written by the released
# code path and frozen byte for byte; only the storage paths in config.json are
# pointed at this sandbox. Control: a fresh init with no push still reports that
# there is nothing to restore.

SCENARIO_NAME="pull restores a backup written as version 0"
SCENARIO_DESC="frozen v0 backup from 0.14.4: plain pull and pull --version 0 restore byte-for-byte; next push creates v1 and keeps v0; v0 left as a not-recovered marker is rebuilt by pull; fresh init still has nothing to pull"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local fx="$REPO_ROOT/tests/fixtures/v0-backup-0.14.4"
  local vault="$SC_DIR/vault" media="$SC_DIR/media" base="$SC_DIR/baseline.txt"

  cp -r "$fx/vault" "$vault"
  cp -r "$fx/media" "$media"
  # Storage p<i> keeps its part on media/m<i>; only the absolute paths move.
  node -e 'const fs=require("node:fs");const [f,m]=process.argv.slice(1);const c=JSON.parse(fs.readFileSync(f,"utf8"));c.providers.forEach((p,i)=>{p.config.path=`${m}/m${i}`;});fs.writeFileSync(f,JSON.stringify(c,null,2));' \
    "$(winpath "$vault/.bfs/config.json")" "$(winpath "$media")"
  snapshot_hashes "$vault" "$base"

  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_restored "$vault" "$base"

  wipe_working_tree "$vault"
  run_bfs "$vault" pull --version 0 --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Version 0 is never a push target: the next push creates version 1, and
  # version 0 stays restorable next to it. Changed content keeps the two apart.
  local base1="$SC_DIR/baseline-v1.txt"
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$base1"
  run_bfs "$vault" push
  assert_ok
  local i
  for i in 0 1 2; do
    assert_file "$media/m$i/v0fixture/shard_$i.bfs.1"
  done
  assert_state "$vault" latest_version 1

  wipe_working_tree "$vault"
  run_bfs "$vault" pull --version 0 --yes
  assert_ok
  assert_restored "$vault" "$base"

  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_restored "$vault" "$base1"

  # Recovery that cannot open an encrypted version - its password is not in the
  # pool - records it as present but not recovered: an empty manifest file.
  # Version 0 recorded that way comes back through pull like any other version.
  # The marker is planted by hand on this unencrypted backup: the version 0
  # check runs before any decryption.
  printf '{}' > "$vault/.bfs/manifests/v000.json"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --version 0 --yes
  assert_ok
  assert_restored "$vault" "$base"
  assert_manifest_contains "$vault" 0 '"shards"'

  # Control: version 0 with no manifest is still "nothing pushed".
  local fresh="$SC_DIR/fresh"
  build_pool "$SC_DIR/fresh-pool" 3 0 "bfs134b"
  mkdir -p "$fresh"
  run_bfs "$fresh" init bfs134b --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$fresh" pull --yes
  assert_fail
  assert_out_contains "No versions available"
  return 0
}
