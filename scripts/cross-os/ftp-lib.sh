# shellcheck shell=bash
# Cross-OS restore proof over a SHARED FTP server — common helpers.
#
# Sourced by ftp-create.sh (source OS) and ftp-restore.sh (target OS). Unlike the
# artifact-based create.sh/restore.sh (which move a local "USB" directory between
# isolated CI machines), this pair uses one FTP endpoint reachable from BOTH the
# Linux and the Windows runner: the source pushes shards to FTP, the target runs
# disaster-recovery from FTP and pulls — no CI artifact is transferred.
#
# Fixtures are DETERMINISTIC (byte-identical from the same generator on any OS), so
# the target knows the expected bytes without a baseline being shipped.

# winpath — hand a path to the (possibly Windows) node process in a form it groks.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }

# bfs — run the in-tree CLI via tsx (no build step); always from the repo root so
# --cwd is resolved against a stable base.
bfs() { ( cd "$XOS_REPO_ROOT" && npx tsx src/index.ts "$@" ); }

# xos_parse_ftp <spec> — split [ftp[s]://]user:pass@host[:port]/basepath into the
# XF_* globals. Mirrors parse_ftp_specs in the cli-e2e harness for one endpoint.
xos_parse_ftp() {
  local spec="$1" secure=false creds hostport
  case "$spec" in
    ftps://*) secure=true; spec="${spec#ftps://}" ;;
    ftp://*) spec="${spec#ftp://}" ;;
  esac
  case "$spec" in
    *@*) : ;;
    *) echo "FATAL: --ftp spec missing '@': $spec" >&2; exit 2 ;;
  esac
  creds="${spec%%@*}"
  local rest="${spec#*@}"
  case "$creds" in
    *:*) : ;;
    *) echo "FATAL: --ftp spec missing ':' in credentials" >&2; exit 2 ;;
  esac
  XF_USER="${creds%%:*}"
  XF_PASS="${creds#*:}"
  hostport="${rest%%/*}"
  local path="/${rest#*/}"
  [ "$rest" = "$hostport" ] && path="/"
  case "$hostport" in
    *:*) XF_HOST="${hostport%%:*}"; XF_PORT="${hostport#*:}" ;;
    *) XF_HOST="$hostport"; XF_PORT=21 ;;
  esac
  XF_BASE="$path"
  XF_SECURE="$secure"
}

# xos_remote <id> — remote base dir for provider <id> under this run's namespace.
# The namespace matches the cli-e2e `bfs-e2e-*` convention so its clean.sh sweeps
# any leftovers.
xos_remote() { printf '%s' "${XF_BASE%/}/bfs-e2e-${XOS_RUN_ID}/$1"; }

# xos_provider_flags <id> — `--provider "ftp:<id> …"` flag string for `bfs init`.
xos_provider_flags() {
  local id="$1"
  printf 'ftp:%s --host %s --port %s --user %s --password %s --path %s --secure %s' \
    "$id" "$XF_HOST" "$XF_PORT" "$XF_USER" "$XF_PASS" "$(xos_remote "$id")" "$XF_SECURE"
}

# xos_bootstrap_flags <id> — `--bootstrap "<flags>"` for `bfs recovery` via <id>.
xos_bootstrap_flags() {
  printf -- '--host %s --port %s --user %s --password %s --path %s --secure %s' \
    "$XF_HOST" "$XF_PORT" "$XF_USER" "$XF_PASS" "$(xos_remote "$1")" "$XF_SECURE"
}

# xos_ftp_op <mode> — invoke lib/ftp-ops.ts (mkdir/run cleanup) with FC_* env, so
# credentials never hit the process argument list. FC_PATHS is set by the caller.
# MSYS2_ENV_CONV_EXCL keeps Git Bash from rewriting the POSIX remote paths.
xos_ftp_op() {
  MSYS2_ENV_CONV_EXCL="FC_BASE;FC_PATHS;FC_RUN" \
    FC_HOST="$XF_HOST" FC_PORT="$XF_PORT" FC_USER="$XF_USER" FC_PASS="$XF_PASS" \
    FC_SECURE="$XF_SECURE" FC_BASE="$XF_BASE" FC_MODE="$1" \
    FC_PATHS="${FC_PATHS:-}" FC_RUN="${FC_RUN:-}" \
    npx tsx "$XOS_REPO_ROOT/scripts/cli-e2e/lib/ftp-ops.ts" </dev/null
}

# xos_write_fixtures <dir> — deterministic source tree: identical bytes from any
# OS (printf emits LF on Git Bash too; the binary file is a fixed generator, not
# /dev/urandom), so create and restore agree on content without shipping hashes.
xos_write_fixtures() {
  local dir="$1"
  mkdir -p "$dir/sub"
  printf 'cross-os plain text\nline two\n' >"$dir/file1.txt"
  printf '# heading\n\nparagraph\n' >"$dir/readme.md"
  printf 'nested content\n' >"$dir/sub/nested.txt"
  node -e 'const b=Buffer.alloc(4096);for(let i=0;i<b.length;i++)b[i]=(i*31+7)&0xff;process.stdout.write(b)' >"$dir/data.bin"
}
