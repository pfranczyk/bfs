# shellcheck shell=bash
# Cross-type migration of one shard through THREE provider types — local → FTP →
# SSH — reusing the SAME shard bytes each hop (no --rebuild). Exercises the
# architecture claim that the built-in providers (local/ftp/ssh) share ONE
# canonical on-medium layout ({base}/{vault}/shard_i.bfs.V + hdr_i.bfs.V), so raw
# bytes are portable between them and `bfs repair` only has to repoint config +
# manifests + sibling location maps. Proves the migrated bytes are byte-for-byte
# the original push AND that restore keeps working after each hop.

SCENARIO_NAME="repair: cross-type migration local→FTP→SSH (same bytes)"
SCENARIO_DESC="3L 2/1; pre-place shard bytes on FTP then SSH, repair (no rebuild) each hop, restore + prove bytes unchanged"
REQUIRES_LOCAL=3
REQUIRES_FTP=1
REQUIRES_SSH=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs84"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local local   # p2 is the shard we migrate

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Canonical bytes of shard_2 as pushed to the local provider.
  local shard
  shard="$(shard_file 2 1)"
  assert_file "$shard"
  local before
  before="$(sha256sum "$shard" | cut -d' ' -f1)"

  # ── Hop 1: local → FTP, same bytes (no --rebuild) ──────────────────────────
  local fe=0
  local f9remote="${FTP_BASE[$fe]%/}/bfs-e2e-${RUN_ID}/f9-${name}"
  ftp_mkdir "$fe" "$f9remote"
  ftp_put "$fe" "$(winpath "$shard")" "${f9remote}/${name}/shard_2.bfs.1"
  local ftpjson="$SC_DIR/ftp-f9.json"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s","secure":%s}\n' \
    "${FTP_HOST[$fe]}" "${FTP_PORT[$fe]}" "${FTP_USER[$fe]}" "${FTP_PASS[$fe]}" \
    "$f9remote" "${FTP_SECURE[$fe]}" >"$ftpjson"

  run_bfs "$vault" repair --version all p2 "ftp:f9 --config-file $(winpath "$ftpjson")"
  assert_ok
  assert_manifest_contains "$vault" 1 '"provider_id": "f9"'
  assert_manifest_contains "$vault" 1 '"provider_type": "ftp"'
  assert_manifest_absent "$vault" 1 '"provider_id": "p2"'
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # ── Hop 2: FTP → SSH, same bytes (no --rebuild) ────────────────────────────
  local se=0
  local s9remote="${SSH_BASE[$se]%/}/bfs-e2e-${RUN_ID}/s9-${name}"
  ssh_mkdir "$se" "$s9remote"
  ssh_put "$se" "$(winpath "$shard")" "${s9remote}/${name}/shard_2.bfs.1"
  local sshjson="$SC_DIR/ssh-s9.json"
  printf '{"host":"%s","port":%s,"user":"%s","password":"%s","path":"%s"}\n' \
    "${SSH_HOST[$se]}" "${SSH_PORT[$se]}" "${SSH_USER[$se]}" "${SSH_PASS[$se]}" \
    "$s9remote" >"$sshjson"

  # --ci so the new-host TOFU (--accept-new-host-key) is honoured non-interactively.
  run_bfs "$vault" repair --ci --version all f9 "ssh:s9 --config-file $(winpath "$sshjson") --accept-new-host-key"
  assert_ok
  assert_manifest_contains "$vault" 1 '"provider_id": "s9"'
  assert_manifest_contains "$vault" 1 '"provider_type": "ssh"'
  assert_manifest_absent "$vault" 1 '"provider_id": "f9"'
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # The shard now living on SSH is byte-for-byte the one pushed to local — the
  # canonical layout carried the raw bytes across all three provider types. (The
  # no-rebuild guarantee itself is enforced by BFS: commitMigrationPairs verifies
  # the shard identity at the destination before committing the manifest swap.)
  local after
  after="$(ssh_sha "$se" "${s9remote}/${name}/shard_2.bfs.1")"
  [ "$after" = "$before" ] || _fail "cross-type migrated shard bytes differ from original: $before -> $after"

  # Force the migrated shard into the reconstruction path: shard_2 (now on SSH as
  # s9) is the PARITY shard, so with both local data shards present a pull never
  # needs it. Drop a local DATA shard (shard_0) — now pull MUST download the
  # migrated parity from SSH and RS-rebuild the missing data. Proves the migrated
  # shard is not just present and byte-identical, but functionally usable.
  rm "$(shard_file 0 1)"
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
