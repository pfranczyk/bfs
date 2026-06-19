# shellcheck shell=bash
# Recovery must survive a medium the operator cannot authenticate to. Bootstrap
# from a LOCAL provider (no seed secret), then at the FTP host-gate the operator
# approves the host but cannot supply a working password (blank = give up), so
# that medium is skipped. With N=2 of the 2+1 still reachable (the two local
# shards), recovery rebuilds .bfs/ degraded and a follow-up pull restores
# byte-for-byte. Twin of 28 (which supplies the password and succeeds full); here
# the password is withheld and the redundancy promise must hold without it.

SCENARIO_NAME="recovery skips an un-authable FTP medium"
SCENARIO_DESC="local bootstrap, FTP password withheld → skip, rebuild degraded from N, restore"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs39"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p0 L (bootstrap) · p1 L · p2 F

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Catastrophe: local metadata gone, only the providers remain.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Bootstrap from the LOCAL provider p0 (no seed secret), so recovery must
  # reconnect the FTP sibling interactively. The operator approves the host but
  # withholds the password (blank), declining that medium — it is skipped, and
  # the two local shards (N=2) carry the rebuild.
  local answers
  answers='[{"anchor":"Send it to this host","value":"y"},{"anchor":"FTP password for","value":""}]'
  run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$vault/.bfs/manifests/v001.json"
  assert_manifest_health "$vault" 1 degraded   # the skipped FTP shard is missing from the set

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
