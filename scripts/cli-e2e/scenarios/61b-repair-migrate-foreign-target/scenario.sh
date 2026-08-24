# shellcheck shell=bash
# bfs repair, migration form - the route a degraded restore recommends when a
# storage the backup records is missing from the configuration. The first
# argument is a storage the configuration HAS, the target is the name the backup
# records. Because no manifest carries the first argument, the identity gate of
# the migration (`verifyPairAtDestination` in src/vault/repair.ts) finds nothing
# to check and the destination is only ever probed for a file of the right NAME.
#
# A mistyped destination must not pass for a successful repair. Two mistypes,
# separated only by that name-only probe:
#   1. a folder holding no part at all - the negative control. The probe finds
#      no file of that name, so the repair is refused. What it does on the way
#      there is adopt the mistyped folder in the configuration before the
#      refusal, and never put the configuration back.
#   2. a folder holding a same-named part of a DIFFERENT backup - the probe is
#      satisfied by the name alone. The refusal must instead be recorded as an
#      identity mismatch, no address of the foreign storage may reach the
#      configuration or the location maps a later recovery follows, and nothing
#      may be written into the other backup's folder.

SCENARIO_NAME="repair: migration onto a mistyped destination is refused"
SCENARIO_DESC="3L 2/1; storage recorded in the backup missing from config; migration repair aimed at an empty folder and at a foreign backup's folder must both fail without touching either, correct one heals"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs61b"
  local cfg="$vault/.bfs/config.json" degraded="$SC_DIR/config-degraded.json"
  local lock="$vault/.bfs/repair.lock"
  local empty="$SC_DIR/typo-empty"
  local other="$SC_DIR/other-vault"
  local o0="$SC_DIR/other-prov/p0" o1="$SC_DIR/other-prov/p1" o2="$SC_DIR/other-prov/p2"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  # A second backup carrying the same name on its own storages. Its third
  # storage holds a file named exactly like the part this repair looks for, so a
  # mistyped path landing there passes a name-only check.
  mkdir -p "$other" "$o0" "$o1" "$o2"
  printf 'not this backup\n' >"$other/other.txt"
  run_bfs "$other" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 \
    --provider "local:f0 --path $(winpath "$o0")" \
    --provider "local:f1 --path $(winpath "$o1")" \
    --provider "local:f2 --path $(winpath "$o2")"
  assert_ok
  run_bfs "$other" push --new
  assert_ok
  assert_file "$o2/$name/shard_2.bfs.1"

  # The degraded shape a restore warns about: the backup records "p2", the
  # configuration calls the same storage "p2-away", so the restore skips it and
  # recommends the migration form of repair.
  node -e 'const fs=require("fs");const p=process.argv[1];const c=JSON.parse(fs.readFileSync(p,"utf8"));c.providers[2].id="p2-away";fs.writeFileSync(p,JSON.stringify(c,null,2));' "$(winpath "$cfg")"
  cp "$cfg" "$degraded"
  run_bfs "$vault" pull --force --yes
  assert_ok

  local shard0 sidecar0 sha_before
  shard0="$(shard_file 0 1)"
  sidecar0="${PV_LOCALDIR[0]}/$name/hdr_0.bfs.1"
  sha_before="$(sha256sum "$shard0" | cut -d' ' -f1)"

  # -- Mistype 1: an existing folder that holds no part of this backup --
  mkdir -p "$empty"
  run_bfs "$vault" repair --version all p2-away "local:p2 --path $(winpath "$empty")"
  assert_fail
  assert_no_file "$sidecar0"
  [ "$(sha256sum "$shard0" | cut -d' ' -f1)" = "$sha_before" ] ||
    _fail "the refused repair rewrote a sibling part: $shard0"

  # The forensic record must call the attempt a refusal, not a move.
  assert_file "$lock"
  grep -qF '"name": "p2-away"' "$lock" ||
    _fail "repair.lock does not record the refused storage p2-away:
$(cat "$lock")"
  grep -qF '"succeeded_pairs": []' "$lock" ||
    _fail "repair.lock records the refused migration among the successful ones:
$(cat "$lock")"

  # A refused repair must leave the configuration exactly as it found it: the
  # storage keeps the name the configuration gave it, and the mistyped folder
  # appears nowhere in it.
  local typo
  typo="$(winpath "$empty")"
  grep -aqF '"id": "p2-away"' "$cfg" ||
    _fail "the refused repair took the storage name out of the configuration:
$(cat "$cfg")"
  if grep -aqF "$typo" "$cfg"; then
    _fail "the configuration points at the mistyped folder after a refused repair: $typo"
  fi

  # Back to the degraded shape for the second mistype: the pair must again name
  # a storage no manifest knows, and the forensics of the first attempt are read.
  cp "$degraded" "$cfg"
  rm -f "$lock"

  # -- Mistype 2: a folder holding a same-named part of ANOTHER backup --
  run_bfs "$vault" repair --version all p2-away "local:p2 --path $(winpath "$o2")"
  assert_fail

  # The refusal has to name its cause. Failing for any other reason - a folder
  # that cannot be reached, an argument that will not parse - satisfies an
  # exit-code-only check while leaving a foreign backup an acceptable target.
  assert_file "$lock"
  grep -qF '"reason": "mismatch"' "$lock" ||
    _fail "repair.lock does not attribute the refusal to a foreign backup:
$(cat "$lock")"

  # A repair that was refused may not have written into the other backup's
  # folder: its part stands alone, with no location-header sidecar beside it.
  assert_no_file "$o2/$name/hdr_2.bfs.1"

  assert_no_file "$sidecar0"
  [ "$(sha256sum "$shard0" | cut -d' ' -f1)" = "$sha_before" ] ||
    _fail "the refused repair rewrote a sibling part: $shard0"

  # Nothing BFS later follows - the configuration, the surviving parts and their
  # location-header sidecars - may record the foreign storage.
  local target f
  target="$(winpath "$o2")"
  if grep -aqF "$target" "$cfg"; then
    _fail "the configuration points at the foreign storage after a refused repair: $target"
  fi
  for f in "$(shard_file 0 1)" "$(shard_file 1 1)" \
    "${PV_LOCALDIR[0]}/$name/hdr_0.bfs.1" "${PV_LOCALDIR[1]}/$name/hdr_1.bfs.1"; do
    [ -f "$f" ] || continue
    if grep -aqF "$target" "$f"; then
      _fail "a location map points at the foreign storage after a refused repair: $f"
    fi
  done

  # The recommended route still leads home once the destination is right.
  rm -f "$lock"
  run_bfs "$vault" repair --version all p2-away "local:p2 --path $(winpath "${PV_LOCALDIR[2]}")"
  assert_ok
  run_bfs "$vault" verify
  assert_ok
  assert_manifest_health "$vault" 1 healthy
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
