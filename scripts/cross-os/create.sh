#!/usr/bin/env bash
# shellcheck shell=bash
# Cross-OS restore proof — SOURCE half.
#
# Creates a real backup with the current `bfs` (via `tsx src/index.ts`) on the
# source OS and stages it as a CI artifact for the target OS to restore. The
# provider base paths are written into the artifact itself, so the shards ship
# with it; restore.sh (on the other OS) repoints every device to wherever the
# artifact was extracted and pulls byte-for-byte.
#
# Usage:  bash scripts/cross-os/create.sh <artifact-dir>
#
# Emits under <artifact-dir>:
#   providers/p0 providers/p1 providers/p2  — provider base dirs (each holds
#                                             <vault>/shard_i.bfs.1 + hdr sidecars)
#   vault/.bfs                              — vault config/manifests/state
#   baseline.sha256                         — "<sha256>  <relpath>" per source file
#   vault-name                              — the vault name (one line)
set -euo pipefail

ART="${1:?usage: create.sh <artifact-dir>}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VAULT_NAME="crossos"

# Convert a path to a form the (possibly Windows) node process understands.
winpath() { if command -v cygpath >/dev/null 2>&1; then cygpath -m "$1"; else printf '%s' "$1"; fi; }
bfs() { ( cd "$REPO_ROOT" && npx tsx src/index.ts "$@" ); }

SRC="$ART/source"          # working directory holding the original files + .bfs
mkdir -p "$ART/providers/p0" "$ART/providers/p1" "$ART/providers/p2" "$SRC/sub"

# ── Fixtures (byte-identical across OSes; no checked-out files, so no CRLF) ────
printf 'cross-os plain text\nline two\n'        > "$SRC/file1.txt"
printf '# heading\n\nparagraph\n'               > "$SRC/readme.md"
printf 'nested content\n'                       > "$SRC/sub/nested.txt"
head -c 4096 /dev/urandom                       > "$SRC/data.bin"

# ── Baseline hashes of every source file (relative paths) ─────────────────────
( cd "$SRC" && find . -type f -not -path './.bfs/*' -print0 \
    | sort -z | xargs -0 sha256sum ) > "$ART/baseline.sha256"

# ── init + push (providers point straight into the artifact dir) ──────────────
bfs --cwd "$(winpath "$SRC")" init "$VAULT_NAME" --ci --no-enc --no-compress \
  --data-shards 2 --parity-shards 1 \
  --provider "local:p0 --path $(winpath "$ART/providers/p0")" \
  --provider "local:p1 --path $(winpath "$ART/providers/p1")" \
  --provider "local:p2 --path $(winpath "$ART/providers/p2")"

bfs --cwd "$(winpath "$SRC")" push --new

# ── Stage vault metadata + name for the target half ───────────────────────────
mkdir -p "$ART/vault"
cp -r "$SRC/.bfs" "$ART/vault/.bfs"
printf '%s\n' "$VAULT_NAME" > "$ART/vault-name"

echo "[cross-os] created backup '$VAULT_NAME' — artifact staged at $ART"
ls -R "$ART/providers" | sed 's/^/  /'
