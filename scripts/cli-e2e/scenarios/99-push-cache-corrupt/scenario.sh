# shellcheck shell=bash
# A cache that rotted BETWEEN runs must never reach the media. `bfs push --cache`
# resumes from `.bfs/cache/push.blob.pending`, and the blob seals its own content
# with a trailing SHA-256 - so the bytes about to be uploaded can be checked
# against the checksum they were written with, before a single part leaves the
# machine.
#
# Without that check the damage is invisible for the whole life of the backup:
# the parts are sealed over the corrupt bytes, so every part is internally
# consistent, `bfs verify --deep` sees nothing, and the manifest says healthy.
# The truth surfaces at the first restore, as "Blob checksum mismatch - data is
# corrupted or tampered" - a message that accuses the media or an attacker for
# damage that happened in the local cache at upload time.
#
# The corruption is injected past the file table (see lib/corrupt-blob.ts), so
# the resume path parses the cache exactly as it would a sound one.

SCENARIO_NAME="push --cache refuses a cache that no longer matches its checksum"
SCENARIO_DESC="cache rotted between runs -> push refuses before upload, media keep the old version"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs99"
  local corrupt_driver
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-blob.ts"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  # Baseline AFTER init so .bfsignore round-trips into the assertion (see 01).
  snapshot_hashes "$vault" "$base"

  # Break provider p2 so the push goes partial: its base directory becomes a
  # regular file, and local-fs upload() fails with ENOTDIR (same lever as 17).
  # The partial push is what produces the cache this scenario is about.
  local broken="${PV_LOCALDIR[2]}"
  rm -rf "$broken"
  : >"$broken"

  run_bfs "$vault" push --new
  assert_exit 1
  assert_manifest_health "$vault" 1 degraded
  local cache="$vault/.bfs/cache/push.blob.pending"
  assert_file "$cache"

  # Fix the medium - the resume is now legitimate in every respect except the
  # cache itself.
  rm -f "$broken"
  mkdir -p "$broken"

  # Rot one byte of the cached blob's data section, leaving the header and file
  # table intact and the trailing checksum unrecomputed.
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$cache")" 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "CORRUPTED"; then
    _fail "corrupt-blob driver did not report success: $BFS_OUT"
  fi

  # Parts 0, 1 and 3 landed during the partial push, and an overwrite resume
  # rewrites them in place - so their bytes, not the part that never arrived,
  # are what proves the refusal came before anything was sent.
  local survivor survivor_before survivor_after
  survivor="$(shard_file 0 1)"
  assert_file "$survivor"
  survivor_before="$(sha256sum "$survivor" | cut -d' ' -f1)"

  run_bfs "$vault" push --cache --overwrite
  assert_fail
  assert_out_contains "no longer matches its checksum"
  # Naming the cache is what separates this from damage on a medium - the
  # operator must not go looking at the storage for a fault that is local.
  assert_out_contains "push.blob.pending"
  assert_manifest_health "$vault" 1 degraded
  assert_no_file "$(shard_file 2 1)"
  survivor_after="$(sha256sum "$survivor" | cut -d' ' -f1)"
  if [ "$survivor_before" != "$survivor_after" ]; then
    _fail "refusal must not rewrite a part already on a medium: $survivor_before -> $survivor_after"
  fi
  # The forensic state has to survive the refusal, or the operator loses the
  # very cache the message tells them to deal with.
  assert_lock_exists "$vault"
  assert_file "$cache"

  # The advice must lead somewhere reachable, in the order it is given. The
  # refusal keeps the lock, so a bare push cannot be the first step - it stops
  # on the leftover state and sends the operator to `bfs clear` anyway.
  assert_out_contains "bfs clear"
  run_bfs "$vault" push --new
  assert_fail
  assert_out_contains "bfs clear"

  run_bfs "$vault" clear
  assert_ok
  assert_no_file "$cache"

  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 2 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
