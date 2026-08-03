# shellcheck shell=bash
#
# A corrupt header on ONE shard of ONE version must not cost the whole version.
#
# Recovery rebuilds each version's manifest from the shard headers it finds on
# the providers. Within a version every shard carries the SAME kdf_salt and the
# SAME location map — only the map's ciphertext differs, each sealed under its
# own random nonce — so the map of a version is readable from any of its shards.
#
# processVersion in src/vault/recovery.ts resolves the map from the first shard
# it collected (the bootstrap provider's), so damaging just that one shard's
# encrypted map decides the fate of its whole version: tryDecryptLocationMap
# (src/vault/password-pool.ts) exhausts the password pool, recovery warns
# (recovery_decrypt_skip) and drops the version — while the untouched siblings
# of that same version still hold a map that opens with the very password
# already in the pool.
#
# Two versions are required to reach this at all: bootstrapping FROM a damaged
# shard fails earlier, in bootstrapFromProvider (src/vault/bootstrap.ts), and
# without that shard's map recovery cannot learn where the other providers are.
# Here the bootstrap provider's v2 shard is intact and carries the full provider
# list; only its v1 shard is damaged, so every v1 sibling is reachable.
#
# The healthy version (v2) is asserted first and restored byte-for-byte: proof
# that recovery itself works and that the damage is isolated to v1.

SCENARIO_NAME="recovery keeps a version whose bootstrap shard header is corrupt"
SCENARIO_DESC="encrypted 2/1, v1 primary map undecryptable; v1 manifest must come from a healthy sibling"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" b2="$SC_DIR/v2.txt" name="bfs49" pw="enc-secret-49"
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

  # Damage the header — not the payload — of p0's v1 shard only. The flipped
  # byte is the last byte of the GCM tag over its encrypted location map, so the
  # header still parses but no password opens its map.
  local shard0v1
  shard0v1="$(shard_file 0 1)"
  assert_file "$shard0v1"
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard0v1")" --map 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "HEADER-CORRUPTED"; then
    _fail "corrupt-shard-header driver did not report success: $BFS_OUT"
  fi
  # Everything else is untouched: p0's v2 shard (bootstrap reads this one) and
  # both v1 siblings, which carry the same v1 location map.
  assert_file "$(shard_file 0 2)"
  assert_file "$(shard_file 1 1)"
  assert_file "$(shard_file 2 1)"

  # Rebuild .bfs/ by bootstrapping from p0. --password seeds the pool with the
  # very password that opens every shard of this backup, so no operator input is
  # needed for any version: v1's map is readable from either healthy sibling with
  # exactly that password. The run goes through a PTY so that a prompt would be a
  # real, visible prompt — the blank answer is a safety net that keeps a prompting
  # run from hanging on it, not an expected input.
  local answers
  answers='[{"anchor":"Enter password for version","value":""}]'
  run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --password "$pw" --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  # Asking for the version password here asks the operator for something they
  # already supplied — and something two undamaged shards accept.
  if printf '%s' "$BFS_OUT" | grep -qF "Enter password for version"; then
    _fail "recovery prompted for the v1 password although --password already opens v1 on both healthy siblings"
  fi

  # Control — the undamaged version is recovered and restores byte-for-byte.
  assert_file "$vault/.bfs/manifests/v002.json"
  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$b2"

  # The damaged version: its map is readable from either healthy v1 sibling, so
  # the manifest must be rebuilt and the version must still restore.
  assert_file "$vault/.bfs/manifests/v001.json"
  run_bfs "$vault" pull --version 1 --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$b1"
}
