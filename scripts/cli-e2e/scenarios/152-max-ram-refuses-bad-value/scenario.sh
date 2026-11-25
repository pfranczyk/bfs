# shellcheck shell=bash
# `--max-ram <mb>` is one setting typed in three places: `init --ci` records
# it, `bfs config` changes the recorded value, `push` overrides it for one run.
# It takes a whole number of MiB above zero. Anything else - text, a number
# with trailing text, a negative number, zero - is refused with exit 1 before
# anything is written or uploaded. A value accepted silently would surface only
# later: text would be stored as auto, and zero would be taken by push as a
# zero budget.
#
# Binding assertions: each bad value exits 1 with the refusal naming it;
# `bfs config` leaves config.json byte-identical; `push` adds no version;
# `init --ci` leaves no .bfs/ behind; a valid value is still stored; the
# restore matches the snapshot byte-for-byte.

SCENARIO_NAME="--max-ram: init / config / push refuse anything but a whole number above zero"
SCENARIO_DESC="3L 2/1; bad --max-ram in init --ci, config and push each exits 1 and writes nothing; 512 is stored"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" fresh="$SC_DIR/fresh" base="$SC_DIR/baseline.txt" name="bfs152"
  local cfg="$vault/.bfs/config.json" cfgcopy="$SC_DIR/config-before.json"
  local value

  make_fixtures "$vault"
  make_fixtures "$fresh"
  build_pool "$SC_DIR" 3 0 "$name"

  # -- init --ci refuses before it records anything ----------------------------
  for value in abc 512abc -5 0; do
    run_bfs "$fresh" init "$name" --ci --no-enc --no-compress \
      --data-shards 2 --parity-shards 1 --max-ram "$value" "${PROVIDER_ARGS[@]}"
    assert_exit 1
    assert_out_contains "--max-ram must be an integer >= 1 (MB), got \"$value\"."
    if [ -e "$fresh/.bfs" ]; then
      _fail "init --ci --max-ram $value was refused, so it must leave no .bfs/ behind"
    fi
  done

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_state "$vault" latest_version 1

  # -- config and push refuse without writing or uploading ---------------------
  cp "$cfg" "$cfgcopy"
  for value in abc 512abc -5 0; do
    run_bfs "$vault" config --max-ram "$value"
    assert_exit 1
    assert_out_contains "--max-ram must be an integer >= 1 (MB), got \"$value\"."
    if ! cmp -s "$cfg" "$cfgcopy"; then
      _fail "config --max-ram $value was refused, so config.json must stay untouched:
$(cat "$cfg")"
    fi

    run_bfs "$vault" push --new --max-ram "$value"
    assert_exit 1
    assert_out_contains "--max-ram must be an integer >= 1 (MB), got \"$value\"."
    assert_state "$vault" latest_version 1
  done

  # -- A valid value is still stored and used ----------------------------------
  run_bfs "$vault" config --max-ram 512
  assert_ok
  assert_out_matches 'max-ram:[[:space:]]+512 MB'
  if ! grep -q '"max_ram_mb": 512' "$cfg"; then
    _fail "config --max-ram 512 must reach config.json:
$(cat "$cfg")"
  fi
  run_bfs "$vault" push --new --max-ram 256
  assert_ok
  assert_state "$vault" latest_version 2

  # -- The backup is intact ------------------------------------------------------
  snapshot_hashes "$vault" "$base"
  mutate_fixtures "$vault"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
