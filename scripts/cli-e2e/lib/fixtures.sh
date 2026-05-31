# shellcheck shell=bash
# Test fixtures: a varied directory tree exercising text, binary, empty files,
# nested directories and a Unicode filename. Content is fixed (except the random
# binary blob, which is snapshotted as a baseline right after creation), so the
# byte-for-byte roundtrip check is meaningful.

# make_fixtures <dir> — populate a fresh source tree.
make_fixtures() {
  local d="$1"
  mkdir -p "$d/data" "$d/nested/deep" "$d/assets"
  printf 'hello world\n' >"$d/hello.txt"
  printf '# Readme\n\nBFS CLI end-to-end fixture.\n' >"$d/readme.md"
  : >"$d/empty.txt"
  printf 'id,name,value\n1,alpha,100\n2,beta,200\n3,gamma,300\n' >"$d/data/numbers.csv"
  printf '{\n  "name": "fixture",\n  "nested": { "ok": true, "n": 42 }\n}\n' >"$d/data/config.json"
  printf 'deeply nested note\n' >"$d/nested/deep/note.txt"
  printf 'zażółć gęślą jaźń\n' >"$d/zażółć gęślą jaźń.txt"
  head -c 4096 /dev/urandom >"$d/assets/blob.bin"
}

# make_large_file <dir> <bytes> — add a larger binary file (integrity / chunking
# coverage, e.g. over FTP). Uses /dev/urandom; baseline snapshot captures it.
make_large_file() {
  local d="$1" bytes="$2"
  mkdir -p "$d/assets"
  head -c "$bytes" /dev/urandom >"$d/assets/large.bin"
}

# mutate_fixtures <dir> — change an existing file and add a new one, to produce
# a distinct next version.
mutate_fixtures() {
  local d="$1"
  printf 'hello world (edited)\n' >"$d/hello.txt"
  printf 'brand new file in v2\n' >"$d/new-file.txt"
}
