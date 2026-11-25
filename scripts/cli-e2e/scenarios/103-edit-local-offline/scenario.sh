# shellcheck shell=bash
# Interactive `bfs provider edit <local>` honours the offline-edit guarantee: the
# drive is gone and the operator points the provider at where it will reappear -
# a directory that does not exist yet. The command writes nothing but
# `.bfs/config.json`, so a path that is currently absent must not be able to keep
# the edit from finishing.
#
# This is the local twin of 95-edit-ssh-offline and 102-edit-ftps-offline; the
# trio is the A/B control that the offline guarantee holds per medium, not just
# where it was first implemented.
#
# Failure injected for real: the provider's base directory is moved off its path
# (the drive is unplugged), so `fs.stat` genuinely fails - nothing is faked.
#
# Load-bearing control: after the edits the drive is "plugged in" at the stored
# path and shard 0 is removed, so the SHA-256 roundtrip has to read p2 through
# the path the edit stored.
#
# ftp/ssh: N/A here - their twins are 102 and 95. No Docker, no endpoints needed.

SCENARIO_NAME="edit local offline: pointing a provider at a not-yet-existing directory completes; back and cancel work"
SCENARIO_DESC="three local providers; p2's base directory is deleted; interactive provider edit: absent typo -> back -> absent real path -> save anyway -> exit 0 and the second path stored; then absent path -> cancel -> exit 1, config.json unchanged"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs103"
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

  local old_path new_path
  old_path="$(p2_cfg_field path)"
  [ -n "$old_path" ] || _fail "no path stored for p2 after init"

  # -- The drive is gone for real, and its replacement is not mounted yet ------
  local unplugged="$SC_DIR/unplugged-p2"
  mv "${PV_LOCALDIR[2]}" "$unplugged"
  [ ! -d "${PV_LOCALDIR[2]}" ] || _fail "could not unplug p2's base directory"
  new_path="$SC_DIR/prov/p2-remounted"
  [ ! -d "$new_path" ] || _fail "the replacement path must not exist yet for this scenario to mean anything"

  # -- Interactive edit: a typo first, back to the path, then the real path ----
  # The path prompt is the only field local asks for. An absent directory is put
  # to the operator as a menu (rawlist, answered by position): 1 save anyway,
  # 2 back to the path, 3 cancel the edit. The first answer is a typo that does
  # not exist either; "back" must bring the path prompt again rather than store
  # it. Every later answer waits for text printed after the one before it: the
  # labels are redrawn in the echo of each keystroke, and an answer typed before
  # its prompt starts is dropped.
  local typo_path="$SC_DIR/prov/p2-typo" edit_answers
  [ ! -d "$typo_path" ] || _fail "the typo path must not exist for the menu to be offered"
  edit_answers='[
    {"anchor":"Base directory path","value":"'"$(winpath "$typo_path")"'"},
    {"anchor":"Cancel the edit","value":"2"},
    {"anchor":"Base directory path","value":"'"$(winpath "$new_path")"'"},
    {"after":"p2-remounted","anchor":"Cancel the edit","value":"1"}
  ]'
  PTY_TIMEOUT=25000 run_bfs_pty "$vault" "$edit_answers" --lang en provider edit p2

  # The edit must COMPLETE - not spin on the prompt until the harness kills it.
  assert_exit 0

  local path_after
  path_after="$(p2_cfg_field path)"
  [ "$path_after" != "$old_path" ] || _fail "provider edit left the old path in place: '$old_path'"
  case "$path_after" in
    *p2-remounted) ;;
    *p2-typo) _fail "\"back\" stored the path it was meant to abandon: '$path_after'" ;;
    *) _fail "unexpected path stored after the edit: '$path_after'" ;;
  esac
  # The edit never touches the medium: a directory created at the mount point of
  # an unplugged drive would send the next push to the disk underneath.
  [ ! -d "$new_path" ] || _fail "provider edit created the directory it was only meant to store: $new_path"
  [ ! -d "$typo_path" ] || _fail "provider edit created the abandoned directory: $typo_path"

  # -- Cancelling ends the edit with exit 1 and leaves config.json untouched ---
  local cfg_sha_before cancel_answers
  cfg_sha_before="$(sha256sum "$cfg" | cut -d' ' -f1)"
  cancel_answers='[
    {"anchor":"Base directory path","value":"'"$(winpath "$SC_DIR/prov/p2-elsewhere")"'"},
    {"anchor":"Cancel the edit","value":"3"}
  ]'
  PTY_TIMEOUT=25000 run_bfs_pty "$vault" "$cancel_answers" --lang en provider edit p2

  # Exactly 1: a hang on the prompt also ends non-zero (PTY timeout = 124).
  assert_exit 1
  assert_out_contains "Edit cancelled - nothing was saved."
  [ "$(sha256sum "$cfg" | cut -d' ' -f1)" = "$cfg_sha_before" ] || _fail "a cancelled edit changed config.json"

  # -- The drive comes back at the stored path; restore has to read through it -
  mv "$unplugged" "$new_path"
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
