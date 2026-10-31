#ifndef HAZEL_WASM_STDIO_H
#define HAZEL_WASM_STDIO_H
#include <stddef.h>
int snprintf(char *, size_t, const char *, ...);
int sscanf(const char *, const char *, ...);
#endif
