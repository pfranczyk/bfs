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
# Failure injected for real: the provider's base directory is removed from disk,
# so `fs.stat` genuinely fails - nothing is faked.
#
# ftp/ssh: N/A here - their twins are 102 and 95. No Docker, no endpoints needed.

SCENARIO_NAME="edit local offline: pointing a provider at a not-yet-existing directory completes"
SCENARIO_DESC="three local providers; p2's base directory is deleted; interactive provider edit points p2 at a path that does not exist -> exit 0 and the new path is stored"
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
  rm -rf "${PV_LOCALDIR[2]}"
  [ ! -d "${PV_LOCALDIR[2]}" ] || _fail "could not remove p2's base directory"
  new_path="$SC_DIR/prov/p2-remounted"
  [ ! -d "$new_path" ] || _fail "the replacement path must not exist yet for this scenario to mean anything"

  # -- Interactive edit pointing p2 at the absent replacement path -------------
  # The path prompt is the only field local asks for. The trailing confirm covers
  # a flow that asks the operator to stand behind a path it cannot see; a flow
  # that simply accepts it leaves that answer unused.
  local edit_answers
  edit_answers='[
    {"anchor":"Base directory path","value":"'"$(winpath "$new_path")"'"},
    {"anchor":"Save this path anyway?","value":"y"}
  ]'
  PTY_TIMEOUT=25000 run_bfs_pty "$vault" "$edit_answers" --lang en provider edit p2

  # The edit must COMPLETE - not spin on the prompt until the harness kills it.
  assert_exit 0

  local path_after
  path_after="$(p2_cfg_field path)"
  [ "$path_after" != "$old_path" ] || _fail "provider edit left the old path in place: '$old_path'"
  case "$path_after" in
    *p2-remounted) ;;
    *) _fail "unexpected path stored after the edit: '$path_after'" ;;
  esac

  return 0
}
