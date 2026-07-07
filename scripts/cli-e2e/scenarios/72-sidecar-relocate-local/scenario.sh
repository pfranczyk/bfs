# shellcheck shell=bash
# Sidecar (BFSH) headers, local: a `bfs repair` location change writes each
# sibling's updated header to a small `hdr_i.bfs.V` sidecar file INSTEAD of
# rewriting the whole shard. This proves two things at once:
#   1. no re-upload — every `shard_i.bfs.V` payload is byte-for-byte unchanged
#      after repair (only a tiny sidecar is added next to it);
#   2. correctness — a fresh recovery from a SIBLING still discovers p0 at its
#      new path, which is only possible if the recovery read-path prefers the
#      sidecar's (updated) location map over the frozen in-shard one.
# Master-RED: it cannot go green unless BOTH the sidecar write AND the recovery
# read-path reroute are implemented — the unchanged-payload asserts fail today
# (repair rewrites the shard), and were the write done without the read reroute
# the sibling-recovery step would then fail on the stale in-shard map.

SCENARIO_NAME="sidecar: local relocate writes hdr_ sidecar, payload unchanged"
SCENARIO_DESC="3L 2/1; repair --path p0, assert shards byte-unchanged + hdr_ sidecars exist, recover from sibling"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

# _sha <file> — print the file's SHA-256 (hex), or empty string if absent.
_sha() {
  [ -f "$1" ] && sha256sum "$1" | cut -d' ' -f1
}

# _assert_sha_unchanged <label> <file> <expected-sha>
_assert_sha_unchanged() {
  local label="$1" file="$2" want="$3" got
  got="$(_sha "$file")"
  [ "$got" = "$want" ] || _fail "$label payload changed by repair (expected sidecar, got full rewrite): $file
    before=$want
    after =$got"
}

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs72"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # Physically move provider p0's storage to a new path, then repair to it.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  assert_file "$newdir/$name/shard_0.bfs.1"

  # Record each shard's payload hash right before repair (p0 already at newdir).
  local s0="$newdir/$name/shard_0.bfs.1"
  local s1="${PV_LOCALDIR[1]}/$name/shard_1.bfs.1"
  local s2="${PV_LOCALDIR[2]}/$name/shard_2.bfs.1"
  local h0 h1 h2
  h0="$(_sha "$s0")"
  h1="$(_sha "$s1")"
  h2="$(_sha "$s2")"

  run_bfs "$vault" repair --version all p0 "--path $(winpath "$newdir")"
  assert_ok

  # Sidecar proof: the shard payloads must be untouched (no re-upload)…
  _assert_sha_unchanged "shard_0" "$s0" "$h0"
  _assert_sha_unchanged "shard_1" "$s1" "$h1"
  _assert_sha_unchanged "shard_2" "$s2" "$h2"
  # …and each sibling must have gained an hdr_ sidecar carrying the new map.
  assert_file "$newdir/$name/hdr_0.bfs.1"
  assert_file "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"
  assert_file "${PV_LOCALDIR[2]}/$name/hdr_2.bfs.1"

  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  # Correctness proof: wipe .bfs and recover from a SIBLING (p1). Its sidecar's
  # location map must already point p0 at the new path, so the recovery read-path
  # (which must prefer the sidecar over the stale in-shard header) rebuilds a
  # config that pulls successfully from the moved storage.
  rm -rf "$vault/.bfs"
  run_bfs "$vault" recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")" --trust-locations
  assert_ok
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
