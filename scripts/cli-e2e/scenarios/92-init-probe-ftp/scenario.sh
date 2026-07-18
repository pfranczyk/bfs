# shellcheck shell=bash
# `bfs init --ci` provisions each FTP provider's base directory itself (via
# probeConnection), so a medium whose base path does not exist yet is CREATED at
# init — an unusable target surfaces here, not at the first push. Guards the
# decisions.md "init probes every medium (creates the dir) even in --ci" contract
# end-to-end over a real FTP server: the unit init-ci-probe.test.ts proves it with
# a fake provider; this proves the real FtpProvider.probeConnection actually
# ensureDir's a missing base. The early-failure side (a genuinely unusable target)
# is covered by the interactive wrong-path scenarios (41/42).

SCENARIO_NAME="init --ci provisions a non-existent FTP base dir"
SCENARIO_DESC="2L+1F; delete the auto-prepared FTP base, init --ci must create it, then roundtrip"
REQUIRES_LOCAL=2
REQUIRES_FTP=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs92"
  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = FTP

  # The harness auto-creates every FTP provider's base dir before init (ftp_prepare_pool).
  # Undo that so p2's base genuinely does NOT exist when init runs.
  ftp_clean_run "$RUN_ID"

  # init --ci must provision the missing base itself. The legacy "list the base,
  # fail if absent" behaviour would abort here; probeConnection creates it instead.
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  # The provisioned FTP target is fully usable end-to-end.
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local e="${PV_FTP_ENDPOINT[2]}"
  local sdir="${PV_FTP_REMOTE[2]}/${name}"
  [ -n "$(ftp_sha "$e" "${sdir}/shard_2.bfs.1")" ] || _fail "shard_2 missing on FTP after push to the init-provisioned base"

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
