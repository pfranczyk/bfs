# shellcheck shell=bash
# Partial push (one provider's upload fails) leaves push.lock and the cached
# pending blob in place as forensic state. The emergency RAM→disk dump in
# vault-manager.ts kicks in on the first upload failure, so even tiny
# fixtures that pack via the RAM path end up with push.blob.pending on disk
# — `bfs push --cache --overwrite` then heals the degraded version without
# re-packing.

SCENARIO_NAME="partial push leaves forensic state, --cache resumes"
SCENARIO_DESC="one provider fails → degraded + push.lock kept → push --cache → healthy"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs17"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  # Baseline AFTER init so .bfsignore round-trips into the assertion (see 01).
  snapshot_hashes "$vault" "$base"

  # Break provider p2 between init and push: replace its base directory with
  # a regular file. local-fs upload() does fs.mkdir({recursive:true}) on
  # {basePath}/{vaultName}, which fails with ENOTDIR when basePath itself is
  # a file. The other three uploads succeed → 3 of 4 → degraded.
  local broken="${PV_LOCALDIR[2]}"
  rm -rf "$broken"
  : >"$broken"

  # Partial push exits 1 (CommandAbort on degraded). Manifest is written,
  # surviving shards land on disk, and the emergency cache dump preserves
  # push.blob.pending even though packing went RAM-path (small fixture).
  run_bfs "$vault" push --new
  assert_exit 1
  assert_out_contains "degraded"
  assert_manifest_health "$vault" 1 degraded
  assert_lock_exists "$vault"
  assert_file "$vault/.bfs/cache/push.blob.pending"
  assert_file "$(shard_file 0 1)"
  assert_file "$(shard_file 1 1)"
  assert_file "$(shard_file 3 1)"

  # Fix the provider: drop the placeholder file, recreate its base dir.
  rm -f "$broken"
  mkdir -p "$broken"

  # Resume from cache as overwrite of the degraded v1: re-uploads every shard
  # from the cached blob, no re-pack. On full success the manifest flips to
  # healthy and forensic state is wiped.
  run_bfs "$vault" push --cache --overwrite
  assert_ok
  assert_out_contains "healthy"
  assert_manifest_health "$vault" 1 healthy
  assert_lock_absent "$vault"
  assert_no_file "$vault/.bfs/cache/push.blob.pending"
  assert_file "$(shard_file 2 1)"

  # End-to-end: pull from the freshly healed version, SHA matches baseline.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
