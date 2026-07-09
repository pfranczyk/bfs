# shellcheck shell=bash
# bfs repair: relocate EVERY provider to a new path non-interactively (--ci).
# This is the cross-OS restore condition: a backup created on one machine is
# restored on another where none of the source paths exist. All provider base
# paths recorded in config are gone, so repair must relocate all of them at once
# without prompting. LocalFs.authenticate() must treat a missing path as
# unreachable (like FtpProvider) instead of asking io.confirm() — under --ci
# there is nobody to answer, so a prompt aborts/hangs the restore.

SCENARIO_NAME="repair: relocate all providers non-interactively"
SCENARIO_DESC="3L 2/1; move every provider's storage, delete old paths, repair --ci --version all to all new paths, verify+pull byte-for-byte — no prompt"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs79"
  local newroot="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Move EVERY provider's storage to a new base path and delete the old base
  # dirs, so no path in config still exists — the cross-OS restore condition.
  # No sibling stays reachable at its recorded location.
  local i
  for i in 0 1 2; do
    mkdir -p "$newroot/p$i"
    mv "${PV_LOCALDIR[$i]}/$name" "$newroot/p$i/"
    rm -rf "${PV_LOCALDIR[$i]}"
  done
  assert_file "$newroot/p0/$name/shard_0.bfs.1"

  # Relocate all three at once. --ci means no interactive answer is available;
  # the missing old sibling paths must not trigger a create-prompt.
  run_bfs "$vault" repair --ci --version all \
    p0 "--path $(winpath "$newroot/p0")" \
    p1 "--path $(winpath "$newroot/p1")" \
    p2 "--path $(winpath "$newroot/p2")"
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
