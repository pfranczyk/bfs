# shellcheck shell=bash
# Interactive recovery: a stripped vault recovered by bootstrapping from a
# LOCAL provider (which carries no transport secret), so the FTP providers'
# password is NOT in the seed pool and `bfs recovery` must prompt the operator
# for it via inquirer (askSecret). Driven through a real pseudo-terminal
# (run_bfs_pty / @lydell/node-pty) — the only way to answer a genuine inquirer
# prompt rendered by real `bfs`, which `run_bfs`'s </dev/null path cannot.
#
# Closes the e2e gap left by K2 (Issue 8): credentials are stripped from shard
# headers, so recovery on a mixed local+FTP vault asks for the FTP password.
# Each FTP sibling first confirms its destination host, then (for the first one)
# prompts for the password; the second sibling confirms its host but reuses the
# pooled secret. Guards that all prompts fire (PROMPTS_FED=3/3) and the restore
# is byte-for-byte correct after the operator supplies the secret.

SCENARIO_NAME="interactive recovery prompt (local bootstrap → FTP password)"
SCENARIO_DESC="stripped vault, recovery prompts for FTP secret via PTY, restore"
REQUIRES_LOCAL=1
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs28"
  make_fixtures "$vault"
  # p0 local (bootstrap, no secret), p1/p2 FTP (secret stripped from headers).
  build_pool "$SC_DIR" 1 2 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok

  # Catastrophe: local metadata gone. Only the providers remain; the FTP
  # shard headers no longer carry the password (K2 strip).
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Bootstrap from the LOCAL provider p0 → its config has no secret, so the seed
  # pool is empty and recovery must reconnect each FTP sibling interactively.
  # connectForRecovery() confirms the destination host BEFORE asking for the
  # password: confirm host (y) → FTP password. The typed password is pooled, so
  # the second FTP sibling still confirms its host but reuses the pooled secret
  # without a second password prompt. Hence the prompt sequence for two FTP
  # siblings is: confirm, password, confirm.
  local answers
  answers='[{"anchor":"Send it to this host","value":"y"},{"anchor":"FTP password for","value":"'"${FTP_PASS[0]}"'"},{"anchor":"Send it to this host","value":"y"}]'
  run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")"
  assert_ok
  # All three prompts (confirm, password, confirm) must have rendered and been
  # answered — not bypassed.
  assert_out_contains "PROMPTS_FED=3/3"
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  # Recovery wrote the supplied password back into config.json, so a follow-up
  # pull needs no prompt and restores byte-for-byte.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
