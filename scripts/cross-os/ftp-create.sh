#!/usr/bin/env bash
# shellcheck shell=bash
# Cross-OS restore proof over a SHARED FTP — SOURCE half.
#
# Creates a real backup with the current `bfs` on this OS and pushes its shards to
# an FTP endpoint reachable from the target OS too. Nothing is staged as a CI
# artifact — the shards live on FTP, and ftp-restore.sh on the other OS rebuilds
# .bfs from them by disaster recovery. Fixtures are deterministic, so the target
# knows the expected bytes without a baseline transfer.
#
# Usage:  bash scripts/cross-os/ftp-create.sh <ftp-spec> <run-id>
#   <ftp-spec>  [ftp[s]://]user:pass@host[:port]/basepath
#   <run-id>    pipeline+direction id; namespaces the remote dirs as
#               <base>/bfs-e2e-<run-id>/p{0,1,2} (must match the restore call)
set -euo pipefail

XOS_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/cross-os/ftp-lib.sh
. "$XOS_REPO_ROOT/scripts/cross-os/ftp-lib.sh"

XOS_SPEC="${1:?usage: ftp-create.sh <ftp-spec> <run-id>}"
XOS_RUN_ID="${2:?usage: ftp-create.sh <ftp-spec> <run-id>}"
VAULT_NAME="crossosftp"
xos_parse_ftp "$XOS_SPEC"

SRC="$(mktemp -d)"
trap 'rm -rf "$SRC"' EXIT

# ── Create the remote provider base dirs (bfs init lists them, fails if absent) ─
FC_PATHS="$(xos_remote p0)|$(xos_remote p1)|$(xos_remote p2)|" xos_ftp_op mkdir

# ── Deterministic fixtures, then init + push the shards to FTP ─────────────────
xos_write_fixtures "$SRC"

bfs --cwd "$(winpath "$SRC")" init "$VAULT_NAME" --ci --no-enc --no-compress \
  --data-shards 2 --parity-shards 1 \
  --provider "$(xos_provider_flags p0)" \
  --provider "$(xos_provider_flags p1)" \
  --provider "$(xos_provider_flags p2)"

bfs --cwd "$(winpath "$SRC")" push --new

echo "[cross-os-ftp] created '$VAULT_NAME' on ${XF_HOST} under bfs-e2e-${XOS_RUN_ID}"
