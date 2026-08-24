# shellcheck shell=bash
# Docker-managed SSH endpoints for scenarios that must exercise REAL server
# lifecycle deterministically (address change, disk failure, server replacement)
# - including on CI. Data lives in a NAMED VOLUME, not a bind mount, so
# persistence across container restarts behaves identically on Linux (CI) and
# Windows/Git Bash (no host-path translation). A scenario:
#   - starts an sshd on a port backed by a volume (docker_sshd_up),
#   - pushes a backup onto it,
#   - then restarts it on a NEW port with the SAME volume (address change), or
#     recreates the volume EMPTY (disk failure), or starts a NEW empty container
#     (server replacement),
#   - and repairs / restores.
# Containers and volumes are named with $RUN_ID so env_cleanup can drop them all,
# and are never anything a real user owns.
#
# Every container starts with --restart=always, matching the policy the CI jobs
# use for their own servers (.github/workflows/e2e.yml). Without it a server that
# dies on its own takes the scenario down with it - delfer/alpine-ftp-server exits
# when its vsftpd goes away - and the run reports an unreachable medium, which
# reads as a BFS defect when BFS behaved correctly. The policy does not blunt any
# failure the scenarios inject: they all take a server down with docker rm -f
# (docker_sshd_down / docker_ftpd_down), which removes the container outright and
# is unaffected by a restart policy. Nothing here uses `docker stop`, which is the
# one form --restart=always would fight.

DOCKER_SSH_IMAGE="linuxserver/openssh-server"
DOCKER_SSH_USER="bfsuser"
DOCKER_SSH_PASS="bfspass"
DOCKER_SSH_BASE="/config"

DOCKER_FTP_IMAGE="delfer/alpine-ftp-server"
DOCKER_FTP_USER="bfsuser"
DOCKER_FTP_PASS="bfspass"
DOCKER_FTP_BASE="/ftp/bfsuser"

# Container command for the FTP image: run vsftpd in the FOREGROUND rather than
# letting the image supervise it. The image's start script backgrounds vsftpd,
# then guesses its pid with `pgrep vsftpd | tail -n 1` and hands that guess to
# pidproxy - the container's only foreground process, which quits the moment the
# pid it watches disappears. The guess lands on a short-lived startup process
# often enough to matter (~12% of starts, reproducible with no client connected
# at all): pidproxy then watches an already-dead pid, prints "process has died,
# quitting", and takes the container down, which reads as a medium that vanished.
# The death does not have to look like a startup failure: pidproxy polls, so the
# container can serve several sessions before it notices. Running vsftpd in the
# foreground removes the pid file and pidproxy from the picture, so the container
# lives exactly as long as the server does.
#
# The -o flags MUST come AFTER the config path: vsftpd applies arguments in
# order and /etc/vsftpd/vsftpd.conf sets background=YES, so a leading
# -obackground=NO is overridden, vsftpd daemonizes, the foreground process ends
# and the container restart-loops. The ${VAR:-...}/${VAR:+...} forms mirror the
# image's own defaults, so a caller that sets no MIN_PORT/MAX_PORT/ADDRESS/TLS_*
# gets the same server it gets today.
DOCKER_FTP_FG_CMD='exec vsftpd /etc/vsftpd/vsftpd.conf -obackground=NO -opasv_min_port=${MIN_PORT:-21000} -opasv_max_port=${MAX_PORT:-21010} ${ADDRESS:+-opasv_address=$ADDRESS} ${TLS_CERT:+-orsa_cert_file=$TLS_CERT -orsa_private_key_file=$TLS_KEY -ossl_enable=YES -oallow_anon_ssl=NO -oforce_local_data_ssl=YES -oforce_local_logins_ssl=YES -ossl_tlsv1=NO -ossl_sslv2=NO -ossl_sslv3=NO -ossl_ciphers=HIGH}'

# docker_available - returns 0 when the Docker daemon is usable.
docker_available() { docker info >/dev/null 2>&1; }

# _docker_ssh_wait <host-port> - block until an authenticated SSH handshake to
# 127.0.0.1:<port> succeeds (sshd binds the port before the user exists, so a
# bare TCP connect is not enough). Returns non-zero on timeout.
_docker_ssh_wait() {
  local port="$1"
  DE_USER="$DOCKER_SSH_USER" DE_PASS="$DOCKER_SSH_PASS" node -e '
    const {Client}=require("ssh2");const port=Number(process.argv[1]);const deadline=Date.now()+45000;
    function tryit(){const c=new Client();let done=false;
      c.on("ready",()=>{done=true;c.end();process.exit(0)});
      c.on("error",()=>{c.end();if(done)return;if(Date.now()>deadline){process.exit(1)}setTimeout(tryit,1000)});
      c.connect({host:"127.0.0.1",port,username:process.env.DE_USER,password:process.env.DE_PASS,readyTimeout:4000,hostVerifier:()=>true});}
    tryit();' "$port"
}

# docker_sshd_up <container> <host-port> <volume> - (re)start an sshd on host-port
# backed by the named volume, then wait until it accepts an authenticated
# connection. Removes any prior container of the same name first.
docker_sshd_up() {
  local ctr="$1" port="$2" vol="$3"
  docker rm -f "$ctr" >/dev/null 2>&1
  docker run -d --name "$ctr" --restart=always -p "${port}:2222" \
    -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true \
    -e "USER_NAME=${DOCKER_SSH_USER}" -e "USER_PASSWORD=${DOCKER_SSH_PASS}" -e SUDO_ACCESS=false \
    -v "${vol}:/config" "$DOCKER_SSH_IMAGE" >/dev/null 2>&1 || return 1
  _docker_ssh_wait "$port"
}

# docker_sshd_down <container> - stop and remove the container (idempotent).
docker_sshd_down() { docker rm -f "$1" >/dev/null 2>&1 || true; }

# docker_ssh_endpoints <count> <run-id> - start <count> throwaway sshd containers
# and print one `--ssh` spec per line.
#
# Scenarios that only need a working SSH server (as opposed to the docker-managed
# ones, which drive its lifecycle themselves) are gated on external endpoints. On
# a machine with Docker but no SSH server of its own that gate is unpassable,
# even though everything needed to satisfy it is right here - so run.sh can
# provision the endpoints from the same image instead. Containers are named with
# the run id, which is what docker_cleanup_run collects afterwards.
#
# Ports start at 2300 to stay clear of 2222 (scripts/ssh-test-server.ts) and of
# the docker-managed scenarios, which allocate their own.
docker_ssh_endpoints() {
  local count="$1" run="$2" i port ctr
  for i in $(seq 1 "$count"); do
    port=$((2300 + i))
    ctr="bfs-e2e-${run}-ssh${i}"
    docker_sshd_up "$ctr" "$port" "bfs-e2e-${run}-sshvol${i}" || return 1
    printf 'ssh://%s:%s@127.0.0.1:%s%s\n' "$DOCKER_SSH_USER" "$DOCKER_SSH_PASS" "$port" "$DOCKER_SSH_BASE"
  done
}

# _docker_ftp_wait <ctrl-port> - block until the ftpd genuinely accepts an
# authenticated login AND a passive data transfer, not merely a TCP connect.
# A bare TCP connect to a docker-published port is useless as a readiness signal:
# the host port is bound by docker's port-forwarder the moment `docker run` sets
# up the mapping - before the container's vsftpd has created its user or started
# serving - so it answers in ~2ms while login/PASV are not yet ready, and a
# scenario that pushes immediately after races a not-ready server (intermittent
# `degraded`). LIST runs over a PASV data connection, so a completed login+LIST
# proves both the control-channel auth and the passive data channel are up. This
# mirrors _docker_ssh_wait's full-handshake readiness. Returns non-zero on timeout.
_docker_ftp_wait() {
  local port="$1"
  DFW_USER="$DOCKER_FTP_USER" DFW_PASS="$DOCKER_FTP_PASS" node -e '
    const {Client}=require("basic-ftp");const port=Number(process.argv[1]);const deadline=Date.now()+45000;
    (async()=>{while(Date.now()<deadline){const c=new Client(4000);
      try{await c.access({host:"127.0.0.1",port,user:process.env.DFW_USER,password:process.env.DFW_PASS,secure:false});await c.list();c.close();process.exit(0)}
      catch(e){c.close();await new Promise((r)=>setTimeout(r,500))}}
      process.exit(1)})();' "$port"
}

# docker_ftpd_up <container> <ctrl-port> <pasv-min> <pasv-max> <volume> - (re)start
# a passive-mode FTP server on ctrl-port (data volume at /ftp/bfsuser), advertising
# 127.0.0.1 for PASV, then wait until an authenticated login and a passive LIST
# succeed.
docker_ftpd_up() {
  local ctr="$1" port="$2" pmin="$3" pmax="$4" vol="$5"
  docker rm -f "$ctr" >/dev/null 2>&1
  docker run -d --name "$ctr" --restart=always -p "${port}:21" -p "${pmin}-${pmax}:${pmin}-${pmax}" \
    -e "USERS=${DOCKER_FTP_USER}|${DOCKER_FTP_PASS}" -e ADDRESS=127.0.0.1 \
    -e "MIN_PORT=${pmin}" -e "MAX_PORT=${pmax}" \
    -v "${vol}:/ftp/${DOCKER_FTP_USER}" "$DOCKER_FTP_IMAGE" \
    sh -c "$DOCKER_FTP_FG_CMD" >/dev/null 2>&1 || return 1
  _docker_ftp_wait "$port"
}

# docker_ftpd_down <container> - stop and remove the container (idempotent).
docker_ftpd_down() { docker rm -f "$1" >/dev/null 2>&1 || true; }

# gen_selfsigned_cert <cert-out> <key-out> [cn] - generate a throwaway self-signed
# RSA cert/key pair (host openssl) so a docker FTPS server can present a cert whose
# SHA-256 fingerprint a scenario pins. cert-out and key-out MUST live in the same
# directory: the command runs from that directory with relative filenames, so
# native (mingw) openssl never has to resolve an MSYS /tmp path, and
# MSYS_NO_PATHCONV only shields the "/CN=" subject from Git Bash path rewriting.
# Returns non-zero when openssl is unavailable.
gen_selfsigned_cert() {
  local cert="$1" key="$2" cn="${3:-bfs-ftps-test}"
  command -v openssl >/dev/null 2>&1 || return 1
  local dir; dir="$(dirname "$cert")"
  (
    cd "$dir" || exit 1
    MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
      -keyout "$(basename "$key")" -out "$(basename "$cert")" \
      -days 3650 -subj "/CN=${cn}" >/dev/null 2>&1
  )
}

# ftps_cert_fingerprint <cert-file> - print the certificate's SHA-256 fingerprint
# in the uppercase colon-separated form (AA:BB:...) that Node's TLS
# peerCert.fingerprint256 reports, so a `--cert-fingerprint` pin matches exactly
# what BFS observes on the wire.
ftps_cert_fingerprint() {
  openssl x509 -in "$1" -noout -fingerprint -sha256 2>/dev/null | sed 's/^.*Fingerprint=//'
}

# _docker_ftps_wait <ctrl-port> - like _docker_ftp_wait, but over explicit AUTH
# TLS with a lenient (self-signed) certificate check. A vsftpd forcing SSL rejects
# a plaintext login, so the readiness probe MUST speak FTPS or it would time out.
_docker_ftps_wait() {
  local port="$1"
  DFW_USER="$DOCKER_FTP_USER" DFW_PASS="$DOCKER_FTP_PASS" node -e '
    const {Client}=require("basic-ftp");const port=Number(process.argv[1]);const deadline=Date.now()+45000;
    (async()=>{while(Date.now()<deadline){const c=new Client(4000);
      try{await c.access({host:"127.0.0.1",port,user:process.env.DFW_USER,password:process.env.DFW_PASS,secure:true,secureOptions:{rejectUnauthorized:false}});await c.list();c.close();process.exit(0)}
      catch(e){c.close();await new Promise((r)=>setTimeout(r,500))}}
      process.exit(1)})();' "$port"
}

# docker_ftpsd_up <container> <ctrl-port> <pasv-min> <pasv-max> <volume> <cert> <key>
# - (re)start a passive-mode FTPS server (explicit AUTH TLS, delfer's TLS_CERT/
# TLS_KEY env => ssl_enable + force_local_{data,logins}_ssl) on ctrl-port. The
# cert/key host files are copied into the container before it starts (docker cp:
# winpath source so the native docker binary reads a Windows path on Git Bash).
# MSYS_NO_PATHCONV is load-bearing on Git Bash for two arguments: the
# container-side /cert.pem target of docker cp, and -e TLS_CERT=/cert.pem, which
# is otherwise rewritten to C:/Program Files/Git/cert.pem and leaves the server
# without a certificate. Waits until an authenticated FTPS login + passive LIST
# succeeds.
docker_ftpsd_up() {
  local ctr="$1" port="$2" pmin="$3" pmax="$4" vol="$5" cert="$6" key="$7"
  docker rm -f "$ctr" >/dev/null 2>&1
  MSYS_NO_PATHCONV=1 docker create --name "$ctr" --restart=always -p "${port}:21" -p "${pmin}-${pmax}:${pmin}-${pmax}" \
    -e "USERS=${DOCKER_FTP_USER}|${DOCKER_FTP_PASS}" -e ADDRESS=127.0.0.1 \
    -e "MIN_PORT=${pmin}" -e "MAX_PORT=${pmax}" \
    -e TLS_CERT=/cert.pem -e TLS_KEY=/key.pem \
    -v "${vol}:/ftp/${DOCKER_FTP_USER}" "$DOCKER_FTP_IMAGE" \
    sh -c "$DOCKER_FTP_FG_CMD" >/dev/null 2>&1 || return 1
  MSYS_NO_PATHCONV=1 docker cp "$(winpath "$cert")" "${ctr}:/cert.pem" >/dev/null 2>&1 || return 1
  MSYS_NO_PATHCONV=1 docker cp "$(winpath "$key")" "${ctr}:/key.pem" >/dev/null 2>&1 || return 1
  docker start "$ctr" >/dev/null 2>&1 || return 1
  _docker_ftps_wait "$port"
}

# docker_volume_reset <volume> - drop and recreate the volume EMPTY (simulates a
# failed disk: the data is gone, the mount point is back).
docker_volume_reset() {
  docker volume rm "$1" >/dev/null 2>&1
  docker volume create "$1" >/dev/null 2>&1
}

# docker_volume_rm <volume> - remove the volume (idempotent).
docker_volume_rm() { docker volume rm "$1" >/dev/null 2>&1 || true; }

# docker_dump_run <run-id> - print the state and the log tail of every container
# this run created. A docker-managed scenario drives a real server, so when it
# fails the server's own account is the only evidence that separates "the medium
# went away" from "BFS mishandled it" - the CLI output alone cannot. A failing
# scenario exits its subshell before its own docker_*_down, so the containers are
# still there to be questioned. Safe with no daemon (no-op).
docker_dump_run() {
  local run="$1" names name
  docker_available || return 0
  names="$(docker ps -a --filter "name=bfs-e2e-${run}" --format '{{.Names}}' 2>/dev/null)"
  if [ -z "$names" ]; then
    echo "[docker] no containers left for run ${run}"
    return 0
  fi
  echo "[docker] container state for run ${run}:"
  docker ps -a --filter "name=bfs-e2e-${run}" --format '  {{.Names}}  {{.Status}}  {{.Ports}}' 2>/dev/null
  for name in $names; do
    echo "[docker] last log lines of ${name}:"
    docker logs --tail 40 "$name" 2>&1 | sed 's/^/  /'
  done
  return 0
}

# docker_cleanup_run <run-id> - remove every container and volume this run created
# (name prefix bfs-e2e-<run-id>). Called by env_cleanup; safe to call with no
# Docker daemon (no-op).
docker_cleanup_run() {
  local run="$1" ids
  docker_available || return 0
  ids="$(docker ps -aq --filter "name=bfs-e2e-${run}" 2>/dev/null)"
  [ -n "$ids" ] && docker rm -f $ids >/dev/null 2>&1
  ids="$(docker volume ls -q --filter "name=bfs-e2e-${run}" 2>/dev/null)"
  [ -n "$ids" ] && docker volume rm $ids >/dev/null 2>&1
  return 0
}
