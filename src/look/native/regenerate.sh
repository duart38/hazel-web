#!/bin/sh
# Rebuilds web/src/look/testdata from look.c compiled natively. The committed pictures and tables
# come from the correctly rounded maths build (cr_math.h), which look.wasm matches bit for bit;
# `./regenerate.sh apple DIR` writes the same files from Apple's own libm into DIR instead, for
# comparing the two. Needs the recipe collection next to this repo (../Hazel-film-recipes) or
# COLLECTION=<its recipes folder>.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
# look-engine/ sits at the top of the hazel-web repository, one folder further up in the
# project this app is developed in
engine="$here/../../../look-engine"
[ -f "$engine/look.c" ] || engine="$here/../../../../look-engine"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
flags="-std=c99 -O2 -ffp-contract=off -I$engine"
if [ "${1:-}" = apple ]; then
  clang $flags -o "$work/native_dump" "$here/native_dump.c" "$engine/look.c" -lm
  DUMP="$work/native_dump" OUT_DIR="$2" python3 "$here/make_goldens.py"
else
  clang $flags -include "$here/cr_math.h" -o "$work/native_dump" "$here/native_dump.c" "$engine/look.c" -lm
  DUMP="$work/native_dump" python3 "$here/make_goldens.py"
fi
