# shellcheck shell=bash
# A storage dropped with `bfs provider remove --strategy remove` leaves the pool
# one short of the scheme. Adding a new storage fills that gap: the scheme stays
# what it was, so the operator gets the original redundancy back without first
# lowering it and then raising it again by hand.
#
# What this pins is the route without any `bfs scheme set`. It is executed end
# to end rather than matched: the removal names the way back, the new storage
# goes in, the version that lost its part is rebuilt onto it, and the restore
# reads the rebuilt part. A fix that only rewrote the messages would leave the
# add raising parity, which the scheme assertion after it catches.
#
# The control at the end keeps the other half of `provider add` as it is: on a
# pool that already matches the scheme, a new storage still adds one parity part.

SCENARIO_NAME="provider add fills the gap a removed storage left, scheme unchanged"
SCENARIO_DESC="4L 3/1; remove -> add -> repair --rebuild, no scheme set; full pool: add still raises parity to 3/2"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

# Fails unless .bfs/config.json holds this scheme (the lines as writeConfig serializes them).
assert_config_scheme() {
  local cf="$1/.bfs/config.json"
  grep -q "\"data_shards\": $2" "$cf" && grep -q "\"parity_shards\": $3" "$cf" ||
    _fail "config.json scheme is not $2/$3. Got:
$(grep -E '"(data|parity)_shards"' "$cf" || echo '<none>')"
}

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs141" b1="$SC_DIR/v1.txt"
  local spare="$SC_DIR/spare" extra="$SC_DIR/extra"
  make_fixtures "$vault"
  # 4 media at 3/1: the floor `--strategy remove` accepts without --force.
  build_pool "$SC_DIR" 4 0 "$name"
  mkdir -p "$spare" "$extra"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- The storage is gone; the pool is one short of 3/1 -----------------------
  run_bfs "$vault" provider remove p3 --strategy remove --yes
  assert_ok
  assert_config_no_provider "$vault" p3
  assert_config_scheme "$vault" 3 1
  assert_manifest_health "$vault" 1 degraded
  # The removal names both ways back: a new storage keeps the scheme, a scheme
  # matched to the survivors lowers it.
  assert_out_contains 'bfs provider add'
  assert_out_contains 'bfs scheme set <N> <K>'

  # -- A new storage fills the gap, the scheme stays 3/1 -----------------------
  run_bfs "$vault" provider add --ci --name p4 --type local --path "$(winpath "$spare")"
  assert_ok
  assert_config_provider "$vault" p4
  assert_config_scheme "$vault" 3 1

  # -- The lost part is rebuilt onto the new storage, no scheme set ------------
  run_bfs "$vault" repair --version all --rebuild p4 "local:p3 --path $(winpath "$spare")"
  assert_ok
  assert_file "$spare/$name/shard_3.bfs.1"
  run_bfs "$vault" verify
  assert_exit 0
  assert_manifest_health "$vault" 1 healthy

  # -- Binding proof that the rebuilt part carries the data -------------------
  # One sibling is taken away, so the restore cannot reach the file contents
  # without reading what was just reconstructed.
  rm -f "${PV_LOCALDIR[0]}/$name/shard_0.bfs.1"
  wipe_working_tree "$vault"
  assert_no_file "$vault/hello.txt"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$b1"

  # -- Control: on a full pool a new storage still adds parity ----------------
  run_bfs "$vault" provider add --ci --name p5 --type local --path "$(winpath "$extra")"
  assert_ok
  assert_config_provider "$vault" p5
  assert_config_scheme "$vault" 3 2
  return 0
}
