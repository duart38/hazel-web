/* Correctly rounded float maths (double, then rounded), the same answers JavaScript gives, so a
 * native build of look.c can be compared with look.wasm bit for bit. */
#include <math.h>
#define powf(x, y) ((float)pow((x), (y)))
#define expf(x) ((float)exp(x))
#define exp2f(x) ((float)exp2(x))
#define cbrtf(x) ((float)cbrt(x))
#define sinf(x) ((float)sin(x))
#define cosf(x) ((float)cos(x))
#define atan2f(y, x) ((float)atan2((y), (x)))
