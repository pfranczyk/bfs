# shellcheck shell=bash
# The encrypted half of "a part that belongs somewhere else is refused by name".
# Split from the unencrypted scenario because a scenario stops at its first
# failed assertion: kept together, a regression in that half would hide whether
# these two still hold - and it is these two that decide whether an operator with
# the right password is told it is wrong.
#
# Every push draws a fresh KDF salt, so a part of another version is sealed under
# another key even though the password never changed. Nothing here is tampered
# with: each part is copied whole and passes its own trailing checksum.
#
# Layout in both passes: 3 LOCAL providers, 2 data + 1 parity, two versions
# pushed, then a part of v2 moved over the v1 part of the same index before v1
# is restored. With the stranger refused, N sound parts remain, so the restore
# has to go through and name the medium it dropped.
#
# Where the stranger sits changes what it takes with it:
#   A (index 1) - the size and salt come from a sound part and the key is
#     correct; only the stranger fails its GCM tag.
#   B (index 0) - the part read first is the one the whole version takes its blob
#     size and KDF salt from, so the stranger hands every sibling the salt IT was
#     sealed under: the key comes out wrong and all of them fail together. One
#     misplaced file, and a backup with redundancy to spare reports a wrong
#     password.

SCENARIO_NAME="encrypted restore refuses a part belonging to another version"
SCENARIO_DESC="a part sealed under another version's salt is named and dropped, and the password is not blamed"
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
  local pw="Secret123!"

  # --- Pass A: stranger at index 1 (size and salt stay sound) ----------------
  local va="$SC_DIR/vault-a" b1a="$SC_DIR/v1a.txt" name_a="bfs120ba"

  make_fixtures "$va"
  build_pool "$SC_DIR/pool-a" 3 0 "$name_a"

  run_bfs "$va" init "$name_a" --ci --enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$va" "$b1a"
  run_bfs "$va" push --new --password "$pw"
  assert_ok

  mutate_fixtures "$va"
  run_bfs "$va" push --new --password "$pw"
  assert_ok
  assert_state "$va" latest_version 2

  cp "$(shard_file 1 2)" "$(shard_file 1 1)"

  # The advice a failed restore is meant to give has to work in the state it is
  # given in, so it gets carried out here rather than assumed - and on an
  # encrypted backup it has to work without the password, since the identity
  # fields sit outside the encrypted location map. Run before the restore,
  # because a scenario stops at its first failed assertion.
  run_bfs "$va" --lang en verify
  assert_out_contains 'on provider "p1"'
  assert_out_contains 'header mismatch'

  run_bfs "$va" --lang en pull --version 1 --force --yes --password "$pw"
  assert_ok
  assert_restored "$va" "$b1a"
  assert_no_file "$va/new-file.txt"
  assert_out_matches '\bp1\b'
  # The password was right. Saying otherwise sends the operator after a secret
  # that is not the problem and hides the medium that is. Matched case-sensitive
  # on purpose: `grep -i` combined with -F aborts under Git Bash here, which
  # would leave this check passing on every output.
  if printf '%s' "$BFS_OUT" | grep -qF 'wrong key'; then
    _fail "the right password was blamed for a part that belongs to another version:
$BFS_OUT"
  fi
  _assert_no_wrong_cause p1

  # --- Pass B: stranger at index 0 (it would supply the salt) ----------------
  local vb="$SC_DIR/vault-b" b1b="$SC_DIR/v1b.txt" name_b="bfs120bb"

  make_fixtures "$vb"
  build_pool "$SC_DIR/pool-b" 3 0 "$name_b"

  run_bfs "$vb" init "$name_b" --ci --enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vb" "$b1b"
  run_bfs "$vb" push --new --password "$pw"
  assert_ok

  mutate_fixtures "$vb"
  run_bfs "$vb" push --new --password "$pw"
  assert_ok
  assert_state "$vb" latest_version 2

  cp "$(shard_file 0 2)" "$(shard_file 0 1)"

  run_bfs "$vb" --lang en pull --version 1 --force --yes --password "$pw"
  assert_ok
  assert_restored "$vb" "$b1b"
  assert_no_file "$vb/new-file.txt"
  assert_out_matches '\bp0\b'
  if printf '%s' "$BFS_OUT" | grep -qF 'wrong key'; then
    _fail "one misplaced part made the whole version unreadable and the password took the blame:
$BFS_OUT"
  fi
  _assert_no_wrong_cause p0
  # The sound media must come through unmentioned: a foreign salt fails them
  # all, so a word about either one means the stranger still spoke for the
  # whole version.
  if printf '%s' "$BFS_OUT" | grep -qE '\bp1\b|\bp2\b'; then
    _fail "a stranger at the first index must not implicate the sound media:
$BFS_OUT"
  fi

  return 0
}
