#ifndef HAZEL_WASM_STDLIB_H
#define HAZEL_WASM_STDLIB_H
#include <stddef.h>
void *malloc(size_t);
void free(void *);
int atoi(const char *);
float strtof(const char *, char **);
unsigned long strtoul(const char *, char **, int);
#endif
