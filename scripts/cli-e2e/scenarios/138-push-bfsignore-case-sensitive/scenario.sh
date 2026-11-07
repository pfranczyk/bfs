# shellcheck shell=bash
# An entry the push gate adds to .bfsignore must not exclude a file that differs
# from it only in letter case, on a filesystem that tells the two apart.
#
# Push refuses a symlink it cannot back up and, in the REPL, offers to add it to
# .bfsignore and retry. The symlink `Readme` becomes the pattern `/Readme`. Git
# matches .gitignore case-sensitively on a case-sensitive filesystem, so
# `/Readme` leaves a regular file `README` alone; a matcher that compares without
# case drops `README` from the backup, and the retried push still reports
# success - every later backup is then silently short of that file.
#
# Proof: the push runs in the REPL on a real terminal (run_bfs_pty) and accepts
# the offer; the working tree is wiped and restored, and the SHA-256 tree must
# match the one taken after the push - README included.
#
# Runs only where the filesystem is case-sensitive (Linux): on Windows and macOS
# `Readme` and `README` are one name, and there git ignores case too, so the
# scenario self-skips (returns PASS).

SCENARIO_NAME="push gate: a .bfsignore entry does not exclude a file differing only in case"
SCENARIO_DESC="symlink Readme next to file README on a case-sensitive filesystem; push on a terminal adds it to .bfsignore; restore brings README back byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs138"

  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      echo "  (skip) symlinks need admin rights and Windows ignores case by default"
      return 0
      ;;
  esac

  make_fixtures "$vault"
  printf 'probe\n' >"$SC_DIR/caseprobe"
  if [ -e "$SC_DIR/CASEPROBE" ]; then
    echo "  (skip) the filesystem ignores letter case"
    return 0
  fi
  printf 'read me first\n' >"$vault/README"
  ln -s hello.txt "$vault/Readme" 2>/dev/null || true
  if [ ! -L "$vault/Readme" ]; then
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

  # Taken after the push, so the appended .bfsignore is part of the baseline;
  # find -type f skips the symlink, which is rightly not in the backup.
  snapshot_hashes "$vault" "$base"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_file "$vault/README"
  assert_restored "$vault" "$base"
  return 0
}
