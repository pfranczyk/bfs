# shellcheck shell=bash
# All-SSH backup: every N+K provider is a distinct SFTP sub-path on one SSH
# endpoint. Proves the full create → restore → disaster-recovery cycle over a
# real sshd, with an 8 MB binary file verified byte-for-byte (SHA-256) so a
# truncated or reordered SFTP transfer cannot pass silently.

SCENARIO_NAME="all-SSH 3/1 + 8 MB integrity + recovery"
SCENARIO_DESC="4 SFTP providers; push, restore, lose .bfs/, recover from SSH bootstrap"
REQUIRES_LOCAL=0
REQUIRES_SSH=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs80"
  make_fixtures "$vault"
  make_large_file "$vault/big.bin" 8388608
  build_pool_seq "$SC_DIR" "$name" ssh ssh ssh ssh   # all 4 providers on SFTP

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Plain restore over SFTP: wipe the working files (keep .bfs/) and pull. Proves
  # the 8 MB binary round-trips through SFTP byte-for-byte, independent of the
  # recovery path below.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  assert_no_file "$vault/big.bin"
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Disaster: local metadata gone; only the SSH providers remain.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Rebuild .bfs/ by bootstrapping from SSH provider p0. Unattended (CI)
  # recovery: --trust-locations pre-approves the recovered hosts so the per-host
  # credential confirmation does not block a non-interactive run.
  run_bfs "$vault" recovery --provider ssh --name "$name" \
    --bootstrap "$(ssh_bootstrap_spec 0)" --trust-locations
  assert_ok
  assert_file "$vault/.bfs/config.json"
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
