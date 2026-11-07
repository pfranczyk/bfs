# shellcheck shell=bash
# An entry the push gate adds to .bfsignore for a name ending in a space must
# exclude that name only - not the same name without the space.
#
# Push refuses a symlink it cannot back up and, in the REPL, offers to add it to
# .bfsignore and retry. Git trims trailing spaces from a .gitignore line unless
# they are escaped (`/notes\ `) or bracketed (`/notes[ ]`), so the symlink
# `notes ` needs one of those. Written as `/notes `, the line reads as
# `/notes`: the symlink is not matched, and the line stays in .bfsignore. Once
# the operator removes the
# symlink and creates a regular file `notes`, that line drops the file from every
# backup while push reports success.
#
# Proof: the gate is accepted in the REPL on a real terminal (run_bfs_pty); the
# symlink is then replaced by a regular file `notes` and pushed by a standalone
# `bfs push`; the working tree is wiped and restored, and the SHA-256 tree must
# match the one taken after that push - `notes` included - and the gate push
# itself must have produced a healthy version of its own.
#
# POSIX-only: NTFS forbids a trailing space in a name and a symlink needs admin
# rights on Windows, so the scenario self-skips (returns PASS) there.

SCENARIO_NAME="push gate: a .bfsignore entry for a name with a trailing space excludes only that name"
SCENARIO_DESC="symlink 'notes ' accepted in the push gate; later a regular file notes is pushed; restore brings notes back byte-for-byte"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs139"

  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      echo "  (skip) names with a trailing space and symlinks are unavailable on Windows"
      return 0
      ;;
  esac

  make_fixtures "$vault"
  ln -s hello.txt "$vault/notes " 2>/dev/null || true
  if [ ! -L "$vault/notes " ]; then
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

  # The operator gets rid of the symlink and keeps a regular file of that name
  # without the space. Nothing is left for the gate, so a standalone push runs.
  rm -f "$vault/notes "
  printf 'rows\n' >"$vault/notes"
  run_bfs "$vault" push --yes
  assert_ok

  # Taken after the push, so the appended .bfsignore is part of the baseline.
  snapshot_hashes "$vault" "$base"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_file "$vault/notes"
  assert_restored "$vault" "$base"

  # The gate push and the standalone push each make a version; a gate that
  # refuses the entry again leaves only the standalone one.
  assert_manifest_health "$vault" 1 healthy
  assert_state "$vault" latest_version 2
  return 0
}
