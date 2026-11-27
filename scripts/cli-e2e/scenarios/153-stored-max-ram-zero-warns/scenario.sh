# shellcheck shell=bash
# Released versions stored `--max-ram` with parseInt alone, and their help
# offered "0 = auto" - so a backup set up with them can carry `max_ram_mb: 0`
# (or a negative number) in config.json, which the input checks refuse.
# Push keeps taking such a value as the zero budget it is - it packs through
# disk - and leaves config.json alone: the operator may want exactly that. What
# it must not do is take it silently, and `bfs config` must not list it like
# any other setting.
#
# Binding assertions: with 0 and with -5 stored, push exits 0 with a warning
# naming the stored value and adds a version recorded with the 16 MiB floor
# stripe of a zero budget; `bfs config` marks the value;
# config.json is byte-identical after push and after listing; a push overriding
# the value with `--max-ram` does not warn; the restore matches the snapshot
# byte-for-byte.

SCENARIO_NAME="stored max_ram_mb 0 / negative: push warns and backs up, config marks it, nothing rewritten"
SCENARIO_DESC="3L 2/1; max_ram_mb 0 and -5 seeded into config.json; push warns and succeeds, config marks, file untouched"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs153"
  local cfg="$vault/.bfs/config.json" seeded="$SC_DIR/config-seeded.json"
  local stored version=0

  make_fixtures "$vault"
  # Over two smallest stripes at 2/1, so the stripe recorded in the manifest
  # tells a zero budget (the 16 MiB floor) from a budget covering the part.
  make_large_file "$vault" $((40 * 1024 * 1024))
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  for stored in 0 -5; do
    # The shape released versions wrote: the key sits in config.json as a bare
    # number, the way `bfs config --max-ram 0` stored it.
    node -e '
      const fs = require("node:fs");
      const [file, value] = process.argv.slice(1);
      const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
      cfg.max_ram_mb = Number(value);
      fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
    ' "$(winpath "$cfg")" "$stored"
    cp "$cfg" "$seeded"

    run_bfs "$vault" push --new
    assert_ok
    version=$((version + 1))
    assert_state "$vault" latest_version "$version"
    # The stored value is still the budget - not auto.
    assert_manifest_contains "$vault" "$version" "\"rs_stripe_size\": 16777216"
    if ! cmp -s "$cfg" "$seeded"; then
      _fail "push with stored max_ram_mb $stored must leave config.json untouched:
$(cat "$cfg")"
    fi
    assert_out_contains "Saved RAM limit ($stored MB) is not a whole number above zero - this push runs with a zero RAM budget."

    run_bfs "$vault" config
    assert_ok
    assert_out_contains "max-ram:   $stored MB (not a whole number above zero - push runs with a zero RAM budget)"
    if ! cmp -s "$cfg" "$seeded"; then
      _fail "listing settings with stored max_ram_mb $stored must leave config.json untouched:
$(cat "$cfg")"
    fi
  done

  # The tree of the last version pushed with the stored zero budget.
  snapshot_hashes "$vault" "$base"

  # -- An override for this push leaves the stored value out of play -----------
  mutate_fixtures "$vault"
  run_bfs "$vault" push --new --max-ram 256
  assert_ok
  version=$((version + 1))
  assert_state "$vault" latest_version "$version"
  # A/B for the stripe check above: the same data under a budget that covers it
  # leaves the floor, so 16 MiB there came from the budget, not from the data.
  assert_manifest_absent "$vault" "$version" "\"rs_stripe_size\": 16777216"
  if printf '%s' "$BFS_OUT" | grep -qF 'Saved RAM limit'; then
    _fail "push --max-ram 256 does not use the stored value, so it must not warn about it:
$BFS_OUT"
  fi

  # -- The backup made with the stored zero budget is intact -------------------
  wipe_working_tree "$vault"
  run_bfs "$vault" pull --version 2 --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
