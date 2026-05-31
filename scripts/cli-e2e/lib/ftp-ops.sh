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
  MSYS2_ENV_CONV_EXCL="FC_BASE;FC_PATHS" \
    FC_HOST="${FTP_HOST[$e]}" FC_PORT="${FTP_PORT[$e]}" FC_USER="${FTP_USER[$e]}" \
    FC_PASS="${FTP_PASS[$e]}" FC_SECURE="${FTP_SECURE[$e]}" FC_BASE="${FTP_BASE[$e]}" \
    FC_MODE="$mode" FC_RUN="${FC_RUN:-}" FC_PATHS="${FC_PATHS:-}" \
    "$TSX" "$SCRIPT_DIR/lib/ftp-ops.ts" </dev/null 2>&1 |
    sed 's/^/  [ftp-ops] /'
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
