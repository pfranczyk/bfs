# shellcheck shell=bash
# `--ci` promises that the run asks nothing, and the promise covers the CLI's own
# questions as much as the adapter's: `prune` (which versions, then confirm),
# `provider remove` (which storage, then which strategy) and `recovery` (which
# adapter to start from). A question put in such a run never resolves - it waits
# until something kills it, which from cron is a job that never returns. So each
# of them refuses an incomplete command line instead, naming what it is short of.
#
# A real terminal is what makes this worth asserting. `run_bfs` redirects stdin
# from /dev/null and smoke spawns with a pipe, so there the run comes out
# non-interactive whatever the code does; only a PTY shows that a terminal being
# present does NOT turn a `--ci` run into one that asks. run_bfs_pty supplies no
# answers ('[]'), which is exactly the situation `--ci` describes.
#
# The weight of each block rests on `assert_exit`: a run that stops on a question
# is killed by the PTY budget and reports 124, which no exact-code assertion will
# accept. `_fail_if_prompted` sits in front of it to name WHICH question was put -
# it is a diagnosis, not the proof, so it going quiet after a rewording costs
# nothing and is not a reason to "repair" it.
#
# In every block the absence of the question is asserted BEFORE the exit code:
# a question put to the operator is the diagnosis and the exit code only its
# echo, and `_fail` exits the scenario, so an exit-code assertion placed first
# would swallow the finding. Exit codes are asserted exactly, never as
# "non-zero" - waiting on a prompt ends at the PTY timeout with code 124, which
# is the very outcome being ruled out.
#
# Every refusal names a way through, and each one is then carried out on a real
# backup - advice that cannot be executed in the state where it is printed is
# worse than none. The encrypted half exists for that reason alone: a relocate
# under `--ci` is where the missing password is discovered, so the flag named
# there has to finish the same relocate.
#
# ftp/ssh: N/A - the prompts under test are BFS's own and identical whatever the
# storage is. No Docker, no endpoints needed.

SCENARIO_NAME="--ci never reaches a CLI prompt, on a real terminal"
SCENARIO_DESC="prune and provider remove under --ci refuse an incomplete command line instead of asking on a PTY, and every flag they name completes the same work, encrypted backup included"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs113"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR" "$name" local local local

  run_bfs "$vault" init "$name" --ci --no-enc --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok

  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new
  assert_ok
  run_bfs "$vault" push --new
  assert_ok
  assert_manifest_health "$vault" 2 healthy
  assert_file "$(shard_file 0 1)"

  # -- prune with nothing named: the version picker must not open -------------
  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en --ci prune
  _fail_if_prompted "Select versions to delete" "prune --ci opened the version picker instead of refusing"
  assert_exit 1
  assert_out_contains "--keep-last"
  assert_file "$(shard_file 0 1)"

  # -- prune with versions named but no consent: the confirm must not open ----
  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en --ci prune 1
  _fail_if_prompted "Delete 1 version(s)?" "prune --ci asked the operator to confirm the deletion instead of refusing"
  assert_exit 1
  assert_out_contains "--yes"
  assert_file "$(shard_file 0 1)"

  # -- the same confirm, reached the other way: --keep-last instead of a range -
  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en --ci prune --keep-last 1
  _fail_if_prompted "Delete 1 version(s)?" "prune --ci --keep-last asked the operator to confirm the deletion instead of refusing"
  assert_exit 1
  assert_out_contains "--yes"
  assert_file "$(shard_file 0 1)"

  # -- provider remove with no storage named: the picker must not open --------
  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en --ci provider remove
  _fail_if_prompted "Which provider to remove?" "provider remove --ci opened the storage picker instead of refusing"
  assert_exit 1
  # The refusal's own words, not `provider remove` - that substring is also in
  # Commander's usage line, which prints on any malformed command line, so an
  # assertion on it passes just as well when the command breaks instead of refusing.
  assert_out_contains "cannot ask which storage to remove"

  # -- provider remove with no strategy: the strategy menu must not open ------
  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en --ci provider remove p2
  _fail_if_prompted "Choose a strategy" "provider remove --ci opened the strategy menu instead of refusing"
  assert_exit 1
  assert_out_contains "--strategy"

  # -- The advice works: prune with the flags it named deletes version 1 ------
  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en --ci prune 1 --yes
  assert_exit 0
  assert_no_file "$(shard_file 0 1)"
  assert_file "$(shard_file 0 2)"

  # -- The advice works: relocate finishes what the strategy menu would have --
  # The storage really moved - its directory is renamed, so a relocate that does
  # not take effect leaves the backup unrestorable.
  local moved="$SC_DIR/prov/p2-moved"
  mv "${PV_LOCALDIR[2]}" "$moved" || _fail "could not move p2's directory"
  PTY_TIMEOUT=25000 run_bfs_pty "$vault" '[]' --lang en --ci provider remove p2 \
    --strategy relocate --path "$(winpath "$moved")"
  assert_exit 0
  assert_manifest_health "$vault" 2 healthy

  # Restore has to come off the moved storage: drop one local part so the two
  # remaining ones must include p2's.
  rm -f "$(shard_file 0 2)"
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"

  _recovery_needs_its_bootstrap "$vault" "$base" "$name"
  _encrypted_relocate_needs_its_password
  return 0
}

# Fails when the question was actually put, and stays quiet when the run refused
# to put it. Both outcomes carry the question's own words, so the question alone
# does not separate them: the backstop behind the up-front guards quotes it
# ("... it needs an answer to: <question>"). What no rendered prompt ever says is
# "asks no questions", which every refusal opens with - guard and backstop
# alike - so its presence is what tells them apart. Deliberately matched as that
# short substring rather than the whole quote: the quote runs past the width a
# Windows ConPTY gives, which breaks it across a line and would make the check
# cry wolf about a menu that never opened.
#
# Where this stays quiet the block is still guarded: a backstop refusal names
# none of the flags the following assert_out_contains demands, so an up-front
# guard that stops naming them fails there instead - with the reading that fits.
_fail_if_prompted() {
  local question="$1" what="$2"
  if printf '%s' "$BFS_OUT" | grep -qF "asks no questions"; then return 0; fi
  if printf '%s' "$BFS_OUT" | grep -qF "$question"; then _fail "$what"; fi
  return 0
}

# `recovery` without --bootstrap has nothing to say where the first storage is,
# and that is a question in a run that answers none - so it refuses and names the
# flags instead. Runs on the backup left healthy above, so those flags can be
# carried out on the spot and the rebuilt .bfs/ has to restore byte for byte.
_recovery_needs_its_bootstrap() {
  local vault="$1" base="$2" name="$3"

  PTY_TIMEOUT=20000 run_bfs_pty "$vault" '[]' --lang en --ci recovery
  _fail_if_prompted "Bootstrap provider type" "recovery --ci opened the adapter menu instead of refusing"
  assert_exit 1
  assert_out_contains "--bootstrap"

  # Take the named flags and rebuild .bfs/ from a single storage, then restore.
  # p1 is the bootstrap: p0 was emptied above (version 1 pruned, its part of
  # version 2 deleted to force the restore through the relocated storage).
  rm -rf "$vault/.bfs"
  PTY_TIMEOUT=40000 run_bfs_pty "$vault" '[]' --lang en --ci recovery \
    --provider local --name "$name" --trust-locations \
    --bootstrap "--path $(winpath "${PV_LOCALDIR[1]}")"
  assert_exit 0
  assert_file "$vault/.bfs/config.json"

  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}

# An encrypted backup adds a second thing the command line has to carry, and it
# is the one discovered last: the relocate hands the new address to the adapter
# and only then needs the password. Under --ci that password can never arrive,
# so the refusal has to come first and name the flag that carries it.
_encrypted_relocate_needs_its_password() {
  local vault="$SC_DIR/enc-vault" base="$SC_DIR/enc-baseline.txt" name="bfs113e" pw="e2epass113"

  make_fixtures "$vault"
  build_pool_seq "$SC_DIR/enc" "$name" local local local

  run_bfs "$vault" init "$name" --ci --no-compress \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  snapshot_hashes "$vault" "$base"
  run_bfs "$vault" push --new --password "$pw"
  assert_ok
  assert_manifest_health "$vault" 1 healthy

  local moved="$SC_DIR/enc/prov/p2-moved"
  mv "${PV_LOCALDIR[2]}" "$moved" || _fail "could not move the encrypted backup's p2 directory"

  PTY_TIMEOUT=25000 run_bfs_pty "$vault" '[]' --lang en --ci provider remove p2 \
    --strategy relocate --path "$(winpath "$moved")"
  assert_exit 1
  assert_out_contains "--password"

  PTY_TIMEOUT=40000 run_bfs_pty "$vault" '[]' --lang en --ci provider remove p2 \
    --strategy relocate --path "$(winpath "$moved")" --password "$pw"
  assert_exit 0
  assert_manifest_health "$vault" 1 healthy

  rm -f "$(shard_file 0 1)"
  find "$vault" -mindepth 1 -maxdepth 1 ! -name '.bfs' -exec rm -rf {} +
  run_bfs "$vault" pull --force --yes --password "$pw"
  assert_ok
  assert_restored "$vault" "$base"
}
