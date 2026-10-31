/* The one piece of Grand Central Dispatch look.c uses (for_bands, on __APPLE__), for the threaded
 * WebAssembly build (look-threads.wasm), where build.sh defines __APPLE__ for look.c alone. Runs
 * the iterations on this thread and on whatever helper threads have joined; see threads.c. */
#ifndef HAZEL_WASM_DISPATCH_H
#define HAZEL_WASM_DISPATCH_H
#include <stddef.h>
typedef void *dispatch_queue_t;
#define DISPATCH_APPLY_AUTO ((dispatch_queue_t)0)
void dispatch_apply_f(size_t iterations, dispatch_queue_t queue, void *context, void (*work)(void *, size_t));
#endif
