# shellcheck shell=bash
# Provider dropped from the pool with `--strategy remove`: the medium is gone
# from the config but the stored scheme still demands the old N+K, so every
# restore is blocked until the operator rescales it. This walks the exact
# remediation list `bfs provider remove` prints — scheme set → pull → push →
# prune — and proves it ends in data the operator can restore bit-for-bit.
#
# `remove` is the only strategy that leaves the vault in a self-inconsistent
# state on purpose (no relocate target, no rebuild), so the guidance text is
# load-bearing: it is the only thing telling the operator how to get out.

SCENARIO_NAME="provider remove: rescale scheme, restore"
SCENARIO_DESC="drop p0 (--strategy remove) → pull blocked by scheme mismatch → scheme set 2 1 → restore + healthy re-push"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" b2="$SC_DIR/v2.txt" name="bfs11b" i
  make_fixtures "$vault"
  # 4 media is the floor `--strategy remove` accepts (removeProvider refuses at
  # providers.length <= 3), and 3 survivors leave 2/1 as the only legal scheme.
  # 3/1 is the sharpest starting scheme of the legal ones: p0 carries shard_0,
  # a DATA shard, and K=1 puts the restore of v1 exactly at RS tolerance — no
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

  # ── The medium leaves the pool ─────────────────────────────────────────────
  run_bfs "$vault" provider remove p0 --strategy remove --yes
  assert_ok
  # The remediation list is the operator's only exit from the inconsistent
  # state, so pin it: the steps this scenario then executes, in order.
  assert_out_contains 'Recommended next steps:'
  assert_out_contains '1. `bfs scheme set <N> <K>`'
  assert_out_contains '2. `bfs pull`'
  assert_out_contains '3. `bfs push`'
  assert_out_contains '4. `bfs prune`'

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

  # ── Restore is blocked while the scheme disagrees with the pool ────────────
  run_bfs "$vault" pull --force --yes
  assert_fail
  assert_out_contains 'requires 4 providers'
  assert_out_contains 'configured: 3'

  # ── Step 1 of the printed list: match the scheme to the surviving media ────
  run_bfs "$vault" scheme set 2 1
  assert_ok
  grep -q '"data_shards": 2' "$vault/.bfs/config.json" ||
    _fail "scheme set 2 1 did not land in config.json
--- config ---
$(cat "$vault/.bfs/config.json")"

  # ── Step 2: pull. Wipe the working tree first (keep .bfs/) — this also drops
  # .bfsignore, which `pull --force` preserves, so its round-trip through the
  # blob is proven along with the fixtures.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/hello.txt"
  run_bfs "$vault" pull --force --yes
  assert_ok
  # v1 was pushed as 3/1 and exactly N=3 shards remain reachable — parity covers
  # the removed medium. This is the whole point of the scenario.
  assert_restored "$vault" "$b1"

  # ── Step 3: push a healthy copy onto the media that are left ───────────────
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
  # v2 has 3 shards, re-indexed onto the survivors p1..p3 (shard_i → i-th
  # configured provider), and nothing was written to the removed medium.
  for i in 1 2 3; do
    assert_file "${PV_LOCALDIR[$i]}/$name/shard_$((i - 1)).bfs.2"
  done
  # Nothing at all reached the removed medium — checked as "no v2 artefact in
  # p0's vault dir", not as one predicted filename.
  if ls "${PV_LOCALDIR[0]}/$name/"*.bfs.2 >/dev/null 2>&1; then
    _fail "v2 artefacts written to the removed medium p0: $(ls "${PV_LOCALDIR[0]}/$name/")"
  fi

  # ── Step 4: drop the degraded version; the backup reads healthy again ──────
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

  # ── Floor control: the pool is now at the minimum, so a second `remove` is
  # refused. This is what makes 4 media the smallest pool this path can start
  # from — the parameter choice above, asserted rather than assumed.
  run_bfs "$vault" provider remove p1 --strategy remove --yes
  assert_fail
  assert_out_contains 'at least 3 storage providers'
  grep -q '"id": "p1"' "$vault/.bfs/config.json" ||
    _fail "refused removal must leave p1 in the config
--- config ---
$(cat "$vault/.bfs/config.json")"
  return 0
}
