# shellcheck shell=bash
# Docker-managed SSH endpoints for scenarios that must exercise REAL server
# lifecycle deterministically (address change, disk failure, server replacement)
# — including on CI. Data lives in a NAMED VOLUME, not a bind mount, so
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

DOCKER_SSH_IMAGE="linuxserver/openssh-server"
DOCKER_SSH_USER="bfsuser"
DOCKER_SSH_PASS="bfspass"
DOCKER_SSH_BASE="/config"

DOCKER_FTP_IMAGE="delfer/alpine-ftp-server"
DOCKER_FTP_USER="bfsuser"
DOCKER_FTP_PASS="bfspass"
DOCKER_FTP_BASE="/ftp/bfsuser"

# docker_available — returns 0 when the Docker daemon is usable.
docker_available() { docker info >/dev/null 2>&1; }

# _docker_ssh_wait <host-port> — block until an authenticated SSH handshake to
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

# docker_sshd_up <container> <host-port> <volume> — (re)start an sshd on host-port
# backed by the named volume, then wait until it accepts an authenticated
# connection. Removes any prior container of the same name first.
docker_sshd_up() {
  local ctr="$1" port="$2" vol="$3"
  docker rm -f "$ctr" >/dev/null 2>&1
  docker run -d --name "$ctr" -p "${port}:2222" \
    -e PUID=1000 -e PGID=1000 -e PASSWORD_ACCESS=true \
    -e "USER_NAME=${DOCKER_SSH_USER}" -e "USER_PASSWORD=${DOCKER_SSH_PASS}" -e SUDO_ACCESS=false \
    -v "${vol}:/config" "$DOCKER_SSH_IMAGE" >/dev/null 2>&1 || return 1
  _docker_ssh_wait "$port"
}

# docker_sshd_down <container> — stop and remove the container (idempotent).
docker_sshd_down() { docker rm -f "$1" >/dev/null 2>&1 || true; }

# _docker_ftp_wait <ctrl-port> — block until the ftpd genuinely accepts an
# authenticated login AND a passive data transfer, not merely a TCP connect.
# A bare TCP connect to a docker-published port is useless as a readiness signal:
# the host port is bound by docker's port-forwarder the moment `docker run` sets
# up the mapping — before the container's vsftpd has created its user or started
# serving — so it answers in ~2ms while login/PASV are not yet ready, and a
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

# docker_ftpd_up <container> <ctrl-port> <pasv-min> <pasv-max> <volume> — (re)start
# a passive-mode FTP server on ctrl-port (data volume at /ftp/bfsuser), advertising
# 127.0.0.1 for PASV, then wait until the control port answers.
docker_ftpd_up() {
  local ctr="$1" port="$2" pmin="$3" pmax="$4" vol="$5"
  docker rm -f "$ctr" >/dev/null 2>&1
  docker run -d --name "$ctr" -p "${port}:21" -p "${pmin}-${pmax}:${pmin}-${pmax}" \
    -e "USERS=${DOCKER_FTP_USER}|${DOCKER_FTP_PASS}" -e ADDRESS=127.0.0.1 \
    -e "MIN_PORT=${pmin}" -e "MAX_PORT=${pmax}" \
    -v "${vol}:/ftp/${DOCKER_FTP_USER}" "$DOCKER_FTP_IMAGE" >/dev/null 2>&1 || return 1
  _docker_ftp_wait "$port"
}

# docker_ftpd_down <container> — stop and remove the container (idempotent).
docker_ftpd_down() { docker rm -f "$1" >/dev/null 2>&1 || true; }

# docker_volume_reset <volume> — drop and recreate the volume EMPTY (simulates a
# failed disk: the data is gone, the mount point is back).
docker_volume_reset() {
  docker volume rm "$1" >/dev/null 2>&1
  docker volume create "$1" >/dev/null 2>&1
}

# docker_volume_rm <volume> — remove the volume (idempotent).
docker_volume_rm() { docker volume rm "$1" >/dev/null 2>&1 || true; }

# docker_cleanup_run <run-id> — remove every container and volume this run created
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
