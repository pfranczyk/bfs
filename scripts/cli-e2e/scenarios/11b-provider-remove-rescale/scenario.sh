# shellcheck shell=bash
# Provider dropped from the pool with `--strategy remove`: the medium is gone
# from the config but the stored scheme still demands the old N+K, so every
# restore is blocked until the operator rescales it. `bfs provider remove`
# names that one command and nothing else - how the pool comes to match its
# scheme, not how to rebuild or replace anything - and this proves the command
# it names is enough to restore bit-for-bit, then that a fresh copy and a prune
# still work on the smaller pool.
#
# `remove` is the only strategy that leaves the vault in a self-inconsistent
# state on purpose (no relocate target, no rebuild), so the one line it prints
# is load-bearing: it is what gets the operator out of that state.

SCENARIO_NAME="provider remove: rescale scheme, restore"
SCENARIO_DESC="drop p0 (--strategy remove) -> pull blocked by scheme mismatch -> scheme set 2 1 -> restore + healthy re-push"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" b2="$SC_DIR/v2.txt" name="bfs11b" i
  make_fixtures "$vault"
  # 4 media is the floor `--strategy remove` accepts (removeProvider refuses at
  # providers.length <= 3), and 3 survivors leave 2/1 as the only legal scheme.
  # 3/1 is the sharpest starting scheme of the legal ones: p0 carries shard_0,
  # a DATA shard, and K=1 puts the restore of v1 exactly at RS tolerance - no
  # slack hiding a broken reconstruction.
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$b1"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  for i in 0 1 2 3; do
    assert_file "$(shard_file "$i" 1)"
  done

  # -- The medium leaves the pool ---------------------------------------------
  run_bfs "$vault" provider remove p0 --strategy remove --yes
  assert_ok
  # One step, and it carries the arithmetic: the scheme has to add up to the
  # storages that are left. Nothing about pulling, pushing, pruning, replacing
  # or rebuilding - those are the operator's choices, not the way out of the
  # inconsistent state this command leaves behind. Read off what follows the
  # removal: what the command says before it does anything is a different
  # message with its own contract. Both the step and the removal line go to
  # stdout, while warnings go to stderr - read together, a warning printed before
  # the removal would land after the marker.
  assert_out_contains 'Provider "p0" removed.'
  local epilogue="${BFS_STDOUT#*Provider \"p0\" removed.}" step
  for step in 'bfs scheme set <N> <K>' 'N + K = 3'; do
    printf '%s' "$epilogue" | grep -qF -- "$step" || _fail "the step after the removal must carry: $step
$epilogue"
  done
  for step in 'bfs pull' 'bfs push' 'bfs prune' 'bfs repair' 'bfs provider add'; do
    if printf '%s' "$epilogue" | grep -qF -- "$step"; then
      _fail "the step after the removal must name only the scheme command, found: $step
$epilogue"
    fi
  done

  # p0 is out of the config, v1 lost its redundancy...
  if grep -q '"id": "p0"' "$vault/.bfs/config.json"; then
    _fail "p0 still in config.json after --strategy remove
--- config ---
$(cat "$vault/.bfs/config.json")"
  fi
  assert_manifest_health "$vault" 1 degraded
  # ...but nothing was deleted: `remove` never touches the medium's bytes.
  assert_file "$(shard_file 0 1)"
  # ...and the stored scheme still demands 4 media, which is the trap.
  grep -q '"data_shards": 3' "$vault/.bfs/config.json" ||
    _fail "expected the stored scheme to still be 3/1 after remove
--- config ---
$(cat "$vault/.bfs/config.json")"

  # -- Restore is blocked while the scheme disagrees with the pool ------------
  run_bfs "$vault" pull --force --yes
  assert_fail
  assert_out_contains 'requires 4 providers'
  assert_out_contains 'configured: 3'

  # -- The named step: match the scheme to the surviving media ----------------
  run_bfs "$vault" scheme set 2 1
  assert_ok
  grep -q '"data_shards": 2' "$vault/.bfs/config.json" ||
    _fail "scheme set 2 1 did not land in config.json
--- config ---
$(cat "$vault/.bfs/config.json")"

  # -- Then a restore. Wipe the working tree first (keep .bfs/) - this also drops
  # .bfsignore, which `pull --force` preserves, so its round-trip through the
  # blob is proven along with the fixtures.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/hello.txt"
  run_bfs "$vault" pull --force --yes
  assert_ok
  # v1 was pushed as 3/1 and exactly N=3 shards remain reachable - parity covers
  # the removed medium. This is the whole point of the scenario.
  assert_restored "$vault" "$b1"

  # -- A healthy copy onto the media that are left ---------------------------
  # Change the tree first: v2 must differ from v1, otherwise the closing restore
  # could not tell which version it actually came back from.
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$b2"
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 2
  assert_manifest_health "$vault" 2 healthy
  assert_manifest_contains "$vault" 2 '"data_shards": 2'
  assert_manifest_contains "$vault" 2 '"parity_shards": 1'
  # v2 has 3 shards, re-indexed onto the survivors p1..p3 (shard_i -> i-th
  # configured provider), and nothing was written to the removed medium.
  for i in 1 2 3; do
    assert_file "${PV_LOCALDIR[$i]}/$name/shard_$((i - 1)).bfs.2"
  done
  # Nothing at all reached the removed medium - checked as "no v2 artefact in
  # p0's vault dir", not as one predicted filename.
  if ls "${PV_LOCALDIR[0]}/$name/"*.bfs.2 >/dev/null 2>&1; then
    _fail "v2 artefacts written to the removed medium p0: $(ls "${PV_LOCALDIR[0]}/$name/")"
  fi

  # -- The degraded version dropped; the backup reads healthy again ---------
  run_bfs "$vault" prune 1 --yes
  assert_ok
  for i in 1 2 3; do
    assert_no_file "$(shard_file "$i" 1)"
  done
  # The removed medium keeps its orphaned v1 shard: BFS no longer knows that
  # location, so prune cannot and must not reach it.
  assert_file "$(shard_file 0 1)"
  run_bfs "$vault" verify
  assert_ok

  # Final proof: the re-pushed copy restores bit-for-bit from the smaller pool.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/new-file.txt"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$b2"

  # -- Floor control: the pool is now at the minimum, so a second `remove` is
  # refused. This is what makes 4 media the smallest pool this path can start
  # from - the parameter choice above, asserted rather than assumed.
  run_bfs "$vault" provider remove p1 --strategy remove --yes
  assert_fail
  assert_out_contains 'at least 3 storage providers'
  grep -q '"id": "p1"' "$vault/.bfs/config.json" ||
    _fail "refused removal must leave p1 in the config
--- config ---
$(cat "$vault/.bfs/config.json")"
  return 0
}
