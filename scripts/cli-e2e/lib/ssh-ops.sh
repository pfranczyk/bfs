# shellcheck shell=bash
# Bash wrappers around lib/ssh-ops.ts — prepare (mkdir) and tear down the
# harness's namespaced test directories on each SSH endpoint. Requires $TSX and
# $SCRIPT_DIR to be set, and the SSH_* endpoint arrays populated by
# parse_ssh_specs (and, for prepare, the PV_* pool arrays).

# _ssh_op <endpoint-index> <mode>  (extra input via SO_RUN / SO_PATHS env)
_ssh_op() {
  local e="$1" mode="$2"
  # MSYS2_ENV_CONV_EXCL stops Git-Bash/MSYS from rewriting the POSIX remote
  # paths in SO_BASE/SO_PATHS into Windows paths (e.g. "/" → "C:/Program
  # Files/Git/") when handing them to the native node.exe. No-op on Linux.
  MSYS2_ENV_CONV_EXCL="SO_BASE;SO_PATHS;SO_FILE;SO_FROM;SO_TO" \
    SO_HOST="${SSH_HOST[$e]}" SO_PORT="${SSH_PORT[$e]}" SO_USER="${SSH_USER[$e]}" \
    SO_PASS="${SSH_PASS[$e]}" SO_BASE="${SSH_BASE[$e]}" \
    SO_MODE="$mode" SO_RUN="${SO_RUN:-}" SO_PATHS="${SO_PATHS:-}" SO_FILE="${SO_FILE:-}" \
    SO_FROM="${SO_FROM:-}" SO_TO="${SO_TO:-}" SO_LOCAL="${SO_LOCAL:-}" \
    "$TSX" "$SCRIPT_DIR/lib/ssh-ops.ts" </dev/null 2>&1 |
    sed 's/^/  [ssh-ops] /'
}

# ssh_put <endpoint-index> <local-file> <remote-file> — upload a local file to a
# remote path (parents created). Used to pre-place identical shard bytes on a
# new-type provider before a no-rebuild `bfs repair` repoints to it.
ssh_put() {
  local e="$1" local_file="$2" remote="$3"
  SO_LOCAL="$local_file" SO_FILE="$remote" _ssh_op "$e" put
}

# ssh_rename <endpoint-index> <from-remote> <to-remote> — move a remote directory
# within the harness namespace (the parent of <to> is created first). Simulates a
# storage relocation an operator then points a provider at via `bfs provider edit`.
ssh_rename() {
  local e="$1" from="$2" to="$3"
  SO_FROM="$from" SO_TO="$to" _ssh_op "$e" rename
}

# ssh_sha <endpoint-index> <remote-file> — print the remote file's SHA-256 (hex)
# to stdout and return 0, or return 3 when the file is absent. Bypasses the
# [ssh-ops] log prefix / stderr merge of _ssh_op so the caller can capture the
# hash cleanly: h="$(ssh_sha 0 /path/shard_0.bfs.1)". Used by the sidecar e2e to
# prove a repair left the shard payload untouched and dropped an hdr_ sidecar.
ssh_sha() {
  local e="$1" file="$2"
  MSYS2_ENV_CONV_EXCL="SO_BASE;SO_FILE" \
    SO_HOST="${SSH_HOST[$e]}" SO_PORT="${SSH_PORT[$e]}" SO_USER="${SSH_USER[$e]}" \
    SO_PASS="${SSH_PASS[$e]}" SO_BASE="${SSH_BASE[$e]}" \
    SO_MODE="sha" SO_FILE="$file" \
    "$TSX" "$SCRIPT_DIR/lib/ssh-ops.ts" </dev/null 2>/dev/null
}

# ssh_touch <endpoint-index> <remote-file-path> — plant a 1-byte regular file at
# the given remote path. Used to build a "path segment is a file" obstacle: a
# directory op nested under it fails on any compliant SFTP server, so a
# probe-failure trigger stays deterministic regardless of how permissive the
# account is about creating directories.
ssh_touch() {
  local e="$1" file="$2"
  SO_FILE="$file" _ssh_op "$e" file
}

# ssh_rm <endpoint-index> <remote-file> — delete a single remote file (a shard)
# to simulate a lost shard / unreachable server, so a pull must reconstruct it
# via Reed-Solomon from the surviving providers on the other endpoints.
ssh_rm() {
  local e="$1" file="$2"
  SO_FILE="$file" _ssh_op "$e" rm
}

# ssh_mkdir <endpoint-index> <remote-path> — create a single remote directory
# (and parents) within the harness namespace. Used to pre-create a NEW provider's
# base dir before `bfs repair` migrates/rebuilds a shard onto it — BFS requires a
# provider's base path to already exist.
ssh_mkdir() {
  local e="$1" remote="$2"
  SO_PATHS="${remote}|" _ssh_op "$e" mkdir
}

# ssh_prepare_pool — create every SSH provider's remote base directory before
# `bfs init` (which lists it and fails if absent). One connection per endpoint.
ssh_prepare_pool() {
  local n e i paths
  n="$(ssh_count)"
  [ "$n" -gt 0 ] || return 0
  for ((e = 0; e < n; e++)); do
    paths=""
    for ((i = 0; i < PV_COUNT; i++)); do
      if [ "${PV_TYPE[$i]}" = "ssh" ] && [ "${PV_SSH_ENDPOINT[$i]}" = "$e" ]; then
        paths="${paths}${PV_SSH_REMOTE[$i]}|"
      fi
    done
    [ -n "$paths" ] && SO_PATHS="$paths" _ssh_op "$e" mkdir
  done
}

# ssh_clean_run <run_id> — remove only THIS run's namespace from every endpoint.
ssh_clean_run() {
  local run="$1" e n
  n="$(ssh_count)"
  for ((e = 0; e < n; e++)); do SO_RUN="$run" _ssh_op "$e" run; done
}

# ssh_clean_all — remove ALL bfs-e2e-* leftovers from every endpoint.
ssh_clean_all() {
  local e n
  n="$(ssh_count)"
  for ((e = 0; e < n; e++)); do _ssh_op "$e" all; done
}
