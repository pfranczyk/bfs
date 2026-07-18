# shellcheck shell=bash
# The FTP counterpart of 86: a REAL disk failure at the same location. The ftpd
# holding shard_2 is killed, its data volume WIPED, then restarted on the SAME
# port with an empty volume — the base directory the provider points at is GONE.
# `bfs repair --rebuild` must Reed-Solomon-reconstruct shard_2 and re-upload it.
#
# This is the exact case 86 exposes as broken on SSH (strict authenticate() =
# readdir throws on a missing base dir). Existing FTP repair scenarios (69) always
# ftp_mkdir the target base BEFORE repairing, so they never exercise a truly
# missing base — this one deliberately does, to answer "does FTP have the same
# bug, or does its lenient authenticate() + upload ensureDir handle it?".
#
# Docker-managed; SKIPs without a Docker daemon.

SCENARIO_NAME="repair --rebuild: FTP disk failure, same location"
SCENARIO_DESC="ftpd data volume wiped in place (base dir gone); repair --rebuild reconstructs shard_2"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs89"
  local ctr="bfs-e2e-${RUN_ID}-c89" vol="bfs-e2e-${RUN_ID}-v89"
  local port=2121 pmin=21100 pmax=21110

  docker_volume_reset "$vol"
  docker_ftpd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" || _fail "could not start ftpd on port $port"
  register_ftp_endpoint 127.0.0.1 "$port" bfsuser bfspass /ftp/bfsuser false
  local fe="$REG_FTP_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = the managed ftpd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local ftpshard="${PV_FTP_REMOTE[2]}/${name}/shard_2.bfs.1"
  [ -n "$(ftp_sha "$fe" "$ftpshard")" ] || _fail "shard_2 missing on the server after push"

  # ── Disk failure: same host:port, data GONE (volume wiped) ──────────────────
  docker_ftpd_down "$ctr"
  docker_volume_reset "$vol"
  docker_ftpd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" || _fail "could not restart ftpd after disk wipe"

  # The shard is gone from the server.
  if ftp_sha "$fe" "$ftpshard" >/dev/null 2>&1; then
    _fail "shard_2 unexpectedly still present after the disk wipe"
  fi
  run_bfs "$vault" verify
  assert_manifest_health "$vault" 1 degraded

  # Repair rebuilds shard_2 from parity and re-uploads it to the SAME location.
  local ftpjson="$SC_DIR/ftp-p2.json"
  printf '{"host":"127.0.0.1","port":%s,"user":"bfsuser","password":"bfspass","path":"%s","secure":false}\n' \
    "$port" "${PV_FTP_REMOTE[2]}" >"$ftpjson"
  run_bfs "$vault" repair --version all p2 "--config-file $(winpath "$ftpjson")" --rebuild
  assert_ok

  # Shard is back at the original location.
  [ -n "$(ftp_sha "$fe" "$ftpshard")" ] || _fail "shard_2 was not rebuilt at the original location"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
