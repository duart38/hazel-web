/* Checks wasm/include/hz_math.h against the reference the parity build uses (cr_math.h: the
 * double libm function rounded to float): every float for the one-argument functions, every
 * positive float for powf with the exponents look.c uses, and random pairs. Reports mismatches
 * (must be 0), how often the reference was called (over every argument, so mostly the ones outside
 * the fast path: NaN, infinity, results out of float range), and the largest error of the double
 * approximation in double units (must stay far below HZ_SLACK, 4096). Runs on every core:
 *   clang -O2 -ffp-contract=off -iquote ../wasm/include check_math.c -o /tmp/check_math && /tmp/check_math */
#include <dispatch/dispatch.h>
#include <math.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>

static _Atomic uint64_t fallbacks;
#define HZ_COUNT(v) (atomic_fetch_add_explicit(&fallbacks, 1, memory_order_relaxed), (v))
#define HZ_FALLBACK_POW(x, y) HZ_COUNT(pow((double)(x), (double)(y)))
#define HZ_FALLBACK_EXP(x) HZ_COUNT(exp((double)(x)))
#define HZ_FALLBACK_CBRT(x) HZ_COUNT(cbrt((double)(x)))
#define HZ_FALLBACK_SIN(x) HZ_COUNT(sin((double)(x)))
#define HZ_FALLBACK_COS(x) HZ_COUNT(cos((double)(x)))
#define HZ_FALLBACK_ATAN2(y, x) HZ_COUNT(atan2((double)(y), (double)(x)))
#include "hz_math.h"

static float as_float(uint32_t u) { float f; memcpy(&f, &u, 4); return f; }
static uint32_t as_bits(float f) { uint32_t u; memcpy(&u, &f, 4); return u; }
static int same(float a, float b) { return as_bits(a) == as_bits(b) || (a != a && b != b); }

/* |approx - ref| in units of ref's last place */
static double ulps(double approx, double ref) {
    if (ref == 0 || !isfinite(ref)) return 0;
    int e;
    frexp(ref, &e);
    return fabs(approx - ref) / ldexp(1.0, e - 53);
}

typedef struct {
    const char *name;
    _Atomic uint64_t calls, mismatches;
    _Atomic uint64_t worst_bits;  /* the largest error in ulps, as double bits (monotonic for positives) */
    _Atomic uint32_t example;
} tally;

static void note_error(tally *t, double e) {
    uint64_t bits;
    memcpy(&bits, &e, 8);
    uint64_t old = atomic_load(&t->worst_bits);
    while (bits > old && !atomic_compare_exchange_weak(&t->worst_bits, &old, bits)) {}
}

static void report(tally *t) {
    double worst;
    uint64_t bits = atomic_load(&t->worst_bits);
    memcpy(&worst, &bits, 8);
    printf("%-22s %12llu calls  %llu mismatches  %llu to the reference (1 in %.0f)  worst %.1f ulps\n", t->name,
           (unsigned long long)t->calls, (unsigned long long)t->mismatches, (unsigned long long)fallbacks,
           fallbacks ? (double)t->calls / (double)fallbacks : 0.0, worst);
    if (t->mismatches) printf("    e.g. 0x%08x\n", t->example);
    atomic_store(&fallbacks, 0);
}

#define CHUNKS 4096u

typedef float (*unary_f)(float);
typedef int (*unary_d)(float, double *);
typedef double (*unary_ref)(double);
static int sin_d(float x, double *r) { return hz_sincos_d(x, 0, r); }
static int cos_d(float x, double *r) { return hz_sincos_d(x, 1, r); }

static void every_float(const char *name, unary_f f, unary_d d, unary_ref ref) {
    static tally t;
    memset(&t, 0, sizeof t);
    t.name = name;
    dispatch_apply(CHUNKS, DISPATCH_APPLY_AUTO, ^(size_t chunk) {
        uint64_t mismatches = 0, calls = 0;
        double worst = 0;
        uint32_t example = 0;
        for (uint64_t u = chunk << 20; u < (chunk + 1) << 20; u++) {
            float x = as_float((uint32_t)u);
            double reference = ref((double)x), approx;
            if (!same(f(x), (float)reference)) mismatches++, example = (uint32_t)u;
            if (d(x, &approx)) {
                double e = ulps(approx, reference);
                if (e > worst) worst = e;
            }
            calls++;
        }
        atomic_fetch_add(&t.calls, calls);
        atomic_fetch_add(&t.mismatches, mismatches);
        if (mismatches) atomic_store(&t.example, example);
        note_error(&t, worst);
    });
    report(&t);
}

static void pow_every_x(const char *name, float y) {
    static tally t;
    memset(&t, 0, sizeof t);
    t.name = name;
    dispatch_apply(CHUNKS / 2, DISPATCH_APPLY_AUTO, ^(size_t chunk) {
        uint64_t mismatches = 0, calls = 0;
        double worst = 0;
        uint32_t example = 0;
        for (uint64_t u = chunk << 20; u < (chunk + 1) << 20; u++) {
            float x = as_float((uint32_t)u);
            double reference = pow((double)x, (double)y), approx;
            if (!same(hz_powf(x, y), (float)reference)) mismatches++, example = (uint32_t)u;
            if (hz_pow_d(x, y, &approx)) {
                double e = ulps(approx, reference);
                if (e > worst) worst = e;
            }
            calls++;
        }
        atomic_fetch_add(&t.calls, calls);
        atomic_fetch_add(&t.mismatches, mismatches);
        if (mismatches) atomic_store(&t.example, example);
        note_error(&t, worst);
    });
    report(&t);
}

static uint64_t mix(uint64_t z) {
    z = (z ^ (z >> 30)) * 0xbf58476d1ce4e5b9ull;
    z = (z ^ (z >> 27)) * 0x94d049bb133111ebull;
    return z ^ (z >> 31);
}

/* random pairs: x any positive float or one near 1, y uniform in [-16, 16] or a random float */
static void pow_random(uint64_t count) {
    static tally t;
    memset(&t, 0, sizeof t);
    t.name = "powf random pairs";
    dispatch_apply(CHUNKS, DISPATCH_APPLY_AUTO, ^(size_t chunk) {
        uint64_t mismatches = 0;
        double worst = 0;
        uint32_t example = 0;
        uint64_t per = count / CHUNKS;
        for (uint64_t i = 0; i < per; i++) {
            uint64_t h = mix(chunk * per + i + 0x1234567ull);
            uint32_t xb = (uint32_t)h & 0x7fffffffu;
            if (h >> 63) xb = 0x3f800000u + (uint32_t)((int32_t)(xb & 0xfffff) - 0x80000);
            float x = as_float(xb);
            float y = (h >> 62) & 1 ? as_float((uint32_t)(h >> 31)) : ((float)((h >> 32) & 0xffffff) / 524288.f - 16.f);
            double reference = pow((double)x, (double)y), approx;
            if (!same(hz_powf(x, y), (float)reference)) mismatches++, example = xb;
            if (hz_pow_d(x, y, &approx)) {
                double e = ulps(approx, reference);
                if (e > worst) worst = e;
            }
        }
        atomic_fetch_add(&t.calls, per);
        atomic_fetch_add(&t.mismatches, mismatches);
        if (mismatches) atomic_store(&t.example, example);
        note_error(&t, worst);
    });
    report(&t);
}

static void atan2_random(uint64_t count) {
    static tally t;
    memset(&t, 0, sizeof t);
    t.name = "atan2f random pairs";
    dispatch_apply(CHUNKS, DISPATCH_APPLY_AUTO, ^(size_t chunk) {
        uint64_t mismatches = 0;
        double worst = 0;
        uint32_t example = 0;
        uint64_t per = count / CHUNKS;
        for (uint64_t i = 0; i < per; i++) {
            uint64_t h = mix(chunk * per + i + 0x9876543ull);
            float y, x;
            switch (h & 3) {
                case 0: y = as_float((uint32_t)(h >> 2)); x = as_float((uint32_t)(h >> 32)); break;
                case 1:  /* look.c's Oklab a and b: within about +-0.5 */
                    y = (float)((int32_t)(h >> 8) & 0xffffff) / 16777216.f - 0.5f;
                    x = (float)((int32_t)(h >> 36) & 0xffffff) / 16777216.f - 0.5f;
                    break;
                case 2:  /* close to the diagonal and the axes */
                    x = as_float(0x3f000000u + (uint32_t)((h >> 8) & 0xffffff));
                    y = as_float(as_bits(x) + (uint32_t)((int32_t)((h >> 40) & 0xff) - 128)) * ((h >> 50) & 1 ? -1.f : 1.f);
                    break;
                default:
                    x = (float)((int32_t)(h >> 8) & 0xffff) - 32768.f;
                    y = as_float((uint32_t)(h >> 30) & 0xbfffffffu);
                    break;
            }
            double reference = atan2((double)y, (double)x), approx;
            if (!same(hz_atan2f(y, x), (float)reference)) mismatches++, example = as_bits(y);
            if (hz_atan2_d(y, x, &approx)) {
                double e = ulps(approx, reference);
                if (e > worst) worst = e;
            }
        }
        atomic_fetch_add(&t.calls, per);
        atomic_fetch_add(&t.mismatches, mismatches);
        if (mismatches) atomic_store(&t.example, example);
        note_error(&t, worst);
    });
    report(&t);
}

static double exp2_ref(double x) { return pow(2.0, x); }

int main(void) {
    every_float("cbrtf every float", hz_cbrtf, hz_cbrt_d, cbrt);
    every_float("exp2f every float", hz_exp2f, hz_exp2_d, exp2_ref);
    every_float("expf every float", hz_expf, hz_exp_d, exp);
    every_float("sinf every float", hz_sinf, sin_d, sin);
    every_float("cosf every float", hz_cosf, cos_d, cos);
    pow_every_x("powf(x, 2.4)", 2.4f);
    pow_every_x("powf(x, 1/2.4)", 1.f / 2.4f);
    pow_every_x("powf(x, 0.8)", 0.8f);
    pow_every_x("powf(x, 2.5)", 2.5f);
    pow_every_x("powf(x, 2^-0.2)", exp2f(-0.2f));
    pow_every_x("powf(x, 2^0.7)", exp2f(0.7f));
    pow_every_x("powf(x, 16)", 16.f);
    pow_random(1ull << 32);
    atan2_random(1ull << 32);
    return 0;
}
