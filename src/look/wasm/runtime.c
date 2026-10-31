/* The few C library pieces look.c needs, for its freestanding WebAssembly build: a heap that
 * grows the WebAssembly memory, string helpers, and the number parsing and printing behind
 * look_parse and look_format. Printing matches Apple's and glibc's printf exactly for what
 * look_format writes (%.1f and %.3f are rounded from the exact binary value, ties to even). */
#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>

#include "look.h"

/* The TypeScript side (src/look/recipe.ts) reads and writes look_recipe by these offsets. */
_Static_assert(sizeof(look_recipe) == 228, "look_recipe size");
_Static_assert(offsetof(look_recipe, film) == 4, "film");
_Static_assert(offsetof(look_recipe, mono_red) == 8, "mono_red");
_Static_assert(offsetof(look_recipe, contrast) == 20, "contrast");
_Static_assert(offsetof(look_recipe, halation) == 104, "halation");
_Static_assert(offsetof(look_recipe, grade_shadow_hue) == 108, "grade_shadow_hue");
_Static_assert(offsetof(look_recipe, grade_balance) == 124, "grade_balance");
_Static_assert(offsetof(look_recipe, mix_hue) == 128, "mix_hue");
_Static_assert(offsetof(look_recipe, mix_saturation) == 160, "mix_saturation");
_Static_assert(offsetof(look_recipe, mix_lightness) == 192, "mix_lightness");
_Static_assert(offsetof(look_recipe, seed) == 224, "seed");

/* ---- heap ------------------------------------------------------------------------------------
 * Blocks side by side from __heap_base, each with a 16-byte header. First fit, free neighbours
 * merged when a search walks over them. look_apply_image makes a handful of large allocations
 * and a few hundred small short-lived ones, so a walk is cheap. When memory can't grow, malloc
 * returns null (look.c then skips that effect) and hz_alloc_failed says so, so the caller can
 * report it rather than show a picture missing an effect. */

extern unsigned char __heap_base;

typedef struct { uint32_t size, used, pad0, pad1; } block;  /* size: payload bytes, multiple of 16 */
#define HEADER ((uint32_t)sizeof(block))
#define PAGE 65536u
#define MAX_END 0xFFFF0000ull

static uint64_t heap_start, heap_end;  /* heap_end: one past the last block */
static int alloc_failed;

static void heap_init(void) {
    if (heap_start) return;
    heap_start = ((uint64_t)(uintptr_t)&__heap_base + 15u) & ~15ull;
    heap_end = heap_start;
}

static int ensure_memory(uint64_t end) {
    uint64_t have = (uint64_t)__builtin_wasm_memory_size(0) * PAGE;
    if (end <= have) return 1;
    if (end > MAX_END) return 0;
    uint64_t pages = (end - have + PAGE - 1) / PAGE;
    return __builtin_wasm_memory_grow(0, (size_t)pages) != (size_t)-1;
}

static block *at(uint64_t address) { return (block *)(uintptr_t)address; }

/* In look-threads.wasm helper threads allocate too (a blur's padded row), so the heap takes a
 * lock there: a spin, as the heap's work under it is short. */
#if defined(__wasm_atomics__)
static _Atomic int heap_lock;
static void heap_acquire(void) {
    int unlocked = 0;
    while (!__c11_atomic_compare_exchange_weak(&heap_lock, &unlocked, 1, __ATOMIC_ACQUIRE, __ATOMIC_RELAXED)) unlocked = 0;
}
static void heap_release(void) { __c11_atomic_store(&heap_lock, 0, __ATOMIC_RELEASE); }
#else
static void heap_acquire(void) {}
static void heap_release(void) {}
#endif

static void *allocate(size_t n);
static void release(void *p);

void *malloc(size_t n) {
    heap_acquire();
    void *p = allocate(n);
    heap_release();
    return p;
}

void free(void *p) {
    if (!p) return;
    heap_acquire();
    release(p);
    heap_release();
}

static void *allocate(size_t n) {
    heap_init();
    uint64_t want = ((uint64_t)n + 15u) & ~15ull;
    if (want == 0) want = 16;
    if (want > MAX_END) { alloc_failed = 1; return 0; }
    uint64_t address = heap_start;
    while (address < heap_end) {
        block *b = at(address);
        if (!b->used) {
            /* merge the free blocks that follow */
            uint64_t next = address + HEADER + b->size;
            while (next < heap_end && !at(next)->used) {
                b->size += HEADER + at(next)->size;
                next = address + HEADER + b->size;
            }
            if (next >= heap_end) {
                /* the last block: grow it to fit */
                if (b->size < want) {
                    if (!ensure_memory(address + HEADER + want)) { alloc_failed = 1; return 0; }
                    b->size = (uint32_t)want;
                    heap_end = address + HEADER + want;
                }
            }
            if (b->size >= want) {
                if (b->size - want >= 2 * HEADER) {
                    block *rest = at(address + HEADER + want);
                    rest->size = b->size - (uint32_t)want - HEADER;
                    rest->used = 0;
                    b->size = (uint32_t)want;
                }
                b->used = 1;
                return (void *)(uintptr_t)(address + HEADER);
            }
        }
        address += HEADER + b->size;
    }
    if (!ensure_memory(heap_end + HEADER + want)) { alloc_failed = 1; return 0; }
    block *b = at(heap_end);
    b->size = (uint32_t)want;
    b->used = 1;
    heap_end += HEADER + want;
    return (void *)(uintptr_t)((uint64_t)(uintptr_t)b + HEADER);
}

static void release(void *p) {
    uint64_t address = (uint64_t)(uintptr_t)p - HEADER;
    block *b = at(address);
    b->used = 0;
    if (address + HEADER + b->size == heap_end) heap_end = address;
    /* a free block now at the end gives its place back too */
    while (heap_end > heap_start) {
        uint64_t last = heap_start, a = heap_start;
        while (a < heap_end) { last = a; a += HEADER + at(a)->size; }
        if (at(last)->used) break;
        heap_end = last;
    }
}

/* Reading and clearing the out-of-memory flag, for the TypeScript side. */
int hz_alloc_failed(void) {
    int failed = alloc_failed;
    alloc_failed = 0;
    return failed;
}

/* ---- memory and strings --------------------------------------------------------------------- */

void *memset(void *d, int c, size_t n) {
    __builtin_memset(d, c, n);  /* memory.fill (bulk memory) */
    return d;
}
void *memcpy(void *d, const void *s, size_t n) {
    __builtin_memcpy(d, s, n);  /* memory.copy */
    return d;
}
void *memmove(void *d, const void *s, size_t n) {
    __builtin_memmove(d, s, n);
    return d;
}

size_t strlen(const char *s) {
    const char *p = s;
    while (*p) p++;
    return (size_t)(p - s);
}

char *strchr(const char *s, int c) {
    for (;; s++) {
        if (*s == (char)c) return (char *)s;
        if (!*s) return 0;
    }
}

int strcmp(const char *a, const char *b) {
    while (*a && *a == *b) a++, b++;
    return (unsigned char)*a - (unsigned char)*b;
}

int strncmp(const char *a, const char *b, size_t n) {
    for (; n; n--, a++, b++) {
        if (*a != *b) return (unsigned char)*a - (unsigned char)*b;
        if (!*a) return 0;
    }
    return 0;
}

static int is_space(int c) { return c == ' ' || (c >= '\t' && c <= '\r'); }
static int is_digit(int c) { return c >= '0' && c <= '9'; }
static int lower(int c) { return c >= 'A' && c <= 'Z' ? c + 32 : c; }

int atoi(const char *s) {
    while (is_space(*s)) s++;
    int negative = *s == '-';
    if (*s == '-' || *s == '+') s++;
    unsigned value = 0;
    while (is_digit(*s)) value = value * 10u + (unsigned)(*s++ - '0');
    return negative ? -(int)value : (int)value;
}

/* Base 10 only (all look.c asks for). Read as 64 bits, like the Mac's (LP64) strtoul, then cut
 * to 32: "seed = 4294967296" is 0 there and here. (The camera's 32-bit strtoul saturates to
 * 4294967295 instead; the app only ever writes seeds that fit.) */
unsigned long strtoul(const char *s, char **end, int base) {
    (void)base;
    const char *start = s;
    while (is_space(*s)) s++;
    int negative = *s == '-';
    if (*s == '-' || *s == '+') s++;
    if (!is_digit(*s)) {
        if (end) *end = (char *)start;
        return 0;
    }
    uint64_t value = 0;
    int overflow = 0;
    while (is_digit(*s)) {
        unsigned digit = (unsigned)(*s++ - '0');
        if (value > 1844674407370955161ull || (value == 1844674407370955161ull && digit > 5)) overflow = 1;
        else value = value * 10u + digit;
    }
    if (end) *end = (char *)s;
    if (overflow) return (unsigned long)UINT64_MAX;
    return (unsigned long)(negative ? 0 - value : value);
}

/* ---- strtof ----------------------------------------------------------------------------------
 * Decimal text to the nearest float. Up to 7 significant digits and powers of ten up to 10^10
 * (every recipe value) take the exact path: both numbers are exact floats, so one float
 * multiply or divide rounds once, correctly. Longer numbers go through double, which is right
 * except for text constructed to sit on a float's rounding boundary. Hexadecimal floats are not
 * read (the "0" before the x is). */

static const double POW10[] = {1e0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11,
                               1e12, 1e13, 1e14, 1e15, 1e16, 1e17, 1e18, 1e19, 1e20, 1e21, 1e22};

static double scale10(double x, int e) {
    while (e > 22) { x *= 1e22; e -= 22; }
    while (e < -22) { x /= 1e22; e += 22; }
    return e >= 0 ? x * POW10[e] : x / POW10[-e];
}

static int match_word(const char *s, const char *word) {
    int n = 0;
    while (word[n]) {
        if (lower(s[n]) != word[n]) return 0;
        n++;
    }
    return n;
}

float strtof(const char *s, char **end) {
    const char *start = s;
    while (is_space(*s)) s++;
    int negative = *s == '-';
    if (*s == '-' || *s == '+') s++;

    int n;
    if ((n = match_word(s, "inf"))) {
        s += n;
        if ((n = match_word(s, "inity"))) s += n;
        if (end) *end = (char *)s;
        return negative ? -__builtin_inff() : __builtin_inff();
    }
    if ((n = match_word(s, "nan"))) {
        s += n;
        if (*s == '(') {
            const char *p = s + 1;
            while (is_digit(*p) || (lower(*p) >= 'a' && lower(*p) <= 'z') || *p == '_') p++;
            if (*p == ')') s = p + 1;
        }
        if (end) *end = (char *)s;
        return negative ? -__builtin_nanf("") : __builtin_nanf("");
    }

    uint64_t mantissa = 0;
    int digits = 0, exponent = 0, seen_digit = 0, seen_point = 0, dropped = 0;
    for (;; s++) {
        if (*s == '.' && !seen_point) {
            seen_point = 1;
            continue;
        }
        if (!is_digit(*s)) break;
        seen_digit = 1;
        int d = *s - '0';
        if (mantissa == 0 && d == 0) {
            if (seen_point) exponent--;
        } else if (digits < 19) {
            mantissa = mantissa * 10u + (uint64_t)d;
            digits++;
            if (seen_point) exponent--;
        } else {
            if (d) dropped = 1;
            if (!seen_point) exponent++;
        }
    }
    if (!seen_digit) {
        if (end) *end = (char *)start;
        return 0.f;
    }
    if (lower(*s) == 'e') {
        const char *e = s + 1;
        int e_negative = *e == '-';
        if (*e == '-' || *e == '+') e++;
        if (is_digit(*e)) {
            int value = 0;
            while (is_digit(*e)) {
                if (value < 100000) value = value * 10 + (*e - '0');
                e++;
            }
            exponent += e_negative ? -value : value;
            s = e;
        }
    }
    if (end) *end = (char *)s;

    float result;
    if (mantissa == 0) {
        result = 0.f;
    } else if (!dropped && mantissa < (1u << 24) && exponent >= -10 && exponent <= 10) {
        float m = (float)mantissa, p = (float)POW10[exponent < 0 ? -exponent : exponent];
        result = exponent < 0 ? m / p : m * p;
    } else if (exponent > 60) {
        result = __builtin_inff();
    } else if (exponent + digits < -60) {
        result = 0.f;
    } else {
        result = (float)scale10((double)mantissa, exponent);
    }
    return negative ? -result : result;
}

/* ---- sscanf: whitespace, literal characters, %f and %<width>s ------------------------------- */

int sscanf(const char *s, const char *format, ...) {
    va_list args;
    va_start(args, format);
    int assigned = 0;
    const char *f = format;
    while (*f) {
        if (is_space(*f)) {
            while (is_space(*f)) f++;
            while (is_space(*s)) s++;
            continue;
        }
        if (*f != '%') {
            if (*s != *f) break;
            s++, f++;
            continue;
        }
        f++;
        int width = 0;
        while (is_digit(*f)) width = width * 10 + (*f++ - '0');
        if (*f == 'f') {
            f++;
            char *after;
            float value = strtof(s, &after);
            if (after == s) {
                if (!*s && assigned == 0) assigned = -1;
                break;
            }
            *va_arg(args, float *) = value;
            assigned++;
            s = after;
        } else if (*f == 's') {
            f++;
            while (is_space(*s)) s++;
            if (!*s) {
                if (assigned == 0) assigned = -1;
                break;
            }
            char *out = va_arg(args, char *);
            int n = 0;
            while (*s && !is_space(*s) && (width == 0 || n < width)) out[n++] = *s++;
            out[n] = 0;
            assigned++;
        } else {
            break;
        }
    }
    va_end(args);
    return assigned;
}

/* ---- snprintf: %s, %d, %u, %.<p>f and %% ----------------------------------------------------- */

typedef struct { char *out; size_t size, n; } sink;

static void put(sink *k, char c) {
    if (k->n + 1 < k->size) k->out[k->n] = c;
    k->n++;
}

static void put_string(sink *k, const char *s) {
    while (*s) put(k, *s++);
}

static void put_unsigned(sink *k, uint64_t v) {
    char digits[24];
    int n = 0;
    do digits[n++] = (char)('0' + v % 10u), v /= 10u;
    while (v);
    while (n) put(k, digits[--n]);
}

/* A non-negative integer of up to 40 32-bit limbs, least significant first: enough for any double
 * times 10^9. Plain limb arithmetic, so printing is exact for every double. */
#define LIMBS 40
typedef struct { uint32_t limb[LIMBS]; int n; } big;

static void big_mul_small(big *a, uint32_t factor) {
    uint64_t carry = 0;
    for (int i = 0; i < a->n; i++) {
        uint64_t v = (uint64_t)a->limb[i] * factor + carry;
        a->limb[i] = (uint32_t)v;
        carry = v >> 32;
    }
    if (carry && a->n < LIMBS) a->limb[a->n++] = (uint32_t)carry;
}

static int big_is_zero(const big *a) {
    for (int i = 0; i < a->n; i++)
        if (a->limb[i]) return 0;
    return 1;
}

/* a <<= bits */
static void big_shift_left(big *a, int bits) {
    int words = bits / 32, rest = bits % 32;
    big out = {{0}, 0};
    out.n = a->n + words + 1;
    if (out.n > LIMBS) out.n = LIMBS;
    for (int i = 0; i < a->n; i++) {
        uint64_t v = (uint64_t)a->limb[i] << rest;
        if (i + words < LIMBS) out.limb[i + words] |= (uint32_t)v;
        if (i + words + 1 < LIMBS) out.limb[i + words + 1] |= (uint32_t)(v >> 32);
    }
    *a = out;
}

/* bit `index` of a */
static int big_bit(const big *a, int index) {
    int word = index / 32;
    return word < a->n ? (int)((a->limb[word] >> (index % 32)) & 1u) : 0;
}

/* a >>= bits, rounded to the nearest, ties to even */
static void big_shift_right_round(big *a, int bits) {
    int half = bits > 0 ? big_bit(a, bits - 1) : 0, below = 0;
    for (int i = 0; i < bits - 1 && !below; i++) below = big_bit(a, i);
    int words = bits / 32, rest = bits % 32;
    big out = {{0}, 0};
    for (int i = words; i < a->n; i++) {
        uint64_t v = a->limb[i] >> rest;
        if (rest && i + 1 < a->n) v |= (uint64_t)a->limb[i + 1] << (32 - rest);
        out.limb[i - words] = (uint32_t)v;
    }
    out.n = a->n > words ? a->n - words : 0;
    *a = out;
    if (half && (below || big_bit(a, 0))) {
        for (int i = 0; i < LIMBS; i++) {
            if (i == a->n) a->limb[a->n++] = 0;
            if (++a->limb[i]) break;
        }
    }
}

/* a /= 10, returning the remainder */
static uint32_t big_div10(big *a) {
    uint64_t rest = 0;
    for (int i = a->n - 1; i >= 0; i--) {
        uint64_t v = (rest << 32) | a->limb[i];
        a->limb[i] = (uint32_t)(v / 10u);
        rest = v % 10u;
    }
    while (a->n && !a->limb[a->n - 1]) a->n--;
    return (uint32_t)rest;
}

/* x with p decimals, rounded from x's exact binary value to the nearest, ties to even: what
 * Apple's and glibc's printf do. */
static void put_fixed(sink *k, double x, int p) {
    union { double d; uint64_t u; } bits = {x};
    int negative = (int)(bits.u >> 63);
    int biased = (int)((bits.u >> 52) & 0x7ff);
    uint64_t fraction = bits.u & ((1ull << 52) - 1);
    if (biased == 0x7ff) {
        put_string(k, fraction ? "nan" : negative ? "-inf" : "inf");
        return;
    }
    if (negative) put(k, '-');
    if (p > 9) p = 9;

    /* |x| = m * 2^e exactly; round(|x| * 10^p) as a big integer */
    uint64_t m = biased ? fraction | (1ull << 52) : fraction;
    int e = biased ? biased - 1075 : -1074;
    big v = {{(uint32_t)m, (uint32_t)(m >> 32)}, 2};
    for (int i = 0; i < p; i++) big_mul_small(&v, 10u);
    if (e > 0) big_shift_left(&v, e);
    else if (e < 0) big_shift_right_round(&v, -e);

    char digits[400];
    int n = 0;
    while (!big_is_zero(&v) && n < (int)sizeof digits) digits[n++] = (char)('0' + big_div10(&v));
    while (n <= p) digits[n++] = '0';  /* at least one digit before the point */
    while (n > p) put(k, digits[--n]);
    if (p) {
        put(k, '.');
        while (n) put(k, digits[--n]);
    }
}

int snprintf(char *out, size_t size, const char *format, ...) {
    va_list args;
    va_start(args, format);
    sink k = {out, size, 0};
    for (const char *f = format; *f; f++) {
        if (*f != '%') {
            put(&k, *f);
            continue;
        }
        f++;
        int precision = 6;
        if (*f == '.') {
            f++;
            precision = 0;
            while (is_digit(*f)) precision = precision * 10 + (*f++ - '0');
        }
        switch (*f) {
            case 's': put_string(&k, va_arg(args, const char *)); break;
            case 'd': {
                int v = va_arg(args, int);
                if (v < 0) put(&k, '-');
                put_unsigned(&k, v < 0 ? (uint64_t)(-(int64_t)v) : (uint64_t)v);
                break;
            }
            case 'u': put_unsigned(&k, va_arg(args, unsigned)); break;
            case 'f': put_fixed(&k, va_arg(args, double), precision); break;
            case '%': put(&k, '%'); break;
            default: break;
        }
        if (!*f) break;
    }
    if (size) out[k.n < size ? k.n : size - 1] = 0;
    va_end(args);
    return (int)k.n;
}

