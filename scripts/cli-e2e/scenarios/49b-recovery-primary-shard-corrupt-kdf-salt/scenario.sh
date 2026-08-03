# shellcheck shell=bash
#
# The second way one shard's location map goes unreadable: a damaged KDF salt.
#
# 49 flips the tail of the GCM tag sealing the map, so the map itself no longer
# authenticates. Here the sealed map is untouched and the 16-byte Argon2id salt
# above it is not, so the key derived from the CORRECT password does not open it.
# Same outcome on that one shard, different cause — and a different trap: a
# version's salt is shared by all of its shards, so a reader that derives one key
# per version FROM THE DAMAGED SHARD's salt opens nothing anywhere, while the
# untouched siblings still carry the version's real salt and its map.
#
# Two versions are required to reach this at all: bootstrapping FROM a damaged
# shard fails earlier, in bootstrapFromProvider (src/vault/bootstrap.ts), and
# without that shard's map recovery cannot learn where the other providers are.
# Here the bootstrap provider's v2 shard is intact and carries the full provider
# list; only its v1 shard is damaged, so every v1 sibling is reachable.

SCENARIO_NAME="recovery keeps a version whose bootstrap shard has a damaged KDF salt"
SCENARIO_DESC="encrypted 2/1, v1 primary salt corrupt; v1 manifest must come from a healthy sibling"
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
  # prompt — the blank answer is a safety net that keeps a prompting run from
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

  # Control — the undamaged version is recovered.
  assert_file "$vault/.bfs/manifests/v002.json"

  # The damaged version: its salt and map are both readable from either healthy
  # v1 sibling, so the manifest must be rebuilt and the version must still restore.
  assert_file "$vault/.bfs/manifests/v001.json"
  run_bfs "$vault" pull --version 1 --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$b1"
}
