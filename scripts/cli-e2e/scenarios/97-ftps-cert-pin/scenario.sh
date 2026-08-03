# shellcheck shell=bash
# FTPS certificate pinning — the FTP-over-TLS analog of 94's SSH host-key MITM.
# A vsftpd server speaks explicit AUTH TLS with a SELF-SIGNED certificate. BFS
# cannot trust a self-signed cert by default (Node rejects it), so the operator
# PINS it: `bfs init … --secure true --cert-fingerprint <sha256>`. BFS must then
#   (a) accept exactly that certificate — full push + pull + SHA-256 roundtrip;
#   (b) REFUSE a different certificate (an impostor/MITM on the SAME address),
#       never uploading a shard nor the password to it.
#
# RED until FTPS cert pinning exists. Today `--cert-fingerprint` is an unknown
# flag the FTP adapter silently ignores, and a secure connection to a self-signed
# cert is rejected outright — so `bfs init`'s probeConnection() fails and the
# scenario cannot even create the backup (the first assert_ok trips). Once pinning
# lands, the pinned cert is trusted (roundtrip passes) and the swapped cert is
# refused (shard never reaches the impostor).
#
# local: N/A — TLS certificate trust is FTPS-specific.
# Docker-managed: self-provisions its ftpd (no --ftp needed). SKIPs without Docker.

SCENARIO_NAME="FTPS cert pin: accept the pinned self-signed cert, refuse an impostor"
SCENARIO_DESC="init FTPS provider pinned to a self-signed cert's SHA-256; push/pull SHA-256 roundtrip; then swap the server cert (MITM, same address) — a routine push must refuse the changed cert and never upload shard_2"
REQUIRES_LOCAL=2
REQUIRES_FTP=0
REQUIRES_DOCKER=1

scenario_run() {
  command -v openssl >/dev/null 2>&1 || _fail "openssl is required to generate the FTPS test certificate"

  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs97"
  local ctr="bfs-e2e-${RUN_ID}-c97" vol="bfs-e2e-${RUN_ID}-v97"
  local port=2160 pmin=21230 pmax=21240
  local certA="$SC_DIR/certA.pem" keyA="$SC_DIR/keyA.pem"
  local certB="$SC_DIR/certB.pem" keyB="$SC_DIR/keyB.pem"

  # ── Genuine FTPS server presenting self-signed cert A ───────────────────────
  gen_selfsigned_cert "$certA" "$keyA" bfs-ftps-A || _fail "could not generate cert A"
  local fpA; fpA="$(ftps_cert_fingerprint "$certA")"
  [ -n "$fpA" ] || _fail "could not read cert A fingerprint"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$certA" "$keyA" \
    || _fail "could not start FTPS server on port $port"

  # Register the endpoint as secure WITH the pin (7th arg). build_pool_seq then
  # emits `--secure true --cert-fingerprint <fpA>` for the FTPS provider (p2).
  register_ftp_endpoint 127.0.0.1 "$port" bfsuser bfspass /ftp/bfsuser true "$fpA"
  local fe="$REG_FTP_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ftp   # p2 = the FTPS server

  # (a) init pins cert A; probeConnection() must trust exactly that certificate.
  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local shardA="${PV_FTP_REMOTE[2]}/${name}/shard_2.bfs.1"
  [ -n "$(ftp_sha "$fe" "$shardA")" ] || _fail "shard_2 missing on the FTPS server after push"

  # Restore from the pinned server; SHA-256 byte-for-byte proves the trusted cert
  # carried real data end to end.
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # ── (b) MITM: an impostor replaces the box at the SAME address with a FRESH,
  #    DIFFERENT self-signed cert B. The pin still names cert A, so a routine push
  #    must refuse cert B before any credential or byte leaves — shard_2 of the new
  #    version must never land on the impostor. A competent impostor offers
  #    writable storage (base dir provisioned) precisely to capture what leaks.
  gen_selfsigned_cert "$certB" "$keyB" bfs-ftps-B || _fail "could not generate cert B"
  local fpB; fpB="$(ftps_cert_fingerprint "$certB")"
  [ "$fpB" != "$fpA" ] || _fail "cert B fingerprint unexpectedly equals cert A"
  docker_ftpd_down "$ctr"
  docker_volume_reset "$vol"
  docker_ftpsd_up "$ctr" "$port" "$pmin" "$pmax" "$vol" "$certB" "$keyB" \
    || _fail "could not start impostor FTPS server on port $port"
  ftp_mkdir "$fe" "${PV_FTP_REMOTE[2]}"

  run_bfs "$vault" push --new
  local impostorshard="${PV_FTP_REMOTE[2]}/${name}/shard_2.bfs.2"
  if [ -n "$(ftp_sha "$fe" "$impostorshard")" ]; then
    _fail "shard_2 was uploaded to the impostor (credential/data leak): FTPS cert change not refused"
  fi

  docker_ftpd_down "$ctr"
  docker_volume_rm "$vol"
  return 0
}
