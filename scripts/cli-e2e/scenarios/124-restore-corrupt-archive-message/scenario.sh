# shellcheck shell=bash
# A restore that cannot unpack what it downloaded has to say so. Every checksum
# along the way can agree and the archive inside still be unreadable: the seal
# covers the bytes of the packed data, not whether those bytes parse. So the
# failure surfaces at the last possible moment, deep inside decompression, and
# what the operator gets there decides whether they can act on it.
#
# The damage is sealed in on purpose (corrupt-blob.ts --reseal): a stale
# checksum would be caught earlier, by the cache seal or the manifest hash,
# which is a different refusal and already covered elsewhere. Re-sealing is what
# models damage that no checksum can see - the only kind that reaches the
# unpacker.
#
# Binding assertions: the restore exits non-zero, says what went wrong in its
# own words, and does NOT surface an internal fault - no stack frames, no
# unhandled-rejection wording. A rejection that escapes the CLI's error handling
# is reported by the runtime instead, which costs the message, the exit code and
# the cleanup that hang off that handling.
#
# The route to a sealed-in fault: a push interrupted by a broken medium leaves
# its packed data in the cache (same lever as 99), the data is corrupted and
# re-sealed there, then `push --cache` uploads it as if it were sound.

SCENARIO_NAME="pull: an archive that cannot be unpacked is reported, not crashed on"
SCENARIO_DESC="3L 2/1 --compress; damage sealed into the packed data -> restore fails with a message, no internal fault"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-blob.ts"
  mkdir -p "$vault"

  build_pool "$SC_DIR" 3 0 "corruptarch"
  make_fixtures "$vault"
  make_large_file "$vault" 65536

  run_bfs "$vault" init "corruptarch" --ci --no-enc --compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  # Break one medium so the push stops partway: that is what leaves the packed
  # data behind in the cache, which is the only place it can be tampered with.
  local broken="${PV_LOCALDIR[2]}"
  rm -rf "$broken"
  : >"$broken"

  run_bfs "$vault" push
  assert_fail
  local cache="$vault/.bfs/cache/push.blob.pending"
  assert_file "$cache"

  rm -f "$broken"
  mkdir -p "$broken"

  # Corrupt the compressed data and re-seal, so nothing downstream can tell.
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$cache")" --reseal 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED"; then
    _fail "corrupt-blob driver did not report success: $BFS_OUT"
  fi
  if ! printf '%s' "$BFS_OUT" | grep -qF "resealed"; then
    _fail "corrupt-blob driver did not re-seal: $BFS_OUT"
  fi

  # Uploaded as sound - the seal agrees, because it was recomputed over the
  # damage.
  run_bfs "$vault" push --cache
  assert_ok

  rm -rf "$vault"/assets "$vault"/data "$vault"/nested
  rm -f "$vault"/hello.txt "$vault"/readme.md "$vault"/empty.txt

  run_bfs "$vault" pull --yes
  assert_fail
  # The restore must fail as a restore, not as a crash. These are the shapes an
  # escaped rejection takes; none of them may reach the operator.
  if printf '%s' "$BFS_OUT" | grep -qE "node:internal|ERR_UNHANDLED_REJECTION|UnhandledPromiseRejection"; then
    _fail "restore surfaced an internal fault instead of a message"
  fi
  if printf '%s' "$BFS_OUT" | grep -qE "^[[:space:]]+at [A-Za-z_$<]"; then
    _fail "restore printed a stack trace instead of a message"
  fi
  # And it has to say something about the data it could not use, so the operator
  # knows which of the many things a restore does went wrong.
  assert_out_matches "ZIP|archive|unpack|decompress|inflate"

  return 0
}
