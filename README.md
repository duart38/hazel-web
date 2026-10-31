# Hazel in the browser

The app for Hazel, the film-look engine for the Hasselblad X1D-50c. It makes and edits film
recipes, shows your photos with them, and puts recipes on the camera's memory card. Everything
runs in your browser: your photos never leave your computer, and there is no account and no
server. It's at **https://hazel-one-weld.vercel.app**.

The Camera page also puts Hazel on the camera itself, over its USB cable (Chrome or Edge). How
that works, and how to do it from a Terminal instead, is in
[Hazel-firmware](https://github.com/duart38/Hazel-firmware). The recipes that come with the app
are in [Hazel-film-recipes](https://github.com/duart38/Hazel-film-recipes).

## What it does

- **Darkroom.** Open the card (or any folder of photos) and see every photo as a contact sheet,
  each with the look the camera had when it was taken. Try another recipe on any photo, compare
  it with the original, and export it as JPEG, or 16-bit PNG or TIFF. Raw files (.3FR) are
  developed in the browser.
- **Recipes.** Your own recipes, the ones that come with Hazel, and recently deleted ones, each
  shown on one of your photos.
- **Studio.** Make and change a recipe with a live preview on your own photo and a before/after
  split you can drag. Nothing is saved until you press Save, with undo, redo and revert.
- **Camera.** Install, update or remove Hazel on the camera over USB. Then the camera's seven
  recipe slots, C1 to C7, written straight to the card as `HAZEL/recipes/C1.txt` to `C7.txt`.

It works best in Chrome or Edge, which can open the card and write to it directly. Other browsers
open photos through a file picker and download the recipe files for you to copy onto the card.

## How it works

- **The look** is the same C code the camera runs (`look-engine/look.c`), compiled to
  WebAssembly and run on every processor core. While you drag a slider, the GPU shows a preview
  from a colour table the engine builds; when you let go, the engine renders the full photo. Its
  output is checked against the native build bit for bit (`src/look/parity.test.ts`).
- **Raw files** are opened by our own decoder (`src/raw`): the TIFF structure, Hasselblad's
  lossless compression, and developing on the GPU with WebGL2, written from the descriptions in
  dcraw and LibRaw.
- **The camera installer** (`src/camera`) speaks the camera's USB service channel through WebUSB,
  the same way Catkin's Python tools do, and follows Catkin's install steps. It downloads Hazel's
  camera files from Hazel-firmware; `HAZEL_DEV_FIRMWARE=../Hazel-firmware pnpm dev` takes them
  from a local copy instead.
- The engine's threads need a cross-origin isolated page, so the site is served with
  `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (`vercel.json`, and
  `vite.config.ts` for development).

## Running it

```sh
pnpm install
pnpm dev        # http://localhost:5173
pnpm build      # a static site in dist/
pnpm vitest run # the tests
```

`HAZEL_DEV_CARD=/Volumes/Untitled pnpm dev` serves a mounted card to the app during development.
Tests that need real raw files read them from a card's photo folder (`HAZEL_TEST_CARD`, by
default the card as a Mac mounts it) and are skipped without one. No photos are kept in this
repository.

`pnpm run build:wasm` rebuilds the engine from `look-engine/look.c`. It needs LLVM's clang and
wasm-ld (on a Mac: `brew install llvm lld`); the built `.wasm` files are committed, so the app
runs without them.

Written by Claude (Claude Code), for Duart.
