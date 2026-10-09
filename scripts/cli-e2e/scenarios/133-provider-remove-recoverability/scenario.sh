# shellcheck shell=bash
# `bfs provider remove --strategy remove` drops a storage from the
# configuration without touching its bytes. What it can take away is checked
# against each version's own scheme, not against the pool count: a 4/1 version
# kept on a pool later rescaled to 3/1 loses its fourth part to the second
# removal while the pool still looks healthy. Sibling of 133b, which guards
# the pool itself - kept apart so either refusal shows red on its own.
#
# The removal is refused unless the operator adds `--force`; `--yes` confirms
# only the removal itself. A forced removal marks the version damaged for this
# configuration, and the part stays on the storage it was on.
#
# Binding assertions: the refusal names the version and `--force`, and leaves
# the configuration and the manifest untouched; `--force` removes the storage,
# records the version as damaged and leaves its part on the medium. Control:
# a removal that leaves every version its N parts goes through without force,
# and a version written on the smaller pool restores byte-for-byte.

SCENARIO_NAME="provider remove: a removal that takes a version below its N needs --force"
SCENARIO_DESC="5L 4/1; remove, rescale 3/1, remove again -> refused naming v1, --force -> damaged, part kept, v2 restores"
REQUIRES_LOCAL=5
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs133" b2="$SC_DIR/v2.txt"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 5 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 4 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # -- Control: v1 keeps exactly its N=4 parts, so no force is needed -----------
  run_bfs "$vault" provider remove p0 --strategy remove --yes
  assert_ok
  assert_manifest_health "$vault" 1 degraded

  # The pool is rescaled to the four storages left, and a version written on it
  # lives on p1..p4 as 3/1.
  run_bfs "$vault" scheme set 3 1
  assert_ok
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$b2"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 2 healthy

  # -- A second removal takes v1 below its N=4 -----------------------------------
  local config_before
  config_before="$(cat "$vault/.bfs/config.json")"
  run_bfs "$vault" provider remove p1 --strategy remove --yes
  assert_fail
  assert_out_contains '--force'
  assert_out_matches '[Vv]ersions? 1\b'
  # v2 keeps its N=3 parts on the three storages left, so it is not named.
  if printf '%s' "$BFS_OUT" | grep -qiE 'versions? [0-9, ]*\b2\b'; then
    _fail "refusal named v2, which keeps its N parts
$BFS_OUT"
  fi
  [ "$(cat "$vault/.bfs/config.json")" = "$config_before" ] ||
    _fail "a refused removal changed config.json"
  assert_manifest_health "$vault" 1 degraded

  # -- --force removes it; v1 is damaged here, its part stays on the medium ------
  run_bfs "$vault" provider remove p1 --strategy remove --yes --force
  assert_ok
  if grep -q '"id": "p1"' "$vault/.bfs/config.json"; then
    _fail "p1 still in config.json after a forced removal"
  fi
  assert_manifest_health "$vault" 1 damaged
  assert_file "$(shard_file 1 1)"

  # v2 still restores byte-for-byte from the storages left once the scheme
  # matches them: the forced removal cost v1, nothing else.
  run_bfs "$vault" scheme set 2 1
  assert_ok
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --version 2 --force --yes
  assert_ok
  assert_restored "$vault" "$b2"

  return 0
}
