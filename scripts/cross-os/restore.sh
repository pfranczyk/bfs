#!/usr/bin/env bash
# shellcheck shell=bash
# Cross-OS restore proof — TARGET half.
#
# Takes an artifact staged by create.sh on the *other* OS and proves the backup
# restores here byte-for-byte. The provider base paths recorded in the artifact
# are from the source OS and do not exist on this machine, so both flows repoint
# every device with `bfs repair --ci` to wherever the artifact was extracted:
#
#   1. repair-based  — copy the shipped .bfs, repair all devices to their new
#                      paths, pull.
#   2. recovery-based — rebuild .bfs from a single device (disaster recovery),
#                      repair to the new paths, pull.
#
# Each restore is compared to baseline.sha256 with `sha256sum -c`.
#
# Usage:  bash scripts/cross-os/restore.sh <artifact-dir> <workspace-dir>
set -euo pipefail

ART="${1:?usage: restore.sh <artifact-dir> <workspace-dir>}"
WS="${2:?usage: restore.sh <artifact-dir> <workspace-dir>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
bfs() { ( cd "$REPO_ROOT" && npx tsx src/index.ts "$@" ); }

VAULT_NAME="$(tr -d '\r\n' < "$ART/vault-name")"
P0="$(winpath "$ART/providers/p0")"
P1="$(winpath "$ART/providers/p1")"
P2="$(winpath "$ART/providers/p2")"

# Assert restored tree matches the source baseline byte-for-byte.
check_restored() {
  local dir="$1" label="$2"
  if ( cd "$dir" && sha256sum -c "$ART/baseline.sha256" ) >/dev/null; then
    echo "[cross-os] $label — SHA-256 match ✓"
  else
    echo "[cross-os] $label — SHA-256 MISMATCH ✗" >&2
    ( cd "$dir" && sha256sum -c "$ART/baseline.sha256" ) >&2 || true
    exit 1
  fi
}

# ── Flow 1: repair-based restore ──────────────────────────────────────────────
R1="$WS/repair-restore"
mkdir -p "$R1"
cp -r "$ART/vault/.bfs" "$R1/.bfs"

bfs --cwd "$(winpath "$R1")" repair --ci --version all \
  p0 "--path $P0" p1 "--path $P1" p2 "--path $P2"
bfs --cwd "$(winpath "$R1")" verify
bfs --cwd "$(winpath "$R1")" pull --force --yes
check_restored "$R1" "repair-based restore"

# ── Flow 2: recovery-based restore (disaster recovery) ────────────────────────
# Rebuild .bfs from one device, then repair to the new paths. recovery writes
# the config from the shard's location map (source-OS paths), so the repair step
# is required before pull can find the devices on this machine.
R2="$WS/recovery-restore"
mkdir -p "$R2"

bfs --cwd "$(winpath "$R2")" recovery --provider local --name "$VAULT_NAME" \
  --bootstrap "--path $P1" --trust-locations
bfs --cwd "$(winpath "$R2")" repair --ci --version all \
  p0 "--path $P0" p1 "--path $P1" p2 "--path $P2"
bfs --cwd "$(winpath "$R2")" pull --force --yes
check_restored "$R2" "recovery-based restore"

echo "[cross-os] all flows restored '$VAULT_NAME' byte-for-byte"
