# shellcheck shell=bash
# Disaster recovery AFTER a relocate, on an encrypted (default) V2 backup.
#
# relocate runs updateLocationMaps, which rewrites EVERY shard's header for the
# affected version via provider.updateShardHeader. Recovery rebuilds the manifest
# from those shard headers (it has no local .bfs/), reading format_version and
# rs_stripe_size straight from the header. If relocate downgraded the headers to
# the legacy V1 form (format_version=1, rs_stripe_size dropped), recovery
# mis-identifies the shards as legacy V1 and pull cannot decode the V2 striped +
# per-shard-GCM payloads.
#
# A normal pull right after relocate still works (it is manifest-driven and the
# payload bytes are untouched), so the asserted sanity pull is NOT what fails —
# the failure is exclusively on the recovery-rebuilt metadata path.

SCENARIO_NAME="recovery after relocate decodes (encrypted V2)"
SCENARIO_DESC="relocate rewrites headers; recovery must still decode encrypted shards"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs33" encpw="enc-secret-33"
  local newdir="$SC_DIR/relocated"
  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --enc \
    --data-shards 3 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new --password "$encpw"
  assert_ok
  assert_manifest_contains "$vault" 1 '"encrypted": true'

  # Relocate p0 → triggers updateLocationMaps, rewriting every shard's header.
  mkdir -p "$newdir"
  mv "${PV_LOCALDIR[0]}/$name" "$newdir/"
  run_bfs "$vault" provider remove p0 \
    --strategy relocate --path "$(winpath "$newdir")" --yes --password "$encpw"
  assert_ok

  # Sanity: manifest-driven pull still restores — this is NOT the failure.
  run_bfs "$vault" pull --force --yes --password "$encpw"
  assert_ok
  assert_restored "$vault" "$base"

  # Catastrophe: lose .bfs/. Recovery must rebuild the manifest from the shard
  # headers that relocate rewrote.
  rm -rf "$vault/.bfs"
  assert_no_file "$vault/.bfs/config.json"

  # Bootstrap from p1 (untouched path; its header was rewritten in place by the
  # relocate's updateLocationMaps). Recovery prompts once for the encryption
  # password to decrypt the location map (local providers carry no transport secret).
  local answers
  answers='[{"anchor":"Enter password for version","value":"'"$encpw"'"}]'
  run_bfs_pty "$vault" "$answers" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")"
  assert_ok
  assert_file "$vault/.bfs/manifests/v001.json"

  run_bfs "$vault" pull --force --yes --password "$encpw"
  assert_ok
  assert_restored "$vault" "$base"
}
