# shellcheck shell=bash
# SHA-256 integrity helpers. The unit of comparison is the user's working tree
# excluding the BFS metadata directory (.bfs/) — that is what push packs and
# pull restores. .bfsignore (created by init) round-trips through the blob, so
# it is included and stays identical across the cycle.

# hash_tree <dir> — prints "relative/path  <sha256>" for every file under <dir>
# except .bfs/, sorted by path (stable, locale-independent ordering).
hash_tree() {
  local dir="$1"
  (
    cd "$dir" || return 1
    find . -type f -not -path './.bfs/*' -print0 |
      LC_ALL=C sort -z |
      while IFS= read -r -d '' f; do
        printf '%s  %s\n' "$f" "$(sha256sum "$f" | cut -d' ' -f1)"
      done
  )
}

# snapshot_hashes <dir> <outfile> — record a baseline before push.
snapshot_hashes() {
  hash_tree "$1" >"$2"
}

# assert_restored <dir> <baseline-file> — fail if the restored tree differs
# byte-for-byte from the recorded baseline.
assert_restored() {
  local dir="$1" baseline="$2" now
  now="$(mktemp "${RUN_WS:-/tmp}/hash.XXXXXX")"
  hash_tree "$dir" >"$now"
  if ! diff -u "$baseline" "$now" >"$now.diff" 2>&1; then
    echo "  ✗ restored tree differs from baseline:"
    sed 's/^/      /' "$now.diff"
    rm -f "$now" "$now.diff"
    exit 1
  fi
  rm -f "$now" "$now.diff"
}
