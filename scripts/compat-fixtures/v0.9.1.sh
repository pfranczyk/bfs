#!/bin/sh
# Run inside Docker: installs bfs-vault@0.9.1 and creates a backup.
# Provider format: "type:name --flag value"  (space-separated, new syntax)
# Explicit --compress to test the compressed blob path.
# --no-enc keeps the fixture unencrypted like every other version here; 0.9.x
# enables encryption by default, so the opt-out is explicit (otherwise push would
# block on an interactive password prompt).
# 0.9.1 is the latest patch of the 0.9.x line — patches share the on-disk format,
# so this fixture represents 0.9.0/0.9.1 as well.
set -e
BASE="$1"
VAULT_NAME="$2"

npm install -g bfs-vault@0.9.1

cd "$BASE/src"
bfs init "$VAULT_NAME" --ci \
  --no-enc \
  --compress \
  --data-shards 2 --parity-shards 1 \
  --max-ram 256 \
  --provider "local:p1 --path $BASE/p1" \
  --provider "local:p2 --path $BASE/p2" \
  --provider "local:p3 --path $BASE/p3"
bfs push
