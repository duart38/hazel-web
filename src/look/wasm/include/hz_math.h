/* Float maths for look.c inside the WebAssembly module, giving exactly the floats of the
 * correctly rounded native build (native/cr_math.h: the double function, rounded to float once)
 * without a call out to JavaScript for each one.
 *
 * Each function computes its answer in double with a relative error below 2^-44 (about 2^8
 * units in the last place of a double; the bounds are in the comments and checked over every
 * float, or billions of pairs, by native/check_math.c). Rounding that to float gives the
 * correctly rounded float unless the true value lies close to the halfway point between two
 * floats; hz_unsure() spots that, with a margin of 2^12 double units either side, and so does
 * a result outside the normal float range, and then the reference function is called instead:
 * the includer defines HZ_FALLBACK_POW(x, y) and the others as the double function itself
 * (JavaScript's Math in look.wasm, libm natively). That happens about once in 65,000 calls.
 * Outside that band the double reference (within one unit of the true value) and this
 * approximation round to the same float, the correctly rounded one.
 *
 * The method is the usual one for float functions computed in double (as in CORE-MATH, MIT, and
 * ARM's optimized-routines, MIT/Apache: table plus short polynomial, then a rounding test), but
 * the code and constants here are our own; the tables come from math_tables.c (MPFR). */
#ifndef HAZEL_HZ_MATH_H
#define HAZEL_HZ_MATH_H

#include <stdint.h>
#include "math_tables.h"

static inline uint64_t hz_bits(double d) {
    uint64_t u;
    __builtin_memcpy(&u, &d, 8);
    return u;
}
static inline double hz_double(uint64_t u) {
    double d;
    __builtin_memcpy(&d, &u, 8);
    return d;
}
static inline uint32_t hz_fbits(float f) {
    uint32_t u;
    __builtin_memcpy(&u, &f, 4);
    return u;
}
static inline float hz_float(uint32_t u) {
    float f;
    __builtin_memcpy(&f, &u, 4);
    return f;
}

/* 1 when rounding r to float might not give the correctly rounded float of the value r
 * approximates: within HZ_SLACK double units of a halfway point, or outside the normal floats.
 * A double has 29 more fraction bits than a float; their value 2^28 is the halfway point. */
#ifndef HZ_SLACK
#define HZ_SLACK 4096u
#endif
static inline int hz_unsure(double r) {
    uint64_t u = hz_bits(r);
    uint32_t e = (uint32_t)(u >> 52) & 0x7ffu;
    if (e - (1023u - 126u) > 126u + 127u) return 1;
    uint32_t low = (uint32_t)u & 0x1fffffffu;
    return low - (0x10000000u - HZ_SLACK) < 2u * HZ_SLACK;
}

/* The polynomials are evaluated in Estrin's order (powers of the argument computed alongside, sums
 * paired) rather than Horner's: look.c's maths is one long chain of dependent operations, so the
 * shorter chain matters more than the extra multiply. */

/* 2^t for |t| < 1000: t = k/64 + r with |r| <= 1/128 (exact: t - k/64 is Sterbenz-exact), then
 * 2^(k/64) from the table times a degree-6 Taylor polynomial of e^(r ln 2) (truncation below
 * 2^-60). Error under 2^-50 relative. */
static inline double hz_exp2_core(double t) {
    double kd = __builtin_rint(t * 64.0);
    double z = t - kd * 0x1p-6;
    int64_t k = (int64_t)kd;
    /* e^(z ln 2), with the powers of ln 2 in the coefficients */
    const double c1 = HZ_LN2, c2 = c1 * HZ_LN2 / 2, c3 = c2 * HZ_LN2 / 3, c4 = c3 * HZ_LN2 / 4,
                 c5 = c4 * HZ_LN2 / 5, c6 = c5 * HZ_LN2 / 6;
    double z2 = z * z, z4 = z2 * z2;
    double p = ((1.0 + z * c1) + z2 * (c2 + z * c3)) + z4 * ((c4 + z * c5) + z2 * c6);
    double s = hz_double(hz_bits(HZ_EXP2[k & 63]) + ((uint64_t)(k >> 6) << 52));
    return s * p;
}

/* log2 of a positive normal float, given its bits. x = 2^k z with z in [0.699, 1.398), z in one of
 * 128 cells; r = z / centre - 1 is exact (1/centre has 29 bits), |r| < 0.004, and log2(1 + r) is a
 * degree-6 Taylor polynomial (truncation below 2^-58). Absolute error under 2^-51 * max(1, |log2 x|). */
static inline double hz_log2_core(uint32_t ix) {
    uint32_t tmp = ix - 0x3f330000u;
    int k = (int32_t)tmp >> 23;
    uint32_t i = (tmp >> 16) & 127u;
    double z = (double)hz_float(ix - (tmp & 0xff800000u));
    double r = z * HZ_LOG2_INVC[i] - 1.0;
    /* log(1 + r) / ln 2, with 1/ln 2 in the coefficients */
    const double l = HZ_INV_LN2;
    double r2 = r * r, r4 = r2 * r2;
    double p = (r * l - r2 * (l / 2 - r * (l / 3))) - r4 * ((l / 4 - r * (l / 5)) + r2 * (l / 6));
    return ((double)k + HZ_LOG2_LOGC[i]) + p;
}

/* Each hz_*_d puts its double approximation in *r and returns 1, or returns 0 when the arguments
 * are outside its fast path; hz_*f rounds it or calls the reference. */
#define HZ_ROUNDED(fast, fallback) do { double r_; if ((fast) && !hz_unsure(r_)) return (float)r_; return (float)(fallback); } while (0)

/* x^y for positive normal x and |y| <= 16 (look.c uses 0.5 to 2.5): t = y log2 x, |t| < 150, has
 * absolute error under 16 * 2^-51 + 150 * 2^-53, so 2^t is within 2^-45 relative. */
static inline int hz_pow_d(float x, float y, double *r) {
    uint32_t ix = hz_fbits(x);
    if (!(ix - 0x00800000u < 0x7f000000u && __builtin_fabsf(y) <= 16.f)) return 0;
    double t = (double)y * hz_log2_core(ix);
    if (!(__builtin_fabs(t) < 150.0)) return 0;
    *r = hz_exp2_core(t);
    return 1;
}
static inline float hz_powf(float x, float y) { HZ_ROUNDED(hz_pow_d(x, y, &r_), HZ_FALLBACK_POW(x, y)); }

/* 2^x exactly as given: error under 2^-50. */
static inline int hz_exp2_d(float x, double *r) {
    if (!(__builtin_fabsf(x) < 150.f)) return 0;
    *r = hz_exp2_core((double)x);
    return 1;
}
static inline float hz_exp2f(float x) { HZ_ROUNDED(hz_exp2_d(x, &r_), HZ_FALLBACK_POW(2.0, x)); }

/* e^x = 2^(x log2 e): the product's rounding adds 100 * 2^-53 to t, so under 2^-46 relative. */
static inline int hz_exp_d(float x, double *r) {
    if (!(__builtin_fabsf(x) < 100.f)) return 0;
    *r = hz_exp2_core((double)x * HZ_INV_LN2);
    return 1;
}
static inline float hz_expf(float x) { HZ_ROUNDED(hz_exp_d(x, &r_), HZ_FALLBACK_EXP(x)); }

/* Cube root of a normal float: x = 2^(3q + s) m, m in [1, 2), s in {0, 1, 2}, m in one of 64
 * cells; u = m / centre - 1 is exact (1/centre has 29 bits), |u| < 1/128, and cbrt x is
 * cbrt(2^s centre) from the table times (1 + u)^(1/3), the binomial series to u^6 (truncation
 * below 2^-54), times 2^q. Error under 2^-50. */
static inline int hz_cbrt_d(float x, double *r) {
    uint32_t ix = hz_fbits(x), ax = ix & 0x7fffffffu;
    if (!(ax - 0x00800000u < 0x7f000000u)) return 0;
    uint32_t biased = ax >> 23;                                  /* 1..254 */
    int q = (int)(((biased + 254u) * 0xAAABu) >> 17) - 127;      /* floor((biased - 127) / 3) */
    int s = (int)biased - 127 - 3 * q;
    uint32_t i = (ax >> 17) & 63u;
    double u = (double)hz_float((ax & 0x7fffffu) | 0x3f800000u) * HZ_CBRT_INVC[i] - 1.0;
    double u2 = u * u, u4 = u2 * u2;
    double p = ((1.0 + u * (1.0 / 3)) - u2 * (1.0 / 9 - u * (5.0 / 81))) -
               u4 * ((10.0 / 243 - u * (22.0 / 729)) + u2 * (154.0 / 6561));
    double root = p * (HZ_CBRT[s][i] * hz_double((uint64_t)(1023 + q) << 52));
    *r = ix >> 31 ? -root : root;
    return 1;
}
static inline float hz_cbrtf(float x) { HZ_ROUNDED(hz_cbrt_d(x, &r_), HZ_FALLBACK_CBRT(x)); }

/* sin or cos of |x| < 2^15: x = k pi/2 + r with pi/2 in three parts (38 + 38 + 53 bits), so r has
 * relative error near 2^-52 even when x is close to a multiple of pi/2; then Taylor polynomials
 * to r^15 and r^16 on |r| <= pi/4 (truncation below 2^-54). */
static inline double hz_sin_poly(double r) {
    double r2 = r * r, r4 = r2 * r2, r8 = r4 * r4;
    double low = (-1.0 / 6 + r2 * (1.0 / 120)) + r4 * (-1.0 / 5040 + r2 * (1.0 / 362880));
    double high = (-1.0 / 39916800 + r2 * (1.0 / 6227020800)) + r4 * (-1.0 / 1307674368000.0);
    return r + (r * r2) * (low + r8 * high);
}
static inline double hz_cos_poly(double r) {
    double r2 = r * r, r4 = r2 * r2, r8 = r4 * r4;
    double low = (-0.5 + r2 * (1.0 / 24)) + r4 * (-1.0 / 720 + r2 * (1.0 / 40320));
    double high = (-1.0 / 3628800 + r2 * (1.0 / 479001600)) + r4 * (-1.0 / 87178291200.0 + r2 * (1.0 / 20922789888000.0));
    return 1.0 + r2 * (low + r8 * high);
}
static inline int hz_sincos_d(float x, int quadrant_offset, double *out) {
    if (!(__builtin_fabsf(x) < 32768.f) || (x == 0.f && !quadrant_offset)) return 0;
    double xd = (double)x;
    double kd = __builtin_rint(xd * HZ_2_PI);
    double r = ((xd - kd * HZ_PIO2_1) - kd * HZ_PIO2_2) - kd * HZ_PIO2_3;
    switch (((int)kd + quadrant_offset) & 3) {
        case 0: *out = hz_sin_poly(r); break;
        case 1: *out = hz_cos_poly(r); break;
        case 2: *out = -hz_sin_poly(r); break;
        default: *out = -hz_cos_poly(r); break;
    }
    return 1;
}
static inline float hz_sinf(float x) { HZ_ROUNDED(hz_sincos_d(x, 0, &r_), HZ_FALLBACK_SIN(x)); }
static inline float hz_cosf(float x) { HZ_ROUNDED(hz_sincos_d(x, 1, &r_), HZ_FALLBACK_COS(x)); }

/* atan2 of finite non-zero y and x: z = min/max in (0, 1], atan z = atan(j/32) + atan(t) with
 * t = (z - j/32)/(1 + z j/32), |t| < 1/64, Taylor to t^9 (truncation below 2^-62); then the
 * octant. Under 2^-50 relative (the octant steps add, never cancel). */
static inline int hz_atan2_d(float y, float x, double *r) {
    double ay = __builtin_fabs((double)y), ax = __builtin_fabs((double)x);
    if (!(ay > 0.0 && ax > 0.0 && ay <= 3.5e38 && ax <= 3.5e38)) return 0;
    int swap = ay > ax;
    double z = swap ? ax / ay : ay / ax;
    double jd = __builtin_rint(z * 32.0), c = jd * 0x1p-5;
    double t = (z - c) / (1.0 + z * c), t2 = t * t;
    double a = HZ_ATAN[(int)jd] + t * (1.0 - t2 * (1.0 / 3 - t2 * (0.2 - t2 * (1.0 / 7 - t2 * (1.0 / 9)))));
    if (swap) a = HZ_PI_2 - a;
    if (x < 0.f) a = HZ_PI - a;
    *r = y < 0.f ? -a : a;
    return 1;
}
static inline float hz_atan2f(float y, float x) { HZ_ROUNDED(hz_atan2_d(y, x, &r_), HZ_FALLBACK_ATAN2(y, x)); }

#endif
