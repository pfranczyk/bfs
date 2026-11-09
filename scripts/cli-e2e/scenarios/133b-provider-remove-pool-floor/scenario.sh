# shellcheck shell=bash
# Below three storages no scheme is valid (N >= 2, K >= 1), so a removal that
# leaves two takes away the ability to make a backup from this configuration.
# `bfs provider remove --strategy remove` refuses that unless the operator adds
# `--force`; `--yes` confirms only the removal itself. Sibling of 133, which
# guards a version's own N.
#
# Binding assertions: the refusal names `--force` and leaves the configuration
# untouched; the forced removal goes through and leaves the part on the medium;
# the step it prints afterwards and the refusal of every command behind the
# scheme check name the state - a backup needs at least 3 storage providers -
# and `bfs provider add`, never `bfs scheme set`, because N + K = 2 is refused
# by that very command. The named command is executed: one storage added back
# takes the missing place, the 2/1 scheme stays, and v1 restores byte-for-byte
# with no `bfs scheme set` at all.

SCENARIO_NAME="provider remove: a removal that leaves fewer than three storages needs --force"
SCENARIO_DESC="3L 2/1; remove -> refused naming --force; --force -> removed, provider add named; storage added back -> scheme stays, v1 restores"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs133b" baseline="$SC_DIR/v1.txt"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$baseline"
  run_bfs "$vault" push --new
  assert_ok

  # -- Refused without --force ----------------------------------------------------
  local config_before
  config_before="$(cat "$vault/.bfs/config.json")"
  run_bfs "$vault" provider remove p0 --strategy remove --yes
  assert_fail
  assert_out_contains '--force'
  [ "$(cat "$vault/.bfs/config.json")" = "$config_before" ] ||
    _fail "a refused removal changed config.json"

  # -- Forced: removed, part kept, no scheme the two storages cannot carry -------
  run_bfs "$vault" provider remove p0 --strategy remove --yes --force
  assert_ok
  assert_out_contains 'Provider "p0" removed.'
  if grep -q '"id": "p0"' "$vault/.bfs/config.json"; then
    _fail "p0 still in config.json after a forced removal"
  fi
  assert_file "$(shard_file 0 1)"
  # v1 keeps its N=2 parts on the two storages left: degraded, not damaged.
  assert_manifest_health "$vault" 1 degraded
  local epilogue="${BFS_STDOUT#*Provider \"p0\" removed.}"
  if printf '%s' "$epilogue" | grep -qF -- 'bfs scheme set'; then
    _fail "the step after a removal below three storages names an impossible scheme
$epilogue"
  fi
  printf '%s' "$epilogue" | grep -qF -- 'bfs provider add' ||
    _fail "the step after a removal below three storages must name \`bfs provider add\`
$epilogue"
  printf '%s' "$epilogue" | grep -qF -- 'at least 3 storage providers' ||
    _fail "the step after a removal below three storages must say a backup needs at least 3 storage providers
$epilogue"

  # -- Every command behind the scheme check names the same state --------------
  # `bfs scheme set` cannot fit two storages, so the refusal must not offer it.
  run_bfs "$vault" pull --force --yes
  assert_fail
  assert_out_contains 'at least 3 storage providers'
  assert_out_contains 'bfs provider add'
  if printf '%s' "$BFS_OUT" | grep -qF -- 'bfs scheme set'; then
    _fail "pull below three storages advises a scheme the storages cannot carry
$BFS_OUT"
  fi

  # -- The named command, executed: a storage added back makes it whole --------
  # The third storage takes the missing place and the 2/1 scheme stays, so v1
  # comes back byte-for-byte from its two remaining parts with no scheme change.
  local spare="$SC_DIR/prov/spare"
  mkdir -p "$spare"
  run_bfs "$vault" provider add --ci --name spare --type local --path "$(winpath "$spare")"
  assert_ok
  grep -q '"parity_shards": 1' "$vault/.bfs/config.json" ||
    _fail "a storage filling a missing place must keep the 2/1 scheme
$(grep -E '"(data|parity)_shards"' "$vault/.bfs/config.json")"
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --version 1 --force --yes
  assert_ok
  assert_restored "$vault" "$baseline"

  return 0
}
