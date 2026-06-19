# shellcheck shell=bash
# A storage's transport credential goes stale — someone changes the FTP password
# server-side, so the password saved in .bfs/config.json no longer authenticates.
# The promise: losing a medium to an auth failure (not a deleted shard) must not
# lose data — `bfs pull` skips the unreachable provider and reconstructs from the
# remaining N. Distinct from the existing loss scenarios, which all degrade by
# deleting a shard file; this degrades by a wrong credential, the path that has
# no other coverage and that an earlier wrong-password bug (vault key) crashed on.

SCENARIO_NAME="pull with a stale FTP credential"
SCENARIO_DESC="wrong saved FTP password → provider skipped, restore from remaining N"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs38"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L · p1 L · p2 F (2+1, N=2)

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # The FTP password saved at init is now wrong (changed on the server). Overwrite
  # only the transport credential in config.json — the shard on FTP is untouched,
  # so the only failure is authentication. node resolves the winpath'd config.
  node -e 'const fs=require("fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));const f=c.providers.find(x=>x.type==="ftp");if(!f){console.error("no ftp provider in config");process.exit(3);}f.config.password="wrong-password-xyz";fs.writeFileSync(p,JSON.stringify(c,null,2));' "$(winpath "$vault/.bfs/config.json")"

  run_bfs "$vault" pull --force --yes
  assert_ok                                  # auth failure must NOT crash the restore
  assert_out_contains "is not accessible"    # the FTP provider was skipped, not used
  assert_restored "$vault" "$base"           # data reconstructed from the 2 local shards
}
