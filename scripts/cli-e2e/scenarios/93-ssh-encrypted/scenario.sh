# shellcheck shell=bash
# Encrypted, compressed all-SSH backup (3/1): AES-256-GCM per-shard payloads and
# a ZIP-compressed blob pushed over real SFTP, then restored and disaster-
# recovered. Closes the SSH encrypt/compress gap:
# 80-ssh-all runs --no-enc --no-compress, so nothing else proves that an
# encrypted + compressed blob survives an SFTP roundtrip, nor that recovery can
# decrypt the location map read back from an encrypted SSH shard header. A 4 MB
# binary is checked byte-for-byte (SHA-256) so a truncated SFTP transfer or a
# broken decrypt cannot pass silently.

SCENARIO_NAME="all-SSH 3/1 encrypted + compressed + recovery"
SCENARIO_DESC="encrypted/compressed push over SFTP, restore, lose .bfs/, recover + decode from SSH"
REQUIRES_LOCAL=0
REQUIRES_SSH=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs93" encpw="ssh-enc-secret-93"
  make_fixtures "$vault"
  make_large_file "$vault/big.bin" 4194304
  build_pool_seq "$SC_DIR" "$name" ssh ssh ssh ssh   # all 4 providers on SFTP

  # Encrypted + default compression - the real-user default for a remote backup.
  run_bfs "$vault" init "$name" --ci --enc \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"

  run_bfs "$vault" push --new --password "$encpw"
  assert_ok
  assert_manifest_contains "$vault" 1 '"encrypted": true'
  assert_manifest_health "$vault" 1 healthy

  # Medium-side proof: every N+K shard physically landed on its SSH endpoint.
  # A manifest that reads healthy is not proof the bytes reached the server -
  # only reading them back off SFTP is.
  local i
  for ((i = 0; i < PV_COUNT; i++)); do
    [ -n "$(ssh_sha "${PV_SSH_ENDPOINT[$i]}" "${PV_SSH_REMOTE[$i]}/${name}/shard_${i}.bfs.1")" ] \
      || _fail "shard_${i}.bfs.1 missing on its SSH endpoint after push"
  done

  # Plain restore over SFTP: wipe the working files (keep .bfs/) and pull with the
  # password. Proves the encrypted + compressed 4 MB binary round-trips byte-for-
  # byte, independent of the recovery path below.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/big.bin"
  run_bfs "$vault" pull --force --yes --password "$encpw"
  assert_ok
  assert_restored "$vault" "$base"

  # Disaster: local metadata gone; only the encrypted SSH shards remain.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Recovery connects to SSH p0, reads its shard header, and must DECRYPT the
  # location map to discover the siblings. This is an unattended run: --ci says
  # no question may be asked, so everything it needs comes from the command line
  # - the encryption password, the SSH transport secret inside the bootstrap
  # spec (with --accept-new-host-key authorizing the key it meets), and
  # --trust-locations for the recovered hosts.
  #
  # Driven through a PTY on purpose: a terminal is the only place where "does not
  # ask" and "cannot ask" tell apart. The empty answer list plus the assertion
  # below pin that nothing is asked even with an operator present.
  PTY_TIMEOUT=60000 run_bfs_pty "$vault" '[]' --lang en --ci recovery --provider ssh --name "$name" \
    --password "$encpw" --bootstrap "$(ssh_bootstrap_spec 0)" --trust-locations
  assert_ok
  assert_out_contains 'PROMPTS_FED=0/0'
  if printf '%s' "$BFS_OUT" | grep -qE 'Enter password for version|Trust the host key'; then
    _fail "an unattended recovery asked a question:
$BFS_OUT"
  fi
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --force --yes --password "$encpw"
  assert_ok
  assert_restored "$vault" "$base"
}
