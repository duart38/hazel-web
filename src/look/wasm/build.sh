#!/bin/sh
# Builds look.wasm and look-threads.wasm from look-engine/look.c (unchanged, shared with the
# camera) and runtime.c, with Homebrew's clang and wasm-ld: no Emscripten, no libc. The float
# maths is our own (include/hz_math.h), with JavaScript's Math for the rare arguments it can't
# round with certainty (wasm.ts). -ffp-contract=off keeps every multiply and add separately
# rounded, as on the camera. Run from anywhere: `pnpm run build:wasm`.
#
# look-threads.wasm is the same engine on a shared, imported memory with atomics: look.c is
# compiled with __APPLE__ defined, so its for_bands goes through dispatch_apply_f, which
# threads.c runs on helper threads (see threads.ts). It needs a cross-origin isolated page.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
# look-engine/ sits at the top of the hazel-web repository, one folder further up in the
# project this app is developed in
engine="$here/../../../look-engine"
[ -f "$engine/look.c" ] || engine="$here/../../../../look-engine"
clang="${CLANG:-/opt/homebrew/opt/llvm/bin/clang}"
wasm_ld="${WASM_LD:-/opt/homebrew/bin/wasm-ld}"
out_dir="${OUT_DIR:-$here}"
strip="-Wl,--strip-all"
[ -n "${KEEP_NAMES:-}" ] && strip=""
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

exports="look_defaults look_parse look_format look_is_mono look_pixel look_build_rgb_table
  look_table_apply look_apply_image look_mix_band_name look_grade_colour look_mix_band_colour
  malloc free hz_alloc_failed"
export_flags=""
for name in $exports; do export_flags="$export_flags -Wl,--export=$name"; done

cflags="--target=wasm32 -std=c99 -O3 -ffp-contract=off -ffreestanding -nostdlib -nostdlibinc
  -mbulk-memory -mnontrapping-fptoint -msimd128 -isystem $here/include -I $engine
  -Wall -Wextra -Werror -Wno-unused-function -Wno-unused-variable"
ldflags="-fuse-ld=$wasm_ld -Wl,--no-entry $strip -Wl,-z,stack-size=1048576
  -Wl,--initial-memory=4194304 -Wl,--max-memory=4294967296"

# shellcheck disable=SC2086
"$clang" $cflags $ldflags $export_flags -o "$out_dir/look.wasm" "$engine/look.c" "$here/runtime.c"
echo "$out_dir/look.wasm: $(wc -c < "$out_dir/look.wasm" | tr -d ' ') bytes"

# shellcheck disable=SC2086
{
  "$clang" $cflags -matomics -D__APPLE__=1 -c -o "$work/look.o" "$engine/look.c"
  "$clang" $cflags -matomics -c -o "$work/runtime.o" "$here/runtime.c"
  "$clang" $cflags -matomics -c -o "$work/threads.o" "$here/threads.c"
  "$clang" --target=wasm32 -nostdlib $ldflags -Wl,--import-memory -Wl,--shared-memory \
    $export_flags -Wl,--export=hz_helper_main -Wl,--export=__stack_pointer \
    -o "$out_dir/look-threads.wasm" "$work/look.o" "$work/runtime.o" "$work/threads.o"
}
echo "$out_dir/look-threads.wasm: $(wc -c < "$out_dir/look-threads.wasm" | tr -d ' ') bytes"
