# shellcheck shell=bash
# `bfs verify` names the storage a version records but the configuration no
# longer knows - and says nothing about what to do with it. What comes next
# depends on why the storage left: removed for good, replaced, or renamed by an
# interrupted repair. verify cannot tell those apart, so it reports the state
# and offers no command.
#
# Three states of the pool hide under that one line, and the pool is counted
# differently in each: a configured storage no version uses, a pool short of
# what the scheme requires, and a pool that matches its scheme with every
# storage taken. A remedy keyed to those counts would surface in one of them and
# not the others, so all three are reached in one chain, each step changing one
# thing, and each is checked for the absence of every command an operator could
# be pointed at.
#
# The chain closes with a restore: a report that names no remedy must not be
# hiding a backup that can no longer be put back together.

SCENARIO_NAME="verify names a storage outside the configuration and offers no command"
SCENARIO_DESC="4L 3/1; free entry -> pool short -> every storage taken; each state named, no command offered; restore still bit-for-bit"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

NAMED='Version v001 - Storage recorded in this backup but absent from the configuration: p3.'

# Fails unless $1 is absent from the run's output.
assert_out_lacks() {
  if printf '%s' "$BFS_OUT" | grep -qF -- "$1"; then
    _fail "$2:
$BFS_OUT"
  fi
}

# The state is named and nothing is prescribed about it.
assert_state_only() {
  assert_out_contains "$NAMED"
  local command
  for command in 'bfs repair' 'bfs scheme set' 'bfs push' 'bfs pull' 'bfs prune' 'bfs provider add'; do
    assert_out_lacks "$command" "verify must not offer \`$command\` ($1)"
  done
}

scenario_run() {
  local vault="$SC_DIR/vault" cfg="$SC_DIR/vault/.bfs/config.json" name="bfs130" b1="$SC_DIR/v1.txt"
  make_fixtures "$vault"
  # 4 media: the floor `--strategy remove` accepts (removeProvider refuses at
  # providers.length <= 3), which the middle state needs. 3/1 leaves 2/1 as the
  # only legal scheme for the 3 survivors.
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- Positive control: a sound backup names nothing --------------------------
  run_bfs "$vault" verify
  assert_exit 0
  assert_out_lacks 'absent from the configuration' 'a healthy backup must not report a storage outside the configuration'

  # -- State 1: a configured storage nobody uses -------------------------------
  # The shape an interrupted `bfs repair` leaves behind: the configuration
  # already carries the new name, the manifests still carry the old one
  # (migrateInPlace writes the configuration before it rewrites manifests).
  node -e 'const fs=require("fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));c.providers[3].id="p3-away";fs.writeFileSync(p,JSON.stringify(c,null,2));' "$(winpath "$cfg")"

  run_bfs "$vault" verify
  assert_exit 4
  assert_manifest_health "$vault" 1 degraded
  assert_state_only 'a configured storage nobody uses'

  # -- State 2: the pool is short of storages ----------------------------------
  run_bfs "$vault" provider remove p3-away --strategy remove --yes
  assert_ok

  run_bfs "$vault" verify
  assert_exit 4
  assert_state_only 'the pool one storage short'

  # -- State 3: the pool matches again, every storage taken --------------------
  run_bfs "$vault" scheme set 2 1
  assert_ok

  run_bfs "$vault" verify
  assert_exit 4
  assert_state_only 'every storage taken'

  # -- The backup still comes back --------------------------------------------
  # v001 lost one part of four at 3/1, so it sits exactly at its tolerance: the
  # restore has to read every part that is left.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/hello.txt"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$b1"
  return 0
}
