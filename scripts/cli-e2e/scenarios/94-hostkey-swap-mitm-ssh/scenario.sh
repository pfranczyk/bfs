# shellcheck shell=bash
# H1 — host-key swap (MITM) on the SAME address. The sshd holding shard_2 is
# added with --accept-new-host-key and no --known-host (the realistic
# first-contact path build_pool_seq uses). That opt-in must realize true TOFU:
# capture the key on first contact and PIN it, then verify every later connection
# against the pin. Here the original box is destroyed and a brand-new EMPTY sshd
# (a fresh, different host key) is stood up on the SAME port — a textbook
# impostor. A routine `bfs push` must then REFUSE the changed key and never
# upload shard_2 (nor send the password) to the impostor.
#
# Under the H1 bug --accept-new-host-key trusts whatever key is presented on
# EVERY connection, so the impostor is trusted and shard_2 is uploaded to it
# (credential + data leak) — this scenario is RED until the pin is captured.
#
# local/ftp: N/A — host-key trust is SSH-specific.
# Docker-managed: self-provisions its sshd (no --ssh needed). SKIPs without Docker.

SCENARIO_NAME="host-key swap (MITM): pinned key must refuse an impostor on the same address"
SCENARIO_DESC="sshd pinned via --accept-new-host-key; replace with a NEW empty sshd (fresh host key) on the SAME port; a routine push must refuse it, not upload shard_2 to the impostor"
REQUIRES_LOCAL=2
REQUIRES_SSH=0
REQUIRES_DOCKER=1

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs94"
  local ctr_a="bfs-e2e-${RUN_ID}-c94a" vol_a="bfs-e2e-${RUN_ID}-v94a"
  local ctr_b="bfs-e2e-${RUN_ID}-c94b" vol_b="bfs-e2e-${RUN_ID}-v94b"
  local port=2331

  # Genuine sshd on $port (host key K1 in vol_a). build_pool_seq adds it with
  # --accept-new-host-key and no --known-host — the exact H1 first-contact path.
  docker_volume_reset "$vol_a"
  docker_sshd_up "$ctr_a" "$port" "$vol_a" || _fail "could not start original sshd on port $port"
  register_ssh_endpoint 127.0.0.1 "$port" bfsuser bfspass /config
  local se="$REG_SSH_INDEX"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local ssh   # p2 = the managed sshd

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # ── An impostor replaces the box at the SAME address: original destroyed
  #    (container AND volume), a brand-new sshd with a FRESH host key (K2) comes
  #    up on the SAME port with the same credentials. A competent impostor offers
  #    writable storage, so its base directory is provisioned — the whole point is
  #    to capture whatever the client sends: if BFS trusts K2 it will happily
  #    upload the shard here.
  docker_sshd_down "$ctr_a"
  docker_volume_rm "$vol_a"
  docker_volume_reset "$vol_b"
  docker_sshd_up "$ctr_b" "$port" "$vol_b" || _fail "could not start impostor sshd on port $port"
  ssh_mkdir "$se" "${PV_SSH_REMOTE[2]}"

  # A routine new push. The operator changed nothing; the address is the same.
  # First contact pinned K1, so the presented K2 MUST be refused before any
  # credential or byte leaves: shard_2 is never uploaded → the impostor holds
  # nothing. Under the H1 bug --accept-new-host-key trusts K2 every time, so the
  # shard lands on the impostor (credential + data leak).
  run_bfs "$vault" push --new

  local impostorshard="${PV_SSH_REMOTE[2]}/${name}/shard_2.bfs.2"
  if [ -n "$(ssh_sha "$se" "$impostorshard")" ]; then
    _fail "shard_2 was uploaded to the impostor (credential/data leak): host-key change not refused"
  fi

  docker_sshd_down "$ctr_b"
  docker_volume_rm "$vol_b"
  return 0
}
