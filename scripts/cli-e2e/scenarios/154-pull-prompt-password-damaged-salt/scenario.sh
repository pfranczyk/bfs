# shellcheck shell=bash
# A version recovery left marked is restored later with `bfs pull --version N`,
# and at a terminal without --password the operator types its password at the
# prompt. Every part of one version carries the same salt, so the typed password
# can be judged on any of them, and two things follow from that:
#
# - a medium is named as unable to supply the location map only when the
#   password that opened the version did not open its part; parts that merely
#   refused an empty or wrong pool are not at fault;
# - judged on the first part alone, a bit-rot in that part's salt turns the
#   correct password into "wrong" - over and over, with the healthy siblings
#   that would open right next to it - and the version cannot be restored by
#   typing its password at the terminal.
#
# Binding assertions: v2 (all parts intact) restores with the typed password and
# no medium is named; v3 (first part's salt rotted) restores with the correct
# password typed once, no "wrong password" prompt appears, and only the damaged
# part's storage is named; a wrong password is still refused and leaves the
# marker untouched. Every restore is checked by SHA-256 against the snapshot
# taken before that version was pushed.

SCENARIO_NAME="pull: password typed at the prompt is judged on every part, and only a part it cannot open is named"
SCENARIO_DESC="encrypted 2/2; v2 and v3 marked by recovery; v2 intact, p1 v3 salt rotted; pull at a PTY with the typed password"
REQUIRES_LOCAL=4
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base_v2="$SC_DIR/baseline-v2.txt" base_v3="$SC_DIR/baseline-v3.txt" name="bfs154"
  local pw_old="old-secret-154" pw_new="new-secret-154"
  local corrupt_driver v
  corrupt_driver="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../lib" && pwd)/corrupt-shard-header.ts"

  make_fixtures "$vault"
  build_pool "$SC_DIR" 4 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 2 "${PROVIDER_ARGS[@]}"
  assert_ok

  run_bfs "$vault" push --new --password "$pw_old"   # v1
  assert_ok
  mutate_fixtures "$vault"
  snapshot_hashes "$vault" "$base_v2"
  run_bfs "$vault" push --new --password "$pw_new"   # v2, rotated password
  assert_ok
  printf 'third version\n' >"$vault/third.txt"
  snapshot_hashes "$vault" "$base_v3"
  run_bfs "$vault" push --new --password "$pw_new"   # v3
  assert_ok

  # The storage bootstrap reads from never received v2 or v3, so recovery opens
  # v1 and leaves both marked.
  rm -f "$(shard_file 0 2)" "$(shard_file 0 3)"
  rm -rf "$vault/.bfs"
  run_bfs "$vault" --lang en recovery --provider local --name "$name" \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[0]}")" --password "$pw_old" --trust-locations
  assert_ok
  for v in 2 3; do
    if [ "$(tr -d ' \n\r\t' < "$vault/.bfs/manifests/v00$v.json")" != "{}" ]; then
      _fail "expected v00$v to be an unrecovered-version marker, got: $(cat "$vault/.bfs/manifests/v00$v.json")"
    fi
  done

  # -- v2, every part intact: the typed password opens it, nothing is named -----
  local answers_v2="[{\"anchor\":\"Enter the password for version 2\",\"value\":\"$pw_new\"},{\"anchor\":\"Wrong password. Try again for version 2\",\"value\":\"\"}]"
  wipe_working_tree "$vault"
  run_bfs_pty "$vault" "$answers_v2" --lang en pull --version 2 --force --yes
  assert_ok
  assert_restored "$vault" "$base_v2"
  assert_out_contains "PROMPTS_FED=1/2"
  # Kept for the check on naming at the end: the restore paths below are
  # executed first, so a path that does not work is reported as such rather
  # than hidden behind a sentence printed in the wrong place.
  local v2_out="$BFS_OUT"

  # -- v3, first part's salt rotted ---------------------------------------------
  # Rot the salt of the first v3 part pull will read (p0 has none): the header
  # still parses, but the key derived from the correct password does not open
  # this part's map. p2 and p3 carry the version's real salt - and N=2 parts.
  BFS_OUT="$("$TSX" "$(winpath "$corrupt_driver")" "$(winpath "$(shard_file 1 3)")" --kdf-salt 2>&1)" || true
  if ! printf '%s' "$BFS_OUT" | grep -qF "HEADER-CORRUPTED mode=kdf-salt"; then
    _fail "corrupt-shard-header driver did not report a kdf-salt corruption: $BFS_OUT"
  fi

  # A wrong password is still refused - after the retry prompt, not before it -
  # and leaves the marker as it was.
  local wrong_answers='[{"anchor":"Enter the password for version 3","value":"wrong-secret-154"},{"anchor":"Wrong password. Try again for version 3","value":""}]'
  run_bfs_pty "$vault" "$wrong_answers" --lang en pull --version 3 --force --yes
  assert_exit 1
  assert_out_contains "Wrong password. Try again for version 3"
  assert_out_contains "PROMPTS_FED=2/2"
  assert_out_contains "Version 3 has not been restored on this machine yet, so its password is needed"
  if [ "$(tr -d ' \n\r\t' < "$vault/.bfs/manifests/v003.json")" != "{}" ]; then
    _fail "a refused password must leave the marker untouched, got: $(cat "$vault/.bfs/manifests/v003.json")"
  fi

  # The correct password, typed once, restores the version. The retry answer is
  # blank so a prompt judged against the damaged part ends the command at once
  # instead of hanging on it.
  local answers_v3="[{\"anchor\":\"Enter the password for version 3\",\"value\":\"$pw_new\"},{\"anchor\":\"Wrong password. Try again for version 3\",\"value\":\"\"}]"
  wipe_working_tree "$vault"
  run_bfs_pty "$vault" "$answers_v3" --lang en pull --version 3 --force --yes
  if printf '%s' "$BFS_OUT" | grep -qF "Wrong password"; then
    _fail "pull told the operator the correct password is wrong - it was judged against the damaged part:
$BFS_OUT"
  fi
  assert_ok
  assert_restored "$vault" "$base_v3"
  assert_manifest_contains "$vault" 3 '"shards"'
  assert_out_contains "PROMPTS_FED=1/2"

  # Only the part whose map did not open is named - by its storage.
  assert_out_contains "Version 3: location map recovered from a sibling - medium(s) ${PV_ID[1]} could not supply it"

  # v2: every part is intact, so no medium may be named at all.
  if printf '%s' "$v2_out" | grep -qF "location map recovered from a sibling"; then
    _fail "every v2 part is intact, yet pull named media as unable to supply the location map:
$v2_out"
  fi
  return 0
}
