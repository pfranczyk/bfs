#!/bin/sh
# Run inside Docker: installs bfs-vault@0.6.2 and creates a backup.
# Provider format: "type:name --flag value"  (space-separated, new syntax)
# Explicit --compress to test the compressed blob path.
# 0.6.2 is the latest patch of the 0.6.x line — patches share the on-disk
# format, so this fixture represents 0.6.0/0.6.1 as well.
set -e
BASE="$1"
VAULT_NAME="$2"

npm install -g bfs-vault@0.6.2

cd "$BASE/src"
bfs init "$VAULT_NAME" --ci \
  --compress \
  --data-shards 2 --parity-shards 1 \
  --max-ram 256 \
  --provider "local:p1 --path $BASE/p1" \
  --provider "local:p2 --path $BASE/p2" \
  --provider "local:p3 --path $BASE/p3"
bfs push
