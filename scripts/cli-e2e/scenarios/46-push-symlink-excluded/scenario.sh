# shellcheck shell=bash
# Symlinks and special files must not be silently dropped from a backup.
#
# A directory holding a symlink (to a file and to a subdirectory) is packed by
# `bfs push`. Because a symlink / special file can never be represented in a blob
# (a link may be a loop; a device is not a file), push MUST refuse in
# non-interactive mode with a dedicated exit code (3), list the offending paths,
# and suggest .bfsignore - instead of silently excluding them (the pre-fix bug).
# `--allow-excluded` waives the refusal: the backup is created without them and a
# SHA-256 roundtrip of the regular files still holds.
#
# POSIX-only: creating a real symlink needs admin/developer mode on Windows, so
# the scenario self-skips (returns PASS) when symlinks are unavailable.

SCENARIO_NAME="push aborts on symlink/special (exit 3) unless --allow-excluded"
SCENARIO_DESC="symlink in source -> push exit 3 + list; --allow-excluded -> roundtrip without it"
REQUIRES_LOCAL=3
REQUIRES_FTP=0

scenario_run() {
  local vault="$SC_DIR/vault" base="$SC_DIR/baseline.txt" name="bfs46"

  # POSIX guard: skip cleanly where a real symlink cannot be created.
  case "$(uname -s 2>/dev/null)" in
    MINGW* | MSYS* | CYGWIN*)
      echo "  (skip) symlinks require admin/developer mode on Windows"
      return 0
      ;;
  esac

  make_fixtures "$vault"
  build_pool "$SC_DIR" 3 0 "$name"

  run_bfs "$vault" init "$name" --ci --no-enc \
    --data-shards 2 --parity-shards 1 "${PROVIDER_ARGS[@]}"
  assert_ok
  assert_file "$vault/.bfs/config.json"

  snapshot_hashes "$vault" "$base"

  # A symlink to a file and a symlink to a directory (data/ from make_fixtures).
  ln -s hello.txt "$vault/linkfile.txt" 2>/dev/null || true
  ln -s data "$vault/linkdir" 2>/dev/null || true
  if [ ! -L "$vault/linkfile.txt" ] || [ ! -L "$vault/linkdir" ]; then
    echo "  (skip) symlinks unavailable on this filesystem"
    return 0
  fi

  # Non-interactive push must abort with exit 3 and name the excluded entries.
  run_bfs "$vault" push --new
  assert_exit 3
  assert_out_contains "linkfile.txt"
  assert_out_contains "linkdir"
  assert_out_contains ".bfsignore"
  assert_no_file "$(shard_file 0 1)"

  # --allow-excluded waives the refusal: backup is created without the symlinks.
  run_bfs "$vault" push --new --allow-excluded
  assert_ok
  assert_out_contains "healthy"
  assert_manifest_health "$vault" 1 healthy
  assert_file "$(shard_file 0 1)"

  # Full restore over the working tree: regular files come back byte-for-byte.
  # find -type f skips symlinks, so the baseline never included them.
  run_bfs "$vault" pull --force --yes
  assert_ok
  assert_restored "$vault" "$base"
}
