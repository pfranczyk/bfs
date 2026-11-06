# shellcheck shell=bash
# Interactive `bfs provider edit <local>` refuses a path that runs through a FILE
# the same way on every platform, and tells the operator which file is in the way.
#
# A path under a file can never become a directory, so it is a typo - the edit
# re-asks it instead of offering it for confirmation the way it offers a medium
# that is merely not mounted yet (103). The platforms report it differently:
# Linux answers ENOTDIR, Windows answers ENOENT - the very code that means "not
# there yet". Deciding on the code alone therefore offers the Windows operator a
# path no directory can ever appear at, while telling the Linux operator the
# directory "does not exist", which reads as an instruction to create it.
#
# Failure injected for real: a regular file sits where a directory of the typed
# path would have to be - nothing is faked.
#
# Load-bearing control: p2's shards are moved to the second, real path, and
# shard 0 (on the first provider) is removed before the restore, so the SHA-256
# roundtrip has to read through the path the edit stored.
#
# ftp/ssh: N/A - the path check belongs to the local adapter alone.

SCENARIO_NAME="edit local: a path running through a file is re-asked, naming the file"
SCENARIO_DESC="three local providers; interactive provider edit p2 is first given <file>/sub, then a real directory holding p2's data -> no save-anyway prompt, warning names the file, real path stored, restore via p2 roundtrips"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs136"
  local cfg="$vault/.bfs/config.json"

  # Reads a field of provider p2's connection config from config.json.
  p2_cfg_field() {
    node -e 'const fs=require("node:fs");const c=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));const p=c.providers.find(x=>x.id==="p2");process.stdout.write(String(p&&p.config[process.argv[2]]!==undefined?p.config[process.argv[2]]:""));' \
      "$cfg" "$1"
  }

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local local

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- A file standing where a directory of the typed path would have to be ----
  local blocker="$SC_DIR/prov/not-a-dir.txt"
  printf 'x' > "$blocker"
  [ -f "$blocker" ] || _fail "could not create the blocking file"

  # -- p2's medium moves to a real directory: the second answer ----------------
  local new_path="$SC_DIR/prov/p2-moved"
  mv "${PV_LOCALDIR[2]}" "$new_path"
  [ -d "$new_path/$name" ] || _fail "could not move p2's data to the new path"

  # The same prompt twice. Its label is redrawn in the echo of every keystroke
  # of the first answer, so the second answer waits for the label AFTER the
  # warning - that is the re-asked prompt, already started. Typed any earlier,
  # it reaches a prompt that does not exist yet and is dropped (Windows does).
  # There is no answer for "Save this path anyway?": a flow that asks it, or
  # never prints the warning, hangs - and the assertions below name what it
  # printed instead before the exit code reports 124.
  # winpath converts the blocker itself: cygpath refuses a path that runs
  # through a file, which is the whole point of the one typed here.
  # Two levels below the file, so the parent of the typed path is not the file
  # itself - a warning naming that parent must not pass for one naming the file.
  local blocker_shown typed below edit_answers
  blocker_shown="$(winpath "$blocker")"
  below="$blocker_shown/sub"
  typed="$below/deeper"
  edit_answers='[
    {"anchor":"Base directory path","value":"'"$typed"'"},
    {"after":"no directory can exist under it","anchor":"Base directory path","value":"'"$(winpath "$new_path")"'"}
  ]'
  PTY_TIMEOUT=25000 run_bfs_pty "$vault" "$edit_answers" --lang en provider edit p2

  if printf '%s' "$BFS_OUT" | grep -qF 'Save this path anyway?'; then
    _fail "a path running through a file was offered for confirmation instead of being re-asked"
  fi
  if printf '%s' "$BFS_OUT" | grep -qF 'does not exist'; then
    _fail "a path running through a file was reported as a directory that does not exist"
  fi
  # The prompt redraws its whole line on every keystroke, so the output holds
  # every partial echo of the typed path - `<file>`, `<file>/`, `<file>/s`... -
  # and each of them names the file. Every line carrying the prompt label is
  # dropped first; the warning is printed on a line of its own. What remains is
  # flattened, because a long warning may wrap on a terminal that ignores the
  # requested width, and every path running on past the file (`<file>/sub...`)
  # is cut out of it: a warning naming what was typed, or its parent, still
  # starts with the file's path. The warning may print either separator on
  # Windows, so both forms are cut and both are accepted.
  local out_flat blocker_native below_native
  blocker_native="${blocker_shown//\//\\}"
  below_native="${below//\//\\}"
  out_flat="$(printf '%s' "$BFS_OUT" | tr '\r' '\n' | grep -av 'Base directory path' | tr -d '\n')"
  out_flat="${out_flat//"$below"/}"
  out_flat="${out_flat//"$below_native"/}"
  if ! printf '%s' "$out_flat" | grep -qF -e "$blocker_shown" -e "$blocker_native"; then
    _fail "the warning does not name the file standing in the way: $blocker_shown"
  fi
  assert_exit 0

  local path_after
  path_after="$(p2_cfg_field path)"
  case "$path_after" in
    *p2-moved) ;;
    *) _fail "unexpected path stored after the edit: '$path_after'" ;;
  esac

  # -- Restore has to read through the stored path -----------------------------
  local shard0
  shard0="$(shard_file 0 1)"
  assert_file "$shard0"
  rm -f "$shard0"
  assert_no_file "$shard0"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --yes
  assert_ok
  assert_restored "$vault" "$base"

  return 0
}
