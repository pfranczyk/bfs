# shellcheck shell=bash
# Recovery that reaches a version it cannot open, and the push that follows.
#
# The storage bootstrapped from does not carry the newest version. Bootstrap
# takes the highest version IT can see, so it opens v1 with the password on hand,
# and only afterwards, listing the other storages, does recovery meet v2 -
# encrypted under a password nobody supplied. It skips v2 and reports success,
# which is fine. What must not follow is the copy forgetting that v2 is out there.
#
# The scenario removes v2 from that one storage directly. A real copy reaches the
# same state through a push whose upload to it failed (a degraded version), or
# through a storage that joined the pool later; what matters here is the state of
# the storage, not the route to it.
#
# `latest_version` is defined as the highest version on the storage, and `push`
# takes the next number from it. Set from the highest *recovered* version
# instead, it hands the next push a number that is already taken, and that push
# writes over the parts of the version whose password the operator has yet to
# remember. Nothing warns: the collision guard passes own-vault parts through by
# design, since re-pushing onto your own storage is the normal case.
#
# Binding assertions: the surviving parts of v2 keep their SHA-256 across the
# push, and the push lands on a free version number. `assert_state` pins the
# cause; the exit code proves nothing here, because both runs report success.

SCENARIO_NAME="recovery meets a version it cannot open"
SCENARIO_DESC="push after partial recovery must not reuse a version number that exists on the storage"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs116"
  local pw_old="old-secret-116" pw_new="new-secret-116"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new --password "$pw_old"   # v1, password the operator still knows
  assert_ok

  mutate_fixtures "$vault"
  run_bfs "$vault" push --new --password "$pw_new"   # v2, password rotated
  assert_ok

  # The first storage never received v2 - that upload failed. Bootstrap will
  # therefore open v1, and meet v2 only while listing the other two.
  rm -f "$(shard_file 0 2)"
  assert_no_file "$(shard_file 0 2)"

  # The parts of v2 that survive, as they lie on the storage right now. Only
  # their password is missing; the data is intact and must stay that way.
  local v2_shard1 v2_shard2
  v2_shard1="$(sha256sum "$(shard_file 1 2)" | cut -d' ' -f1)"
  v2_shard2="$(sha256sum "$(shard_file 2 2)" | cut -d' ' -f1)"

  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Only the OLD password is supplied: v1 opens, v2 does not.
  run_bfs "$vault" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")" --password "$pw_old" --trust-locations
  assert_ok
  assert_out_contains 'Version 2 skipped'
  assert_file "$vault/.bfs/manifests/v001.json"

  # v2 is on the storage, so it is the latest version there - whether or not this
  # machine could open it.
  assert_state "$vault" latest_version 2

  # The next push must claim a free number, not walk over v2.
  run_bfs "$vault" push --new --password "$pw_new"
  assert_ok
  assert_file "$(shard_file 0 3)"

  [ "$(sha256sum "$(shard_file 1 2)" | cut -d' ' -f1)" = "$v2_shard1" ] ||
    _fail "push overwrote part 1 of version 2 - the version whose password was missing"
  [ "$(sha256sum "$(shard_file 2 2)" | cut -d' ' -f1)" = "$v2_shard2" ] ||
    _fail "push overwrote part 2 of version 2 - the version whose password was missing"

  # And the version that did recover still restores byte for byte.
  run_bfs "$vault" pull --version 1 --force --yes --password "$pw_old"
  assert_ok
  assert_restored "$vault" "$base"
}
