# shellcheck shell=bash
# Provider pool: turns injected FTP/SSH credentials and on-disk temp dirs into
# the `--provider "type:id --flags"` arguments that `bfs init` consumes, and
# tracks enough metadata for scenarios to locate shard files afterwards.
#
# Local providers are free (temp dirs inside the run workspace). FTP/SSH
# providers come from repeatable `--ftp "<spec>"` / `--ssh "<spec>"` flags. One
# endpoint backs many BFS providers via distinct remote sub-paths, so a single
# server covers a 3/1 scheme (4 distinct providers = 4 sub-paths). Multiple
# endpoints are used round-robin. Remote paths are namespaced by RUN_ID so
# reruns never collide and the harness never deletes anything on the user's
# server.

# parse_ftp_specs — fill FTP_HOST/PORT/USER/PASS/BASE/SECURE from FTP_SPECS.
# Grammar: [ftp[s]://]user:pass@host[:port]/basepath
parse_ftp_specs() {
  FTP_HOST=(); FTP_PORT=(); FTP_USER=(); FTP_PASS=(); FTP_BASE=(); FTP_SECURE=()
  local spec secure userpass rest hostport host port path
  for spec in "${FTP_SPECS[@]:-}"; do
    [ -n "$spec" ] || continue
    secure=false
    case "$spec" in
      ftps://*) secure=true; spec="${spec#ftps://}" ;;
      ftp://*)  spec="${spec#ftp://}" ;;
    esac
    userpass="${spec%%@*}"
    rest="${spec#*@}"
    if [ "$userpass" = "$spec" ]; then
      echo "FATAL: --ftp spec missing '@': $spec (expected user:pass@host/path)" >&2
      exit 2
    fi
    user="${userpass%%:*}"
    if [ "${userpass#*:}" = "$userpass" ]; then
      echo "FATAL: --ftp spec missing ':' in credentials: $spec" >&2
      exit 2
    fi
    pass="${userpass#*:}"
    hostport="${rest%%/*}"
    if [ "$hostport" = "$rest" ]; then
      path="/"
    else
      path="/${rest#*/}"
    fi
    path="${path%/}"; [ -z "$path" ] && path="/"
    host="${hostport%%:*}"
    port="${hostport#*:}"; [ "$port" = "$hostport" ] && port=21
    FTP_HOST+=("$host"); FTP_PORT+=("$port"); FTP_USER+=("$user")
    FTP_PASS+=("$pass"); FTP_BASE+=("$path"); FTP_SECURE+=("$secure")
  done
}

ftp_count() { printf '%s' "${#FTP_HOST[@]}"; }

# register_ftp_endpoint <host> <port> <user> <pass> <base> <secure> — append a
# scenario-managed FTP endpoint to the pool arrays; the new index is left in the
# global REG_FTP_INDEX. (Must NOT be captured via $(...) — command substitution's
# subshell would drop the array appends.) Lets a docker-managed scenario provision
# its own ftpd (not from --ftp flags).
register_ftp_endpoint() {
  FTP_HOST+=("$1"); FTP_PORT+=("$2"); FTP_USER+=("$3"); FTP_PASS+=("$4"); FTP_BASE+=("$5"); FTP_SECURE+=("$6")
  REG_FTP_INDEX="$(( ${#FTP_HOST[@]} - 1 ))"
}

# parse_ssh_specs — fill SSH_HOST/PORT/USER/PASS/BASE from SSH_SPECS.
# Grammar: [ssh://]user:pass@host[:port]/basepath
parse_ssh_specs() {
  SSH_HOST=(); SSH_PORT=(); SSH_USER=(); SSH_PASS=(); SSH_BASE=()
  local spec userpass rest hostport host port path user pass
  for spec in "${SSH_SPECS[@]:-}"; do
    [ -n "$spec" ] || continue
    case "$spec" in
      ssh://*) spec="${spec#ssh://}" ;;
    esac
    userpass="${spec%%@*}"
    rest="${spec#*@}"
    if [ "$userpass" = "$spec" ]; then
      echo "FATAL: --ssh spec missing '@': $spec (expected user:pass@host/path)" >&2
      exit 2
    fi
    user="${userpass%%:*}"
    if [ "${userpass#*:}" = "$userpass" ]; then
      echo "FATAL: --ssh spec missing ':' in credentials: $spec" >&2
      exit 2
    fi
    pass="${userpass#*:}"
    hostport="${rest%%/*}"
    if [ "$hostport" = "$rest" ]; then
      path="/"
    else
      path="/${rest#*/}"
    fi
    path="${path%/}"; [ -z "$path" ] && path="/"
    host="${hostport%%:*}"
    port="${hostport#*:}"; [ "$port" = "$hostport" ] && port=22
    SSH_HOST+=("$host"); SSH_PORT+=("$port"); SSH_USER+=("$user")
    SSH_PASS+=("$pass"); SSH_BASE+=("$path")
  done
}

ssh_count() { printf '%s' "${#SSH_HOST[@]}"; }

# register_ssh_endpoint <host> <port> <user> <pass> <base> — append a
# scenario-managed SSH endpoint to the pool arrays; the new index is left in the
# global REG_SSH_INDEX. (Must NOT be captured via $(...) — command substitution
# runs in a subshell, where the array appends would be lost.) Lets a
# docker-managed scenario provision its own sshd (not from --ssh flags) and then
# build a pool with `ssh` providers that round-robin onto it.
register_ssh_endpoint() {
  SSH_HOST+=("$1"); SSH_PORT+=("$2"); SSH_USER+=("$3"); SSH_PASS+=("$4"); SSH_BASE+=("$5")
  REG_SSH_INDEX="$(( ${#SSH_HOST[@]} - 1 ))"
}

# set_ssh_endpoint_port <index> <port> — update a registered endpoint's port after
# its container restarts on a new one, so ssh_sha / bootstrap specs reach it. The
# remote sub-path (PV_SSH_REMOTE) is port-independent, so it stays valid.
set_ssh_endpoint_port() {
  SSH_PORT[$1]="$2"
}

# pool_reset <vaultname> — start a fresh provider pool for one scenario.
pool_reset() {
  POOL_VAULTNAME="$1"
  PROVIDER_ARGS=()
  PV_ID=(); PV_TYPE=(); PV_LOCALDIR=(); PV_FTP_REMOTE=(); PV_FTP_ENDPOINT=()
  PV_SSH_REMOTE=(); PV_SSH_ENDPOINT=()
  PV_COUNT=0
  PV_FTP_ALLOC=0
  PV_SSH_ALLOC=0
}

_pool_add_local() {
  local dir="$1" id="p${PV_COUNT}"
  mkdir -p "$dir"
  PROVIDER_ARGS+=(--provider "local:${id} --path $(winpath "$dir")")
  PV_ID+=("$id"); PV_TYPE+=("local"); PV_LOCALDIR+=("$dir")
  PV_FTP_REMOTE+=(""); PV_FTP_ENDPOINT+=("")
  PV_SSH_REMOTE+=(""); PV_SSH_ENDPOINT+=("")
  PV_COUNT=$((PV_COUNT + 1))
}

_pool_add_ftp() {
  local id="p${PV_COUNT}" e remote
  # Spread FTP providers across the supplied endpoints round-robin by FTP
  # allocation order (not global provider index), so interleaved layouts still
  # distribute evenly across endpoints.
  e=$(( PV_FTP_ALLOC % $(ftp_count) ))
  PV_FTP_ALLOC=$((PV_FTP_ALLOC + 1))
  remote="${FTP_BASE[$e]%/}/bfs-e2e-${RUN_ID}/${id}"
  PROVIDER_ARGS+=(--provider "ftp:${id} --host ${FTP_HOST[$e]} --port ${FTP_PORT[$e]} --user ${FTP_USER[$e]} --password ${FTP_PASS[$e]} --path ${remote} --secure ${FTP_SECURE[$e]}")
  PV_ID+=("$id"); PV_TYPE+=("ftp"); PV_LOCALDIR+=("")
  PV_FTP_REMOTE+=("$remote"); PV_FTP_ENDPOINT+=("$e")
  PV_SSH_REMOTE+=(""); PV_SSH_ENDPOINT+=("")
  PV_COUNT=$((PV_COUNT + 1))
}

_pool_add_ssh() {
  local id="p${PV_COUNT}" e remote
  # Spread SSH providers across the supplied endpoints round-robin by SSH
  # allocation order (not global provider index), so interleaved layouts still
  # distribute evenly across endpoints.
  e=$(( PV_SSH_ALLOC % $(ssh_count) ))
  PV_SSH_ALLOC=$((PV_SSH_ALLOC + 1))
  remote="${SSH_BASE[$e]%/}/bfs-e2e-${RUN_ID}/${id}"
  # --accept-new-host-key is the realistic non-interactive first-contact path
  # (TOFU): the harness connects to a freshly started sshd whose host key is
  # not yet pinned. This exercises BFS's own host-key acceptance, not a bypass.
  PROVIDER_ARGS+=(--provider "ssh:${id} --host ${SSH_HOST[$e]} --port ${SSH_PORT[$e]} --user ${SSH_USER[$e]} --password ${SSH_PASS[$e]} --path ${remote} --accept-new-host-key")
  PV_ID+=("$id"); PV_TYPE+=("ssh"); PV_LOCALDIR+=("")
  PV_FTP_REMOTE+=(""); PV_FTP_ENDPOINT+=("")
  PV_SSH_REMOTE+=("$remote"); PV_SSH_ENDPOINT+=("$e")
  PV_COUNT=$((PV_COUNT + 1))
}

# _pool_add <type> <sandbox> — append one provider of the given type.
_pool_add() {
  case "$1" in
    local) _pool_add_local "$2/prov/p${PV_COUNT}" ;;
    ftp)   _pool_add_ftp ;;
    ssh)   _pool_add_ssh ;;
    *) echo "FATAL: unknown provider type '$1'" >&2; exit 2 ;;
  esac
}

# build_pool_seq <sandbox> <vaultname> <type> [<type> ...]
# Allocates providers in the EXACT given order, so shard_i lands on the i-th
# listed type. Use for hybrid layouts, e.g.:
#   build_pool_seq "$SC_DIR" "$name" local ftp local ftp
build_pool_seq() {
  local sandbox="$1" vault="$2"; shift 2
  pool_reset "$vault"
  local t
  for t in "$@"; do _pool_add "$t" "$sandbox"; done
  # FTP/SSH providers need their remote base dir to exist before `bfs init`
  # (which lists it). Local providers are created in _pool_add_local via
  # mkdir -p.
  if declare -F ftp_prepare_pool >/dev/null 2>&1; then ftp_prepare_pool; fi
  if declare -F ssh_prepare_pool >/dev/null 2>&1; then ssh_prepare_pool; fi
}

# build_pool <sandbox> <n_local> <n_ftp> <vaultname>
# Grouped layout: all local providers first, then all FTP providers.
build_pool() {
  local sandbox="$1" n_local="$2" n_ftp="$3" vault="$4" i seq=()
  for ((i = 0; i < n_local; i++)); do seq+=(local); done
  for ((i = 0; i < n_ftp; i++)); do seq+=(ftp); done
  build_pool_seq "$sandbox" "$vault" "${seq[@]}"
}

# ftp_bootstrap_spec <provider-index> — `--bootstrap` adapter flags for
# recovering via the given FTP provider (its endpoint creds + remote path).
ftp_bootstrap_spec() {
  local i="$1"
  local e="${PV_FTP_ENDPOINT[$i]}"
  printf -- '--host %s --port %s --user %s --password %s --path %s --secure %s' \
    "${FTP_HOST[$e]}" "${FTP_PORT[$e]}" "${FTP_USER[$e]}" "${FTP_PASS[$e]}" \
    "${PV_FTP_REMOTE[$i]}" "${FTP_SECURE[$e]}"
}

# ssh_bootstrap_spec <provider-index> — `--bootstrap` adapter flags for
# recovering via the given SSH provider (its endpoint creds + remote path).
ssh_bootstrap_spec() {
  local i="$1"
  local e="${PV_SSH_ENDPOINT[$i]}"
  printf -- '--host %s --port %s --user %s --password %s --path %s --accept-new-host-key' \
    "${SSH_HOST[$e]}" "${SSH_PORT[$e]}" "${SSH_USER[$e]}" "${SSH_PASS[$e]}" \
    "${PV_SSH_REMOTE[$i]}"
}

# shard_file <provider-index> <version> — path to a local provider's shard file.
# Shard index equals provider index (BFS assigns shard_i to provider i in order).
shard_file() {
  local i="$1" version="$2"
  printf '%s/%s/shard_%s.bfs.%s' "${PV_LOCALDIR[$i]}" "$POOL_VAULTNAME" "$i" "$version"
}
