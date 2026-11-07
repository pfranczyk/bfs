# shellcheck shell=bash
# A push-gate refusal must not leave a .bfsignore line behind that drops a
# regular file from later backups.
#
# A script with CRLF line endings creates names ending in a carriage return,
# e.g. a symlink `notes<CR>`. Push refuses the symlink and, in the REPL, offers
# to add it to .bfsignore and retry. A literal carriage return could only sit
# inside a bracket, where any editor or line-ending conversion that treats it as
# a line break splits the pattern, so the gate refuses the name instead.
# If it appends the line first, `ignore` reads `/notes<CR>` back as `/notes`:
# the symlink stays unmatched, the gate stops - and the line stays in the file.
# Once the operator removes the symlink and keeps a regular file `notes`, that
# line drops the file from every backup while push reports success.
#
# Proof: the gate is accepted in the REPL on a real terminal (run_bfs_pty) and
# refuses; the symlink is replaced by a regular file `notes` and pushed by a
# standalone `bfs push`; the working tree is wiped and restored, and the SHA-256
# tree must match the one taken after that push - `notes` included.
#
# POSIX-only: a symlink needs admin rights on Windows and NTFS forbids control
# characters in a name, so the scenario self-skips (returns PASS) there.

SCENARIO_NAME="push gate: refusing a name with a carriage return leaves no .bfsignore line behind"
SCENARIO_DESC="symlink 'notes<CR>' refused by the push gate; later a regular file notes is pushed; restore brings notes back byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs140"
  local cr_name
  cr_name="notes"$'\r'

  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      echo "  (skip) control characters in names and symlinks are unavailable on Windows"
      return 0
      ;;
  esac

  make_fixtures "$vault"
  ln -s hello.txt "$vault/$cr_name" 2>/dev/null || true
  if [ ! -L "$vault/$cr_name" ]; then
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
  assert_state "$vault" latest_version 0

  # The operator gets rid of the symlink and keeps a regular file of that name
  # without the carriage return. Nothing is left for the gate, so a standalone
  # push runs.
  rm -f "$vault/$cr_name"
  printf 'rows\n' >"$vault/notes"
  run_bfs "$vault" push --yes
  assert_ok

  snapshot_hashes "$vault" "$base"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_file "$vault/notes"
  assert_restored "$vault" "$base"
  return 0
}
