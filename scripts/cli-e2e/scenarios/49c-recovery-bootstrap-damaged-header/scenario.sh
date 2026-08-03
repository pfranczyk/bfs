# shellcheck shell=bash
#
# Bootstrapping FROM a shard whose header is damaged — the branch 49 and 49b
# both step around ("bootstrapping FROM a damaged shard fails earlier, in
# bootstrapFromProvider").
#
# bootstrapFromProvider (src/vault/bootstrap.ts) reads only the header window
# (readShardHeaderBytes in src/core/shard-io.ts), where the shard's trailing
# SHA-256 is out of reach. A key that does not open the location map therefore
# looks the same whether the salt rotted or the password is wrong — so once an
# attempt has failed, the shard is read once and its checksum settles it. A
# checksum that fails means no password will ever open this copy, and asking
# again would send the operator after the one thing that is not wrong, at the
# worst possible moment.
#
# What the copy is worth: every sibling carries the version's real salt and the
# same map, so recovery succeeds from any of them. This scenario pins both
# halves — the refusal must report that the copy on THIS provider does not check
# out, and the advice it gives must be executed here and shown to work.

SCENARIO_NAME="recovery refuses a bootstrap provider with a damaged header and names the way out"
SCENARIO_DESC="encrypted 2/1, bootstrap FROM the damaged shard; must not ask for a password it already holds"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" b1="$SC_DIR/v1.txt" name="bfs49c" pw="enc-secret-49c"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard-header.ts"

  make_fixtures "$vault"
  # Push the shards past the header window (SHARD_HEADER_READ_BYTES = 16 KB). On
  # a tiny backup the window IS the whole shard, and a checksum computed over the
  # window alone would pass here while condemning every healthy shard of a real
  # backup — the read has to cover the shard, not the prefix it already holds.
  make_large_file "$vault" 200000
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$b1"
  run_bfs "$vault" push --new --password "$pw"; assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Catastrophe: the whole .bfs/ metadata directory is gone.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Damage the KDF salt of p0's only shard — the very shard recovery is about to
  # bootstrap from. The header still parses; only the map no longer opens.
  local shard0v1
  shard0v1="$(shard_file 0 1)"
  assert_file "$shard0v1"
  # Guard the premise: drop make_large_file and the shard fits inside the header
  # window, at which point this scenario stops distinguishing a checksum over the
  # window from a checksum over the shard, and silently proves nothing.
  local shard_bytes
  shard_bytes="$(wc -c < "$shard0v1")"
  if [ "$shard_bytes" -le 16384 ]; then
    _fail "shard is ${shard_bytes} B — not larger than the 16 KB header window, so the scenario cannot tell the two reads apart"
  fi
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$shard0v1")" --kdf-salt 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "HEADER-CORRUPTED mode=kdf-salt"; then
    _fail "corrupt-shard-header driver did not report a kdf-salt corruption: $BFS_OUT"
  fi
  # The siblings are untouched — they carry the version's real salt and map.
  assert_file "$(shard_file 1 1)"
  assert_file "$(shard_file 2 1)"

  # Bootstrap FROM the damaged provider, with the CORRECT password. The run goes
  # through a PTY so a prompt would be a real, visible prompt; the blank answer
  # keeps a prompting run from hanging on it, it is not an expected input.
  local answers
  answers='[{"anchor":"Enter password for version","value":""}]'
  run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --password "$pw" --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_exit 1

  # No password can open a map sealed under a damaged salt, so asking for one is
  # advice that cannot be followed. Pinning the absence of the old prompt is what
  # catches a revert.
  if printf '%s' "$BFS_OUT" | grep -qF "Enter password for version"; then
    _fail "recovery asked for the password although --password was correct and no password can open a map under a damaged salt"
  fi
  assert_out_contains "on this provider failed its integrity check"
  # Reporting the fault without naming the way out is a readable dead end. The
  # sibling that works is asserted below — the message has to send them there.
  assert_out_contains "Recover from a different provider"
  assert_no_file "$vault/.bfs/config.json"

  # The advice must be executable — so execute it: same damage, bootstrap from a
  # healthy sibling. Without this the refusal could name any way out at all.
  run_bfs "$vault" --lang en recovery --provider local --name "$name" \
    --password "$pw" --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")"
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --version 1 --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$b1"
}
