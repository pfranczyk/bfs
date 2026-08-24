# shellcheck shell=bash
# `provider add` must REFUSE a new provider whose location already holds a
# DIFFERENT backup (foreign vault_id) - otherwise the next push would silently
# overwrite it. Vault A owns "docs" on media A; a separate vault B of the same
# name then tries to add a provider pointing at A's media. Correct: abort
# exit!=0, B's config unchanged (the intruder provider is not persisted).

SCENARIO_NAME="provider add aborts on foreign backup at target location"
SCENARIO_DESC="adding a provider onto another backup's location must abort, not persist a colliding provider"
REQUIRES_LOCAL=6
REQUIRES_FTP=0

scenario_run() {
  local name="docs" wsA="$SC_DIR/A" wsB="$SC_DIR/B"
  mkdir -p "$wsA" "$wsB"
  make_fixtures "$wsA"

  local a0="$SC_DIR/mA/0" a1="$SC_DIR/mA/1" a2="$SC_DIR/mA/2"
  local b0="$SC_DIR/mB/0" b1="$SC_DIR/mB/1" b2="$SC_DIR/mB/2"
  mkdir -p "$a0" "$a1" "$a2" "$b0" "$b1" "$b2"

  # -- Vault A: init + push "docs" to media A --------------------------------
  run_bfs "$wsA" init "$name" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 \
    --provider "local:a0 --path $(winpath "$a0")" \
    --provider "local:a1 --path $(winpath "$a1")" \
    --provider "local:a2 --path $(winpath "$a2")"
  assert_ok
  run_bfs "$wsA" push --new
  assert_ok
  assert_file "$a0/$name/shard_0.bfs.1"

  # -- Vault B: a separate backup of the SAME name on its own media ----------
  run_bfs "$wsB" init "$name" --ci --no-enc --no-compress --data-shards 2 --parity-shards 1 \
    --provider "local:b0 --path $(winpath "$b0")" \
    --provider "local:b1 --path $(winpath "$b1")" \
    --provider "local:b2 --path $(winpath "$b2")"
  assert_ok

  # -- provider add on B, targeting A's media -> foreign vault at that location -
  run_bfs "$wsB" provider add --ci --name intruder --type local --path "$(winpath "$a0")"
  assert_fail
  # The intruder provider must NOT have been persisted into B's config.
  if grep -q "intruder" "$wsB/.bfs/config.json"; then
    _fail "provider 'intruder' was added to B's config despite the collision"
  fi
}
