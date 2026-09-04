# shellcheck shell=bash
# A part that is internally sound but belongs somewhere else is refused by name,
# instead of being decoded as if it were the one that was asked for.
#
# The restore addresses a part by its file name alone - shard_{i}.bfs.{V} - so
# the read path asks the header whether the bytes under that name are the part
# it wanted. Files get moved by hand while data is being rescued, a sync script
# picks the wrong source, a medium comes back from the wrong snapshot: any of
# those leaves a healthy part of another version under the name of this one.
# Nothing is tampered with here - each part is copied whole, so it passes its own
# trailing checksum exactly as it did where it came from.
#
# Refused in time, the part is rebuilt from the parity and the medium holding it
# is named. Accepted, it costs the diagnosis - the operator hears that the copy
# is damaged, about media that are healthy, with no medium named to act on - and
# in pass A it costs the restore itself, which the redundancy would have carried.
#
# Layout in every pass: 3 LOCAL providers, 2 data + 1 parity, two versions
# pushed, then a part of v2 moved over the v1 part of the same index before v1
# is restored. With the stranger refused, N sound parts remain, so the restore
# goes through and names the medium it dropped.
#
# The two passes differ in where the stranger sits and what it takes with it:
#   A (index 0, v2 a different size) - the first part read is the one the whole
#     version takes its blob size from, so a stranger there speaks for every
#     other part as well and the sound siblings run out of stripe.
#   B (index 1, v2 the same size) - size and content length agree, so the
#     stranger travels the entire pipeline and only the closing blob hash would
#     notice, naming nothing.
#
# The encrypted half lives in its own scenario (`120b`): a scenario stops at its
# first failed assertion, so kept together, a regression in this half would hide
# whether the encrypted one still holds.

SCENARIO_NAME="restore refuses a part belonging to another version"
SCENARIO_DESC="a sound part from another version, moved under this one's name, is named and dropped instead of decoded"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

# Refusing a stranger must not borrow a cause that belongs to another state. The
# part is whole, so damage is wrong and sends the operator to a repair that
# rewrites sound bytes; it is on its medium, so absence is wrong and sends them
# after a file that never left. Both are a step away from any fix: the download
# loop prints the first for a failed checksum and the second for every other
# error raised inside it, so a refusal signalled by throwing lands on one of them
# by default.
_assert_no_wrong_cause() {
  local medium="$1"
  if printf '%s' "$BFS_OUT" | grep -qF "Backup data on \"$medium\" is damaged"; then
    _fail "a part in sound condition was reported as damaged instead of foreign:
$BFS_OUT"
  fi
  if printf '%s' "$BFS_OUT" | grep -qF "Backup data missing on storage \"$medium\""; then
    _fail "a part sitting on its medium was reported as missing:
$BFS_OUT"
  fi
}

scenario_run() {
  # --- Pass A: unencrypted, stranger at index 0 (the part read first) ---------
  local va="$SC_DIR/vault-a" b1a="$SC_DIR/v1a.txt" name_a="bfs120a"

  make_fixtures "$va"
  build_pool "$SC_DIR/pool-a" 3 0 "$name_a"

  run_bfs "$va" init "$name_a" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$va" "$b1a"
  run_bfs "$va" push --new
  assert_ok

  # v2 grows a file, so its parts describe a blob of a different size.
  mutate_fixtures "$va"
  run_bfs "$va" push --new
  assert_ok
  assert_state "$va" latest_version 2

  cp "$(shard_file 0 2)" "$(shard_file 0 1)"

  # The advice a failed restore is meant to give has to work in the state it is
  # given in, so it gets carried out here rather than assumed: `bfs verify` reads
  # the header window against the manifest and says which medium disagrees and
  # about what. Run before the restore, because a scenario stops at its first
  # failed assertion and this check must not depend on the restore going through.
  run_bfs "$va" --lang en verify
  assert_out_contains 'on provider "p0"'
  assert_out_contains 'header mismatch'

  run_bfs "$va" --lang en pull --version 1 --force --yes
  assert_ok
  assert_restored "$va" "$b1a"
  assert_no_file "$va/new-file.txt"
  # The medium holding the stranger is the one thing the operator can act on.
  assert_out_matches '\bp0\b'
  _assert_no_wrong_cause p0

  # --- Pass B: unencrypted, stranger at index 1, both versions the same size --
  local vb="$SC_DIR/vault-b" b1b="$SC_DIR/v1b.txt" name_b="bfs120b"

  make_fixtures "$vb"
  build_pool "$SC_DIR/pool-b" 3 0 "$name_b"

  run_bfs "$vb" init "$name_b" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vb" "$b1b"
  run_bfs "$vb" push --new
  assert_ok

  # Same byte count, different content: v2's parts are indistinguishable from
  # v1's by size alone, so nothing short of the header tells them apart.
  printf 'HELLO WORLD\n' >"$vb/hello.txt"
  run_bfs "$vb" push --new
  assert_ok
  assert_state "$vb" latest_version 2

  cp "$(shard_file 1 2)" "$(shard_file 1 1)"

  run_bfs "$vb" --lang en pull --version 1 --force --yes
  assert_ok
  assert_restored "$vb" "$b1b"
  assert_out_matches '\bp1\b'
  # The closing hash check is the last line of defence, not the diagnosis: it
  # blames the whole copy and names no medium, so reaching it means the restore
  # went ahead on a part it should have refused.
  if printf '%s' "$BFS_OUT" | grep -qF 'Backup data failed its integrity check'; then
    _fail "a part belonging to another version was decoded, and the copy took the blame:
$BFS_OUT"
  fi
  _assert_no_wrong_cause p1


  return 0
}
