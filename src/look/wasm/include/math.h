/* libm for the WebAssembly build of look.c. The transcendental functions are computed in the
 * module (hz_math.h), giving the correctly rounded floats; the few arguments where that can't be
 * decided cheaply go to JavaScript's Math (in double, rounded to float once). The rest are
 * WebAssembly instructions or exact C. */
#ifndef HAZEL_WASM_MATH_H
#define HAZEL_WASM_MATH_H
/* Imported with double signatures, as the Math functions themselves are: V8 then calls its own
 * C++ maths directly instead of going through JavaScript. */
#define HZ_IMPORT(name) __attribute__((import_module("math"), import_name(#name)))
HZ_IMPORT(pow) double hz_pow(double, double);
HZ_IMPORT(exp) double hz_exp(double);
HZ_IMPORT(cbrt) double hz_cbrt(double);
HZ_IMPORT(sin) double hz_sin(double);
HZ_IMPORT(cos) double hz_cos(double);
HZ_IMPORT(atan2) double hz_atan2(double, double);
HZ_IMPORT(fmod) double hz_fmod(double, double);
#define HZ_FALLBACK_POW(x, y) hz_pow((x), (y))
#define HZ_FALLBACK_EXP(x) hz_exp(x)
#define HZ_FALLBACK_CBRT(x) hz_cbrt(x)
#define HZ_FALLBACK_SIN(x) hz_sin(x)
#define HZ_FALLBACK_COS(x) hz_cos(x)
#define HZ_FALLBACK_ATAN2(y, x) hz_atan2((y), (x))
#include "hz_math.h"
static inline float powf(float x, float y) { return hz_powf(x, y); }
static inline float expf(float x) { return hz_expf(x); }
static inline float exp2f(float x) { return hz_exp2f(x); }
static inline float cbrtf(float x) { return hz_cbrtf(x); }
static inline float sinf(float x) { return hz_sinf(x); }
static inline float cosf(float x) { return hz_cosf(x); }
static inline float atan2f(float y, float x) { return hz_atan2f(y, x); }
/* Exact, like C's: the remainder of two floats is a float. With the quotient below 2^29, q * |y|
 * and |x| - q * |y| are exact in double; a quotient one off is corrected. The rest (huge
 * quotients, zero, infinity, NaN) goes to JavaScript's %, which is exact too. */
static inline float fmodf(float x, float y) {
    double ax = __builtin_fabs((double)x), ay = __builtin_fabs((double)y);
    if (!(ay > 0.0) || !(ax <= 3.5e38)) return (float)hz_fmod(x, y);
    if (ax < ay) return x;
    double q = __builtin_trunc(ax / ay);
    if (q >= 536870912.0) return (float)hz_fmod(x, y);
    double r = ax - q * ay;
    if (r < 0.0) r += ay;
    else if (r >= ay) r -= ay;
    return (float)(x < 0.f ? -r : r);
}
static inline float floorf(float x) { return __builtin_floorf(x); }
static inline float ceilf(float x) { return __builtin_ceilf(x); }
static inline float sqrtf(float x) { return __builtin_sqrtf(x); }
static inline float fabsf(float x) { return __builtin_fabsf(x); }
/* C's fminf/fmaxf ignore a NaN argument, WebAssembly's min/max propagate it; for -0 and +0
 * both pick like the camera's and Apple's ARM instructions (fminnm, fmaxnm). */
static inline float fminf(float a, float b) { return a != a ? b : b != b ? a : __builtin_wasm_min_f32(a, b); }
static inline float fmaxf(float a, float b) { return a != a ? b : b != b ? a : __builtin_wasm_max_f32(a, b); }
static inline double floor(double x) { return __builtin_floor(x); }
#endif
