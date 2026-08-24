# shellcheck shell=bash
# bfs repair without --ci, run where no terminal is attached.
#
# The contract at ProviderIO.interactive says an adapter is told "nobody is
# there" under --ci, under --bootstrap, OR whenever no terminal is attached.
# `repair` has no questions of its own, so it is the one command that can run
# start to finish from cron or a scheduler without ever stating a mode - and
# that is exactly the run this covers.
#
# Same cross-OS restore condition as 79 (every recorded base path is gone), but
# the flag is absent. The old sibling paths no longer exist, so LocalFs has to
# treat them as unreachable rather than ask whether to create them: the harness
# runs `bfs` with stdin from /dev/null, so a prompt here reaches end-of-input and
# takes the repair down with it. Reading the mode from the terminal instead of
# from the flag alone is what keeps this run alive.
#
# local: this IS the local-storage path - no remote medium involved.

SCENARIO_NAME="repair: relocate all providers with no flag and no terminal"
SCENARIO_DESC="3L 2/1; move every provider's storage, delete old paths, repair --version all (no --ci) with stdin closed, verify+pull byte-for-byte - the absent terminal, not the flag, must settle the mode"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs109"
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

  # Move every provider's storage and delete the old base dirs, so nothing in
  # the configuration still resolves to an existing path.
  local i
  for i in 0 1 2; do
    mkdir -p "$newroot/p$i"
    mv "${PV_LOCALDIR[$i]}/$name" "$newroot/p$i/"
    rm -rf "${PV_LOCALDIR[$i]}"
  done
  assert_file "$newroot/p0/$name/shard_0.bfs.1"

  # No --ci. The run still has no terminal, so the missing old paths must not
  # raise a create-prompt - there is no reader for it.
  run_bfs "$vault" repair --version all \
    p0 "--path $(winpath "$newroot/p0")" \
    p1 "--path $(winpath "$newroot/p1")" \
    p2 "--path $(winpath "$newroot/p2")"
  assert_ok

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # The point of the whole command: the data comes back byte for byte.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  return 0
}
