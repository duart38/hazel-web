#ifndef HAZEL_WASM_STRING_H
#define HAZEL_WASM_STRING_H
#include <stddef.h>
void *memset(void *, int, size_t);
void *memcpy(void *, const void *, size_t);
void *memmove(void *, const void *, size_t);
char *strchr(const char *, int);
size_t strlen(const char *);
int strcmp(const char *, const char *);
int strncmp(const char *, const char *, size_t);
#endif
