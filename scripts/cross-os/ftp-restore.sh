#!/usr/bin/env bash
# shellcheck shell=bash
# Cross-OS restore proof over a SHARED FTP — TARGET half.
#
# Takes a backup pushed to FTP by ftp-create.sh on the *other* OS and proves it
# restores here byte-for-byte. With no .bfs present, `bfs recovery` rebuilds the
# metadata from one FTP provider's location map (disaster recovery); the recovered
# config points at the same FTP host — reachable on this OS too — so a plain pull
# restores the tree (no repair needed, unlike the local/USB variant). The pulled
# files are compared to the deterministic fixtures regenerated locally.
#
# Usage:  bash scripts/cross-os/ftp-restore.sh <ftp-spec> <run-id> <workspace-dir>
set -euo pipefail

XOS_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=scripts/cross-os/ftp-lib.sh
. "$XOS_REPO_ROOT/scripts/cross-os/ftp-lib.sh"

XOS_SPEC="${1:?usage: ftp-restore.sh <ftp-spec> <run-id> <workspace-dir>}"
XOS_RUN_ID="${2:?usage: ftp-restore.sh <ftp-spec> <run-id> <workspace-dir>}"
WS="${3:?usage: ftp-restore.sh <ftp-spec> <run-id> <workspace-dir>}"
VAULT_NAME="crossosftp"
xos_parse_ftp "$XOS_SPEC"

mkdir -p "$WS"
WS="$(cd "$WS" && pwd)"
# Remove this run's remote namespace on the way out, pass or fail, so the shared
# server does not accumulate leftovers.
trap_cleanup() { FC_RUN="$XOS_RUN_ID" xos_ftp_op run || true; }
trap trap_cleanup EXIT

# ── Expected content: regenerate the deterministic fixtures + hash them ────────
EXP="$WS/expected"
xos_write_fixtures "$EXP"
( cd "$EXP" && find . -type f -print0 | sort -z | xargs -0 sha256sum ) >"$WS/baseline.sha256"

# ── Disaster recovery from FTP, then pull ─────────────────────────────────────
# --trust-locations pre-approves the recovered hosts (non-interactive CI); the FTP
# coordinates in the location map are valid on this OS, so pull needs no repair.
R="$WS/restore"
mkdir -p "$R"
bfs --cwd "$(winpath "$R")" recovery --provider ftp --name "$VAULT_NAME" \
  --bootstrap "$(xos_bootstrap_flags p0)" --trust-locations
bfs --cwd "$(winpath "$R")" verify
bfs --cwd "$(winpath "$R")" pull --force --yes

# ── Byte-for-byte check against the source fixtures ───────────────────────────
if ( cd "$R" && sha256sum -c "$WS/baseline.sha256" ) >/dev/null; then
  echo "[cross-os-ftp] restore of '$VAULT_NAME' — SHA-256 match ✓"
else
  echo "[cross-os-ftp] restore of '$VAULT_NAME' — SHA-256 MISMATCH ✗" >&2
  ( cd "$R" && sha256sum -c "$WS/baseline.sha256" ) >&2 || true
  exit 1
fi
