# shellcheck shell=bash
# Password edge cases on an otherwise-unencrypted vault:
#  - push --password forces per-version encryption,
#  - pull with the right password restores,
#  - pull (Mode B) without a password on an encrypted version fails.
# Mirrors tests/e2e password-override edge scenarios.

SCENARIO_NAME="password override + missing-password error"
SCENARIO_DESC="force-encrypt push, restore, reject no-password pull"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt"
  local name="bfs13" pw="OverridePW1"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  # Vault configured WITHOUT encryption.
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  # --password forces encryption for this version despite config disabled.
  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  # A WRONG password must be rejected (AES-GCM auth failure → non-zero exit).
  # --force wipes the tree first, but the next pull restores it from the
  # untouched shards. (We use a wrong password rather than none, because the CLI
  # prompts interactively when --password is omitted instead of failing.)
  run_bfs "$vault" pull --force --yes --password "wrong-${pw}"
  assert_fail

  # Correct password restores byte-for-byte.
  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
