# shellcheck shell=bash
# The language flag is written two ways, `--lang <code>` and `--lang=<code>`,
# the same as `--cwd`. Both spellings must settle the interface language, store
# it, and be refused on the same terms when the value is unknown or empty. A
# spelling read by nobody is worse than a refusal: the run exits 0 in the old
# language, nothing is stored, and nothing on screen says the flag was dropped.
#
# Binding assertions: `--lang=pl status` confirms the change in Polish, speaks
# Polish and stores "pl"; `--lang=klingon` and `--lang=` exit 1 with the same
# refusals as the spaced spelling and leave the stored language alone; the
# spaced spelling still works (A/B control).

SCENARIO_NAME="--lang=<code>: the equals spelling sets, stores and refuses like --lang <code>"
SCENARIO_DESC="3L 2/1; --lang=pl switches and stores, --lang=klingon / --lang= refused with exit 1, settings untouched"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" name="bfs157"
  # A private settings directory, so switching the language here cannot leak
  # into scenarios that rely on the harness-wide English default.
  export XDG_CONFIG_HOME="$SC_DIR/.config"
  local settings="$XDG_CONFIG_HOME/bfs/settings.json"
  mkdir -p "$XDG_CONFIG_HOME/bfs"
  printf '{"language":"en"}' >"$settings"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  # -- A/B control, first so a red run shows it: the spaced spelling works -------
  run_bfs "$vault" --lang pl status
  assert_ok
  assert_out_contains "Język ustawiony na: pl"
  run_bfs "$vault" --lang en status
  assert_ok

  # -- the equals spelling switches and stores the language ---------------------
  run_bfs "$vault" --lang=pl status
  assert_ok
  assert_out_contains "Język ustawiony na: pl"
  assert_out_contains "Status kopii zapasowej"
  if ! grep -qE '"language": *"pl"' "$settings"; then
    _fail "--lang=pl must store the language, settings: $(cat "$settings")"
  fi

  # Back to English for the refusals, so their wording is the English one.
  run_bfs "$vault" --lang en status
  assert_ok

  # -- an unknown value is refused, not passed over ------------------------------
  run_bfs "$vault" --lang=klingon status
  assert_exit 1
  assert_out_contains 'Invalid --lang: "klingon"'
  if ! grep -qE '"language": *"en"' "$settings"; then
    _fail "a refused --lang=klingon must leave the stored language alone, settings: $(cat "$settings")"
  fi

  # -- an empty value is a missing one, worded as such --------------------------
  run_bfs "$vault" --lang= status
  assert_exit 1
  assert_out_contains "--lang needs a language code"
  if printf '%s' "$BFS_OUT" | grep -qF 'Invalid --lang'; then
    _fail "an empty --lang= must be worded as a missing value, not an invalid one: $BFS_OUT"
  fi
  if ! grep -qE '"language": *"en"' "$settings"; then
    _fail "a refused --lang= must leave the stored language alone, settings: $(cat "$settings")"
  fi
  return 0
}
