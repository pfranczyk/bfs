# shellcheck shell=bash
# Pull with a missing EXTERNAL adapter and --allow-missing-adapters must skip the
# unreachable provider and Reed-Solomon-decode from the providers that remain.
# Mirrors the real situation: a third-party adapter was installed at push time and
# uninstalled before pull. The vault is pushed across 3 local providers, then
# config.json is mutated so one provider declares an unregistered external type
# (ghost-ssh + adapterPackage). Its shard file stays on disk untouched.
#
# CHANGELOG [0.5.0] promises --allow-missing-adapters lets RS decoding proceed with
# whichever providers remain reachable. Bug: providerRegistry.create() on the
# unregistered type ran outside the download try/catch, so pull crashed with
# "Unknown provider type" instead of skipping and restoring from N=2.

SCENARIO_NAME="pull with missing external adapter"
SCENARIO_DESC="--allow-missing-adapters skips unregistered provider, RS-restores from N"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs30"
  local cfg="$vault/.bfs/config.json"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new
  assert_ok

  # Mutate config AFTER a successful push: the last provider becomes an
  # unregistered external type. Its shard file is left intact on disk; only
  # the config classifies it as external-missing. node -e is used for a
  # cross-platform JSON edit (Git Bash on Windows, Linux/Ubuntu on CI).
  node -e '
    const fs = require("fs");
    const p = process.argv[1];
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    const last = c.providers[c.providers.length - 1];
    last.type = "ghost-ssh";
    last.adapterPackage = "bfs-adapter-ghost@1.0.0";
    fs.writeFileSync(p, JSON.stringify(c, null, 2));
  ' "$cfg"

  # Without the flag the preflight rejects cleanly (this path already works).
  run_bfs "$vault" pull --force --yes
  assert_fail
  assert_out_matches 'ghost-ssh|bfs-adapter-ghost|allow-missing-adapters'

  # With the flag: must skip the missing provider, RS-decode from the 2 local
  # providers that remain, exit 0 and restore the tree byte-for-byte.
  run_bfs "$vault" pull --force --yes --allow-missing-adapters
  if printf '%s' "$BFS_OUT" | grep -qF 'Unknown provider type'; then
    _fail "pull crashed with 'Unknown provider type' instead of skipping the missing adapter"
  fi
  assert_ok
  assert_restored "$vault" "$base"
}
