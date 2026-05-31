#!/bin/sh
# Run inside Docker: installs bfs-vault@0.1.0 and creates a backup.
# Provider format: type:id:path  (colon-separated, no space)
# No compression support in this version.
set -e
BASE="$1"
VAULT_NAME="$2"

npm install -g bfs-vault@0.1.0

cd "$BASE/src"
bfs init "$VAULT_NAME" --ci \
  --data-shards 2 --parity-shards 1 \
  --provider "local:p1:$BASE/p1" \
  --provider "local:p2:$BASE/p2" \
  --provider "local:p3:$BASE/p3"
bfs push
