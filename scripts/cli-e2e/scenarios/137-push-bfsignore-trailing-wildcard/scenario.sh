# shellcheck shell=bash
# The interactive push gate must not drop neighbouring files from the backup.
#
# Push refuses a symlink it cannot back up and, in the REPL, offers to add it
# to .bfsignore and retry. The entry is written as an escaped, root-anchored
# pattern, so a symlink named `data*` becomes `/data\*`. That escaped `*` sits at
# the very end of the pattern; a matcher that reads it as a wildcard excludes
# every name starting with `data` - here data.db and the whole database/ tree -
# and the retried push still succeeds, because its progress guard only checks
# that the symlink itself disappeared. Every later backup is then silently short.
#
# Proof: the push runs in the REPL on a real terminal (run_bfs_pty) and accepts the offer;
# the working tree is wiped and restored, and the SHA-256 tree must match the
# one taken after the push - data.db and database/ included.
#
# POSIX-only: NTFS forbids `*` in a name and a symlink needs admin rights on
# Windows, so the scenario self-skips (returns PASS) there.

SCENARIO_NAME="push gate: a trailing escaped wildcard in .bfsignore excludes only that entry"
SCENARIO_DESC="symlink data* next to data.db + database/; push on a terminal adds it to .bfsignore; restore brings data.db and database/ back byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs137"

  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      echo "  (skip) names with '*' and symlinks are unavailable on Windows"
      return 0
      ;;
  esac

  make_fixtures "$vault"
  printf 'rows\n' >"$vault/data.db"
  mkdir -p "$vault/database"
  printf 'table\n' >"$vault/database/rows.bin"
  ln -s hello.txt "$vault/data*" 2>/dev/null || true
  if [ ! -L "$vault/data*" ]; then
    echo "  (skip) symlinks unavailable on this filesystem"
    return 0
  fi

  build_pool "$SC_DIR" 3 0 "$name"
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  # The offer exists only in the REPL (a standalone `bfs push` refuses with exit 3,
  # see 46), so the session types `push`, accepts, waits for the next REPL prompt
  # and leaves. Without a sub-command `bfs` starts the REPL.
  local answers
  answers='[{"anchor":"bfs > ","value":"push"},'
  answers+='{"anchor":"Add them to .bfsignore and retry?","value":"y"},'
  answers+='{"anchor":"bfs > ","value":"exit"}]'
  run_bfs_pty "$vault" "$answers" --lang en
  assert_exit 0
  assert_out_contains "Add them to .bfsignore and retry?"
  assert_manifest_health "$vault" 1 healthy
  if ! grep -qxF '/data\*' "$vault/.bfsignore"; then
    _fail ".bfsignore does not hold the escaped pattern /data\\*"
  fi

  # Taken after the push, so the appended .bfsignore is part of the baseline;
  # find -type f skips the symlink, which is rightly not in the backup.
  snapshot_hashes "$vault" "$base"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_file "$vault/data.db"
  assert_file "$vault/database/rows.bin"
  assert_restored "$vault" "$base"
  return 0
}
