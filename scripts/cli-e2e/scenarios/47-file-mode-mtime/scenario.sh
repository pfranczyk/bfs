# shellcheck shell=bash
# init -> push --compress -> pull, then assert the restored files keep their
# METADATA: POSIX mode (chmod) and mtime, not just their bytes. Content already
# round-trips (assert_restored); this scenario guards that the default
# (compressed) restore path also preserves mode and mtime.
#
# The compressed unpack path applies per-file mode/mtime from the v2 file-table
# entries. On Windows the mode assertion is skipped (chmod is a no-op there) and
# only mtime is checked; on POSIX both mode and mtime are asserted.

SCENARIO_NAME="local 3/1 file mode + mtime restore"
SCENARIO_DESC="init/push (compressed)/pull, restored files keep POSIX mode and mtime"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs47"
  make_fixtures "$vault"

  # Give several files distinct non-default modes (owner/group/other, exec,
  # read-only, group-write) plus a fixed non-current mtime, so a restore that
  # drops metadata is observable. Every mode differs from the umask default 0644
  # to keep the check meaningful; 0660 also catches a umask-masking restore.
  chmod 0700 "$vault/hello.txt"
  chmod 0600 "$vault/readme.md"
  chmod 0640 "$vault/data/numbers.csv"
  chmod 0660 "$vault/data/config.json"
  chmod 0755 "$vault/nested/deep/note.txt"
  chmod 0444 "$vault/assets/blob.bin"
  touch -d '2021-06-15T12:00:00' "$vault/hello.txt"

  # Capture mtime in the SAME format the assertion reads back (stat -c %Y).
  local want_mtime
  want_mtime="$(stat -c '%Y' "$vault/hello.txt")"

  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"

  # --compress is explicit (not relying on the config default) so this scenario
  # keeps targeting the compressed restore path even if the default ever flips.
  run_bfs "$vault" push --new --compress
  assert_ok
  assert_out_contains "healthy"

  # Full restore over the working tree: content matches byte-for-byte (passes).
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Metadata must survive the round-trip: mtime on every OS, mode on POSIX only.
  assert_file_mtime_epoch "$vault/hello.txt" "$want_mtime"
  assert_file_mode "$vault/hello.txt" 700
  assert_file_mode "$vault/readme.md" 600
  assert_file_mode "$vault/data/numbers.csv" 640
  assert_file_mode "$vault/data/config.json" 660
  assert_file_mode "$vault/nested/deep/note.txt" 755
  assert_file_mode "$vault/assets/blob.bin" 444
}
