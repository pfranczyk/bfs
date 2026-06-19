# shellcheck shell=bash
# Interactive recovery, multiple sequential prompts via PTY: an ENCRYPTED
# stripped vault recovered by bootstrapping from a LOCAL provider. Recovery must:
#   1. prompt for the ENCRYPTION password (to decrypt the location map in the
#      bootstrap shard header), then
#   2. for each FTP sibling, confirm the destination host and (for the first)
#      prompt for the FTP transport password (stripped from headers by K2); the
#      second sibling confirms its host but reuses the pooled password.
# All answered through a real pseudo-terminal. Proves multi-prompt works end to
# end through real `bfs` — exactly the case a piped stdin cannot drive (inquirer
# feeds only the first prompt per process under a pipe).

SCENARIO_NAME="interactive recovery, 2 prompts (encryption + FTP password)"
SCENARIO_DESC="encrypted stripped vault, recovery prompts twice via PTY, restore"
REQUIRES_LOCAL=1
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs29"
  local encpw="enc-secret-29"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 1 2 "$name"

  # Encrypted vault (default encryption ON; no --no-enc). Password is set on the
  # first push.
  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new --password "$encpw"
  assert_ok

  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # No --password flag → recovery prompts for the encryption password first (to
  # decrypt the location map), then reconnects each FTP sibling: confirm host (y)
  # → FTP password for the first sibling, then confirm host (y) for the second
  # sibling (its password is reused from the pool, so no second password prompt).
  # Answers are fed in that order as each prompt's anchor appears.
  local answers
  answers='[{"anchor":"Enter password for version","value":"'"$encpw"'"},{"anchor":"Send it to this host","value":"y"},{"anchor":"FTP password for","value":"'"${FTP_PASS[0]}"'"},{"anchor":"Send it to this host","value":"y"}]'
  run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  assert_out_contains "PROMPTS_FED=4/4"
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  # Vault is encrypted, so pull still needs the encryption password (recovery
  # persists transport creds, never the encryption password).
  run_bfs "$vault" pull --force --yes --password "$encpw"
  assert_ok
  assert_restored "$vault" "$base"
}
