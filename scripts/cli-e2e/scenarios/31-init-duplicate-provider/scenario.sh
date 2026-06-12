# shellcheck shell=bash
# init must REJECT two providers sharing the same id (name) instead of silently
# writing a duplicate. A duplicate id would land twice in .bfs/config.json, and
# every lookup-by-id resolves to the first match — orphaning the rest and
# desyncing the N+K scheme. Correct behaviour: abort exit!=0, no config.json,
# message names the colliding id.

SCENARIO_NAME="init rejects duplicate provider id"
SCENARIO_DESC="two --provider with same id abort init; unique ids still pass"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs31"
  make_fixtures "$vault"

  # Three real on-disk media paths (2/1 scheme needs 3 providers). We build the
  # --provider args by hand instead of build_pool so we control the ids: TWO of
  # them deliberately collide on id "dup".
  local dirA="$SC_DIR/prov/a" dirB="$SC_DIR/prov/b" dirC="$SC_DIR/prov/c"
  mkdir -p "$dirA" "$dirB" "$dirC"

  # ── 1. Duplicate id "dup" on two providers → init must abort ──────────────
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 \
    --provider "local:dup --path $(winpath "$dirA")" \
    --provider "local:dup --path $(winpath "$dirB")" \
    --provider "local:ok --path $(winpath "$dirC")"
  assert_fail
  # Config must NOT have been written — the duplicate is caught before persist.
  assert_no_file "$vault/.bfs/config.json"
  # The error must name the colliding id so the user knows which to rename.
  assert_out_contains "dup"

  # ── 2. Contrast: the same 3 media with UNIQUE ids → init succeeds ──────────
  # Documents that we block only the duplicate, not a well-formed init.
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 \
    --provider "local:m0 --path $(winpath "$dirA")" \
    --provider "local:m1 --path $(winpath "$dirB")" \
    --provider "local:m2 --path $(winpath "$dirC")"
  assert_ok
  assert_file "$vault/.bfs/config.json"
}
