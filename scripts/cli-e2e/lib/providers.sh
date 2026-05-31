# shellcheck shell=bash
# Provider pool: turns injected FTP credentials and on-disk temp dirs into the
# `--provider "type:id --flags"` arguments that `bfs init` consumes, and tracks
# enough metadata for scenarios to locate shard files afterwards.
#
# Local providers are free (temp dirs inside the run workspace). FTP providers
# come from repeatable `--ftp "<spec>"` flags. One FTP endpoint backs many BFS
# providers via distinct remote sub-paths, so a single server covers a 3/1
# scheme (4 distinct providers = 4 sub-paths). Multiple endpoints are used
# round-robin. Remote paths are namespaced by RUN_ID so reruns never collide
# and the harness never deletes anything on the user's server.

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

# pool_reset <vaultname> — start a fresh provider pool for one scenario.
pool_reset() {
  POOL_VAULTNAME="$1"
  PROVIDER_ARGS=()
  PV_ID=(); PV_TYPE=(); PV_LOCALDIR=(); PV_FTP_REMOTE=(); PV_FTP_ENDPOINT=()
  PV_COUNT=0
  PV_FTP_ALLOC=0
}

_pool_add_local() {
  local dir="$1" id="p${PV_COUNT}"
  mkdir -p "$dir"
  PROVIDER_ARGS+=(--provider "local:${id} --path $(winpath "$dir")")
  PV_ID+=("$id"); PV_TYPE+=("local"); PV_LOCALDIR+=("$dir")
  PV_FTP_REMOTE+=(""); PV_FTP_ENDPOINT+=("")
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
  PV_COUNT=$((PV_COUNT + 1))
}

# _pool_add <type> <sandbox> — append one provider of the given type.
_pool_add() {
  case "$1" in
    local) _pool_add_local "$2/prov/p${PV_COUNT}" ;;
    ftp)   _pool_add_ftp ;;
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
  # FTP providers need their remote base dir to exist before `bfs init` (which
  # lists it). Local providers are created in _pool_add_local via mkdir -p.
  if declare -F ftp_prepare_pool >/dev/null 2>&1; then ftp_prepare_pool; fi
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

# shard_file <provider-index> <version> — path to a local provider's shard file.
# Shard index equals provider index (BFS assigns shard_i to provider i in order).
shard_file() {
  local i="$1" version="$2"
  printf '%s/%s/shard_%s.bfs.%s' "${PV_LOCALDIR[$i]}" "$POOL_VAULTNAME" "$i" "$version"
}
