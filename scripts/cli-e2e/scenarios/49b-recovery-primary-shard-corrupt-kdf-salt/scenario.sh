# shellcheck shell=bash
#
# The second way one shard's location map goes unreadable: a damaged KDF salt.
#
# 49 flips the tail of the GCM tag sealing the map, so the map itself no longer
# authenticates. Here the sealed map is untouched and the 16-byte Argon2id salt
# above it is not, so the key derived from the CORRECT password does not open it.
# Same outcome on that one shard, different cause - and a different trap: a
# version's salt is shared by all of its shards, so a reader that derives one key
# per version FROM THE DAMAGED SHARD's salt opens nothing anywhere, while the
# untouched siblings still carry the version's real salt and its map.
#
# Two versions are required to reach this at all: bootstrapping FROM a damaged
# shard fails earlier, in bootstrapFromProvider (src/vault/bootstrap.ts), and
# without that shard's map recovery cannot learn where the other providers are.
# Here the bootstrap provider's v2 shard is intact and carries the full provider
# list; only its v1 shard is damaged, so every v1 sibling is reachable.
#
# Recovery reports the differing salt on that storage with the command to check
# the backup, and the part can then be rebuilt in place with the correct
# password typed at the prompt - judged against a sibling whose map opens, not
# against the damaged part.

SCENARIO_NAME="recovery keeps and reports a version whose bootstrap shard has a damaged KDF salt"
SCENARIO_DESC="encrypted 2/1, v1 primary salt corrupt; v1 manifest from a healthy sibling, salt line, verify --deep, repair --rebuild via prompt"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" b2="$SC_DIR/v2.txt" name="bfs49b" pw="enc-secret-49b"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard-header.ts"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new --password "$pw"; assert_ok   # v1
  assert_manifest_health "$vault" 1 healthy

  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$b2"
  run_bfs "$vault" push --new --password "$pw"; assert_ok   # v2
  assert_manifest_health "$vault" 2 healthy

  # Catastrophe: the whole .bfs/ metadata directory is gone.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Damage the KDF salt of p0's v1 shard only. The header still parses and the
  # sealed map is byte-intact, but the key derived from the correct password no
  # longer opens it.
  local shard0v1
  shard0v1="$(shard_file 0 1)"
  assert_file "$shard0v1"
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard0v1")" --kdf-salt 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "HEADER-CORRUPTED mode=kdf-salt"; then
    _fail "corrupt-shard-header driver did not report a kdf-salt corruption: $BFS_OUT"
  fi
  # Everything else is untouched: p0's v2 shard (bootstrap reads this one) and
  # both v1 siblings, which carry the version's real salt and the same v1 map.
  assert_file "$(shard_file 0 2)"
  assert_file "$(shard_file 1 1)"
  assert_file "$(shard_file 2 1)"

  # Rebuild .bfs/ by bootstrapping from p0. --password seeds the pool with the
  # password that opens every shard of this backup, so no version needs operator
  # input. The run goes through a PTY so that a prompt would be a real, visible
  # prompt - the blank answer is a safety net that keeps a prompting run from
  # hanging on it, not an expected input.
  local answers
  answers='[{"anchor":"Enter password for version","value":""}]'
  run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --password "$pw" --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  # The correct password is already in the pool and the siblings' salt is intact,
  # so a prompt here means the damaged salt was taken for the whole version's.
  if printf '%s' "$BFS_OUT" | grep -qF "Enter password for version"; then
    _fail "recovery prompted for the v1 password although the healthy siblings carry the version's salt and open with --password"
  fi

  # Kept for the assertions on the salt line at the end: the steps below
  # overwrite BFS_OUT, and the check the line points to - plus the rebuild an
  # operator may choose after it - are executed first, so a path that does not
  # work is reported as such rather than hidden behind a missing sentence.
  local recovery_out="$BFS_OUT"

  # Control - the undamaged version is recovered.
  assert_file "$vault/.bfs/manifests/v002.json"

  # The damaged version: its salt and map are both readable from either healthy
  # v1 sibling, so the manifest must be rebuilt and the version must still restore.
  assert_file "$vault/.bfs/manifests/v001.json"
  run_bfs "$vault" pull --version 1 --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$b1"

  # The check the line points to works in the state it is printed in: the deep
  # check sees the damaged part (the salt sits under the part's trailing
  # SHA-256, which this damage did not recompute).
  run_bfs "$vault" verify --deep
  assert_exit 4
  # The way out the operator may choose after that check: rebuild the part in
  # place (empty settings keep its location). Run at a real terminal with the
  # correct password typed at the prompt - the path an operator takes - and the
  # retry left blank, so a prompt judged against the damaged part fails fast
  # instead of hanging.
  local repair_answers
  repair_answers="[{\"anchor\":\"Encryption password for version 1\",\"value\":\"$pw\"},{\"anchor\":\"Wrong password for version 1\",\"value\":\"\"}]"
  run_bfs_pty "$vault" "$repair_answers" --lang en repair --version 1 "${PV_ID[0]}" "" --rebuild
  if printf '%s' "$BFS_OUT" | grep -qF "Wrong password for version 1"; then
    _fail "repair told the operator the correct password is wrong - it was judged against the damaged part"
  fi
  assert_ok
  run_bfs "$vault" verify --deep
  assert_ok
  # The rebuilt part carries data: with a healthy sibling gone, restoring v1 has
  # to read it.
  rm -f "$(shard_file 1 1)"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --version 1 --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$b1"

  # What was seen is reported as such, not just the medium: p0's header carries
  # a salt the other parts do not, under the name the configuration gives that
  # storage, with the command to check the backup. BFS does not know why, so no
  # cause is guessed and no repair is offered.
  BFS_OUT="$recovery_out"
  assert_out_contains "Version 1: the header on storage ${PV_ID[0]} carries a different key salt than the other parts"
  assert_out_contains "Check the backup with \`bfs verify --deep\`"
  if printf '%s' "$BFS_OUT" | grep -qF "bfs repair --version"; then
    _fail "the salt line offered a repair command; it reports the state and the check only"
  fi
  # Control - the undamaged version names no salt mismatch.
  if printf '%s' "$BFS_OUT" | grep -qF "Version 2: the header on storage"; then
    _fail "recovery reported a key salt mismatch for v2, whose parts are all intact"
  fi
  return 0
}
