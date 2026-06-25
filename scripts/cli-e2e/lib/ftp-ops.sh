# shellcheck shell=bash
# Bash wrappers around lib/ftp-ops.ts — prepare (mkdir) and tear down the
# harness's namespaced test directories on each FTP endpoint. Requires $TSX and
# $SCRIPT_DIR to be set, and the FTP_* endpoint arrays populated by
# parse_ftp_specs (and, for prepare, the PV_* pool arrays).

# _ftp_op <endpoint-index> <mode>  (extra input via FC_RUN / FC_PATHS env)
_ftp_op() {
  local e="$1" mode="$2"
  # MSYS2_ENV_CONV_EXCL stops Git-Bash/MSYS from rewriting the POSIX remote
  # paths in FC_BASE/FC_PATHS into Windows paths (e.g. "/" → "C:/Program
  # Files/Git/") when handing them to the native node.exe. No-op on Linux.
  MSYS2_ENV_CONV_EXCL="FC_BASE;FC_PATHS;FC_FILE;FC_FROM;FC_TO" \
    FC_HOST="${FTP_HOST[$e]}" FC_PORT="${FTP_PORT[$e]}" FC_USER="${FTP_USER[$e]}" \
    FC_PASS="${FTP_PASS[$e]}" FC_SECURE="${FTP_SECURE[$e]}" FC_BASE="${FTP_BASE[$e]}" \
    FC_MODE="$mode" FC_RUN="${FC_RUN:-}" FC_PATHS="${FC_PATHS:-}" FC_FILE="${FC_FILE:-}" \
    FC_FROM="${FC_FROM:-}" FC_TO="${FC_TO:-}" \
    "$TSX" "$SCRIPT_DIR/lib/ftp-ops.ts" </dev/null 2>&1 |
    sed 's/^/  [ftp-ops] /'
}

# ftp_rename <endpoint-index> <from-remote> <to-remote> — move a remote directory
# within the harness namespace (the parent of <to> is created first). Simulates a
# storage relocation an operator then points a provider at via `bfs provider edit`.
ftp_rename() {
  local e="$1" from="$2" to="$3"
  FC_FROM="$from" FC_TO="$to" _ftp_op "$e" rename
}

# ftp_touch <endpoint-index> <remote-file-path> — plant a 1-byte regular file at
# the given remote path. Used to build a "path segment is a file" obstacle: a
# directory op nested under it fails 550 on any compliant FTP server, so a
# probe-failure trigger stays deterministic regardless of how permissive the
# account is about creating directories.
ftp_touch() {
  local e="$1" file="$2"
  FC_FILE="$file" _ftp_op "$e" file
}

# ftp_prepare_pool — create every FTP provider's remote base directory before
# `bfs init` (which lists it and fails if absent). One connection per endpoint.
ftp_prepare_pool() {
  local n e i paths
  n="$(ftp_count)"
  [ "$n" -gt 0 ] || return 0
  for ((e = 0; e < n; e++)); do
    paths=""
    for ((i = 0; i < PV_COUNT; i++)); do
      if [ "${PV_TYPE[$i]}" = "ftp" ] && [ "${PV_FTP_ENDPOINT[$i]}" = "$e" ]; then
        paths="${paths}${PV_FTP_REMOTE[$i]}|"
      fi
    done
    [ -n "$paths" ] && FC_PATHS="$paths" _ftp_op "$e" mkdir
  done
}

# ftp_clean_run <run_id> — remove only THIS run's namespace from every endpoint.
ftp_clean_run() {
  local run="$1" e n
  n="$(ftp_count)"
  for ((e = 0; e < n; e++)); do FC_RUN="$run" _ftp_op "$e" run; done
}

# ftp_clean_all — remove ALL bfs-e2e-* leftovers from every endpoint.
ftp_clean_all() {
  local e n
  n="$(ftp_count)"
  for ((e = 0; e < n; e++)); do _ftp_op "$e" all; done
}
