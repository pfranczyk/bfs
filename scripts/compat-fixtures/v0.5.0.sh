#!/bin/sh
# Run inside Docker: installs bfs-vault@0.5.0 and creates a backup.
# Provider format: "type:name --flag value"  (space-separated, new syntax)
# Explicit --compress to test the compressed blob path.
set -e
BASE="$1"
VAULT_NAME="$2"

npm install -g bfs-vault@0.5.0

cd "$BASE/src"
bfs init "$VAULT_NAME" --ci \
  --compress \
  --data-shards 2 --parity-shards 1 \
  --max-ram 256 \
  --provider "local:p1 --path $BASE/p1" \
  --provider "local:p2 --path $BASE/p2" \
  --provider "local:p3 --path $BASE/p3"
bfs push
