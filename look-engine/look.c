#include "look.h"

#include <math.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#if defined(__ARM_NEON)
#include <arm_neon.h>
#endif

static float clamp01(float x) { return x < 0.f ? 0.f : x > 1.f ? 1.f : x; }

/* Live-view steps have vector (NEON) versions, eight pixels at a time with the same integer
 * arithmetic, so their result is identical byte for byte; tests switch them off to compare. */
static int nv12_vector = 1;
void look_nv12_set_vector(int on) { nv12_vector = on; }

#if defined(__ARM_NEON)
/* Eight bytes, as a vector and as two words in core registers for table lookups. On the
 * Cortex-A9 a move from a NEON register to a core register stalls the pipeline for many cycles,
 * and the compiler turns byte loads next to a vector load of the same bytes into exactly that; so
 * the words are loaded in asm, and the vector is built from them (a cheap move the other way). */
typedef struct { uint32_t lo, hi; } eight_bytes;
static inline eight_bytes load_eight(const unsigned char *p) {
    eight_bytes e;
#if defined(__arm__)
    __asm__("ldr %0, [%2]\n\tldr %1, [%2, #4]" : "=&r"(e.lo), "=r"(e.hi) : "r"(p), "m"(*(const unsigned char(*)[8])p));
#else
    memcpy(&e.lo, p, 4);
    memcpy(&e.hi, p + 4, 4);
#endif
    return e;
}
static inline unsigned byte_at(eight_bytes e, int k) { return ((k < 4 ? e.lo : e.hi) >> (8 * (k & 3))) & 255u; }
static inline uint8x8_t eight_vector(eight_bytes e) { return vcreate_u8((uint64_t)e.hi << 32 | e.lo); }

/* table[index] for eight indices, one lane at a time (plain loads packed with moves were slower) */
static inline int16x8_t gather_shorts(const short *table, eight_bytes px) {
    int16x8_t g = vdupq_n_s16(0);
    g = vld1q_lane_s16(table + byte_at(px, 0), g, 0);
    g = vld1q_lane_s16(table + byte_at(px, 1), g, 1);
    g = vld1q_lane_s16(table + byte_at(px, 2), g, 2);
    g = vld1q_lane_s16(table + byte_at(px, 3), g, 3);
    g = vld1q_lane_s16(table + byte_at(px, 4), g, 4);
    g = vld1q_lane_s16(table + byte_at(px, 5), g, 5);
    g = vld1q_lane_s16(table + byte_at(px, 6), g, 6);
    g = vld1q_lane_s16(table + byte_at(px, 7), g, 7);
    return g;
}
#endif

/* Photo-size work runs on every core on Apple's systems (the Mac and iPhone app) and serially
 * elsewhere (the camera, which only builds small tables with this code). Each task gets a band of
 * rows and never reads what another task writes, and every sum keeps its order, so the result is
 * bit-identical either way. */
#define BAND_ROWS 16
typedef void (*band_fn)(void *ctx, int row_begin, int row_end);
typedef struct { void *ctx; band_fn fn; int rows; } band_job;
static void run_band(void *job_ptr, size_t band) {
    band_job *job = job_ptr;
    int begin = (int)band * BAND_ROWS, end = begin + BAND_ROWS < job->rows ? begin + BAND_ROWS : job->rows;
    job->fn(job->ctx, begin, end);
}
#if defined(__APPLE__)
#include <dispatch/dispatch.h>
static void for_bands(int rows, void *ctx, band_fn fn) {
    band_job job = {ctx, fn, rows};
    dispatch_apply_f((size_t)(rows + BAND_ROWS - 1) / BAND_ROWS, DISPATCH_APPLY_AUTO, &job, run_band);
}
#else
static void for_bands(int rows, void *ctx, band_fn fn) {
    band_job job = {ctx, fn, rows};
    for (size_t band = 0; band < (size_t)(rows + BAND_ROWS - 1) / BAND_ROWS; band++) run_band(&job, band);
}
#endif

static float srgb_to_linear(float x) {
    return x <= 0.04045f ? x / 12.92f : powf((x + 0.055f) / 1.055f, 2.4f);
}

static float linear_to_srgb(float x) {
    return x <= 0.0031308f ? x * 12.92f : 1.055f * powf(x, 1.f / 2.4f) - 0.055f;
}

void look_defaults(look_recipe *r) {
    memset(r, 0, sizeof *r);
    /* a mild red-filter black and white, for darker skies and lighter skin */
    r->mono_red = 0.35f;
    r->mono_green = 0.55f;
    r->mono_blue = 0.10f;
    r->grain_size = 0.3f;
    r->seed = 1;
}

typedef struct { const char *key; int offset; } float_key;

static const float_key FLOAT_KEYS[] = {
    {"contrast", offsetof(look_recipe, contrast)},
    {"shadows", offsetof(look_recipe, shadows)},
    {"highlights", offsetof(look_recipe, highlights)},
    {"saturation", offsetof(look_recipe, saturation)},
    {"shift_red", offsetof(look_recipe, shift_red)},
    {"shift_blue", offsetof(look_recipe, shift_blue)},
    {"vignette", offsetof(look_recipe, vignette)},
    {"grain", offsetof(look_recipe, grain)},
    {"grain_size", offsetof(look_recipe, grain_size)},
    {"sharpness", offsetof(look_recipe, sharpness)},
    {"clarity", offsetof(look_recipe, clarity)},
    {"aberration", offsetof(look_recipe, aberration)},
    {"dynamic_range", offsetof(look_recipe, dynamic_range)},
    {"colour_depth", offsetof(look_recipe, colour_depth)},
    {"blue_depth", offsetof(look_recipe, blue_depth)},
    {"tone_warm", offsetof(look_recipe, tone_warm)},
    {"tone_magenta", offsetof(look_recipe, tone_magenta)},
    {"noise_reduction", offsetof(look_recipe, noise_reduction)},
    {"fade", offsetof(look_recipe, fade)},
    {"brightness", offsetof(look_recipe, brightness)},
    {"vibrance", offsetof(look_recipe, vibrance)},
    {"halation", offsetof(look_recipe, halation)},
    {"grade_balance", offsetof(look_recipe, grade_balance)},
};

/* The mixer's bands, at the Oklab hue of each colour at full strength in sRGB (pure red, orange
 * 255,128,0, yellow, green, cyan, blue, purple 128,0,255, magenta), so a band's adjustment is
 * strongest right on that colour and shared with its neighbours in between. */
typedef struct { const char *name; float hue; } mix_band;
static const mix_band MIX_BANDS[LOOK_MIX_BANDS] = {
    {"red", 29.2f}, {"orange", 53.f}, {"yellow", 109.8f}, {"green", 142.5f},
    {"aqua", 194.8f}, {"blue", 264.1f}, {"purple", 293.9f}, {"magenta", 328.4f},
};

const char *look_mix_band_name(int band) {
    return band >= 0 && band < LOOK_MIX_BANDS ? MIX_BANDS[band].name : "";
}

static float clamp_unit(float x) { return x < -1.f ? -1.f : x > 1.f ? 1.f : x; }
#define N_FLOAT_KEYS ((int)(sizeof FLOAT_KEYS / sizeof FLOAT_KEYS[0]))

static const char *const FILM_NAMES[] = {"standard", "muted", "silver"};
#define N_FILMS ((int)(sizeof FILM_NAMES / sizeof FILM_NAMES[0]))

static int limits_for(const char *key, float *lo, float *hi) {
    if (!strcmp(key, "grain") || !strcmp(key, "grain_size") || !strcmp(key, "aberration") || !strcmp(key, "clarity") ||
        !strcmp(key, "dynamic_range") || !strcmp(key, "colour_depth") || !strcmp(key, "blue_depth") ||
        !strcmp(key, "fade") || !strcmp(key, "halation")) {
        *lo = 0.f;
        *hi = 1.f;
    } else {
        *lo = -1.f;
        *hi = 1.f;
    }
    return 1;
}

int look_parse(look_recipe *r, const char *text) {
    int recognised = 0;
    const char *line = text;
    while (*line) {
        const char *end = strchr(line, '\n');
        size_t len = end ? (size_t)(end - line) : strlen(line);
        char buf[160];
        if (len >= sizeof buf) len = sizeof buf - 1;
        memcpy(buf, line, len);
        buf[len] = 0;
        char *eq = strchr(buf, '=');
        if (eq && buf[0] != '#') {
            *eq = 0;
            char *key = buf, *value = eq + 1;
            while (*key == ' ' || *key == '\t') key++;
            char *k_end = key + strlen(key);
            while (k_end > key && (k_end[-1] == ' ' || k_end[-1] == '\t')) *--k_end = 0;
            if (!strcmp(key, "mono")) {
                r->mono = atoi(value) != 0;
                recognised++;
            } else if (!strcmp(key, "mono_mix")) {
                float a, b, c;
                if (sscanf(value, " %f , %f , %f", &a, &b, &c) == 3 && a + b + c > 0.f) {
                    float s = a + b + c;
                    r->mono_red = a / s;
                    r->mono_green = b / s;
                    r->mono_blue = c / s;
                    recognised++;
                }
            } else if (!strcmp(key, "film")) {
                char name[32] = "";
                sscanf(value, " %31s", name);
                for (int i = 0; i < N_FILMS; i++) {
                    if (strcmp(name, FILM_NAMES[i])) continue;
                    r->film = i;
                    recognised++;
                    break;
                }
            } else if (!strcmp(key, "seed")) {
                r->seed = (unsigned int)strtoul(value, 0, 10);
                recognised++;
            } else if (!strcmp(key, "grade_shadows") || !strcmp(key, "grade_highlights")) {
                float hue, amount;
                if (sscanf(value, " %f , %f", &hue, &amount) == 2) {
                    hue = fmodf(hue, 360.f);
                    if (hue < 0.f) hue += 360.f;
                    int shadows = key[6] == 's';
                    *(shadows ? &r->grade_shadow_hue : &r->grade_highlight_hue) = hue;
                    *(shadows ? &r->grade_shadow_amount : &r->grade_highlight_amount) = clamp01(amount);
                    recognised++;
                }
            } else if (!strncmp(key, "mix_", 4)) {
                float hue, saturation, lightness;
                for (int band = 0; band < LOOK_MIX_BANDS; band++) {
                    if (strcmp(key + 4, MIX_BANDS[band].name)) continue;
                    if (sscanf(value, " %f , %f , %f", &hue, &saturation, &lightness) == 3) {
                        r->mix_hue[band] = clamp_unit(hue);
                        r->mix_saturation[band] = clamp_unit(saturation);
                        r->mix_lightness[band] = clamp_unit(lightness);
                        recognised++;
                    }
                    break;
                }
            } else {
                for (int i = 0; i < N_FLOAT_KEYS; i++) {
                    if (strcmp(key, FLOAT_KEYS[i].key)) continue;
                    float lo, hi, v = strtof(value, 0);
                    limits_for(key, &lo, &hi);
                    *(float *)((char *)r + FLOAT_KEYS[i].offset) = v < lo ? lo : v > hi ? hi : v;
                    recognised++;
                    break;
                }
            }
        }
        if (!end) break;
        line = end + 1;
    }
    return recognised;
}

int look_format(const look_recipe *r, char *out, int size) {
    int film = r->film >= 0 && r->film < N_FILMS ? r->film : 0;
    int n = snprintf(out, (size_t)size, "x1d-look = 1\nfilm = %s\nmono = %d\nmono_mix = %.3f, %.3f, %.3f\n",
                     FILM_NAMES[film], r->mono, r->mono_red, r->mono_green, r->mono_blue);
    for (int i = 0; i < N_FLOAT_KEYS && n < size; i++)
        n += snprintf(out + n, (size_t)(size - n), "%s = %.3f\n", FLOAT_KEYS[i].key,
                      *(const float *)((const char *)r + FLOAT_KEYS[i].offset));
    if (n < size)
        n += snprintf(out + n, (size_t)(size - n), "grade_shadows = %.1f, %.3f\ngrade_highlights = %.1f, %.3f\n",
                      r->grade_shadow_hue, r->grade_shadow_amount, r->grade_highlight_hue, r->grade_highlight_amount);
    for (int band = 0; band < LOOK_MIX_BANDS && n < size; band++)
        n += snprintf(out + n, (size_t)(size - n), "mix_%s = %.3f, %.3f, %.3f\n", MIX_BANDS[band].name,
                      r->mix_hue[band], r->mix_saturation[band], r->mix_lightness[band]);
    if (n < size) n += snprintf(out + n, (size_t)(size - n), "seed = %u\n", r->seed);
    return n;
}

int look_is_mono(const look_recipe *r) { return r->mono || r->film == LOOK_FILM_SILVER; }

/* Each film's own tone, on top of which the recipe's settings go. Muted has harder shadows than
 * standard; Silver has deep blacks, a little more midtone contrast and bright highlights.
 * Amounts are in the recipe's own units; mid grey moves by 3% at most. */
typedef struct { float shadows, highlights, contrast; } film_tone;
static film_tone tone_of(int film) {
    switch (film) {
    case LOOK_FILM_MUTED: return (film_tone){-0.3f, 0.05f, 0.05f};
    case LOOK_FILM_SILVER: return (film_tone){-0.35f, 0.15f, 0.2f};
    default: return (film_tone){0.f, 0.f, 0.f};
    }
}

/* Tone curve on an sRGB-encoded brightness value. Endpoints stay fixed and every setting in
 * -1..1 keeps the curve rising, so no setting can invert tones (the film's own tone included:
 * the sums are clamped to -1..1 before use). */
static float tone(const look_recipe *r, float x) {
    film_tone f = tone_of(r->film);
    float shadows = fmaxf(-1.f, fminf(1.f, r->shadows + f.shadows));
    float highlights = fmaxf(-1.f, fminf(1.f, r->highlights + f.highlights));
    float contrast = fmaxf(-1.f, fminf(1.f, r->contrast + f.contrast));
    float shadow_weight = 6.75f * x * (1.f - x) * (1.f - x);   /* peaks at 1/3 */
    float highlight_weight = 6.75f * x * x * (1.f - x);        /* peaks at 2/3 */
    x += 0.15f * shadows * shadow_weight + 0.15f * highlights * highlight_weight;
    /* dynamic range: a shoulder near white (x^4 (1-x) peaks at 0.8; 12.2 scales that peak to 1).
     * At full strength the slope stays above 0.7, so tones never invert */
    x -= 0.1f * r->dynamic_range * 12.2f * x * x * x * x * (1.f - x);
    x = clamp01(x);
    float s = x * x * (3.f - 2.f * x);
    x += 0.6f * contrast * (s - x);
    return clamp01(x);
}

/* ---- Oklab: a perceptual colour space where hue and chroma can be changed without the
 * brightness drifting (Björn Ottosson, 2020). In and out: linear sRGB. */
static void linear_to_oklab(const float c[3], float lab[3]) {
    float l = 0.4122214708f * c[0] + 0.5363325363f * c[1] + 0.0514459929f * c[2];
    float m = 0.2119034982f * c[0] + 0.6806995451f * c[1] + 0.1073969566f * c[2];
    float s = 0.0883024619f * c[0] + 0.2817188376f * c[1] + 0.6299787005f * c[2];
    l = cbrtf(l); m = cbrtf(m); s = cbrtf(s);
    lab[0] = 0.2104542553f * l + 0.7936177850f * m - 0.0040720468f * s;
    lab[1] = 1.9779984951f * l - 2.4285922050f * m + 0.4505937099f * s;
    lab[2] = 0.0259040371f * l + 0.7827717662f * m - 0.8086757660f * s;
}

static void oklab_to_linear(const float lab[3], float c[3]) {
    float l = lab[0] + 0.3963377774f * lab[1] + 0.2158037573f * lab[2];
    float m = lab[0] - 0.1055613458f * lab[1] - 0.0638541728f * lab[2];
    float s = lab[0] - 0.0894841775f * lab[1] - 1.2914855480f * lab[2];
    l = l * l * l; m = m * m * m; s = s * s * s;
    c[0] = 4.0767416621f * l - 3.3077115913f * m + 0.2309699292f * s;
    c[1] = -1.2684380046f * l + 2.6097574011f * m - 0.3413193965f * s;
    c[2] = -0.0041960863f * l - 0.7034186147f * m + 1.7076147010f * s;
    for (int i = 0; i < 3; i++) if (c[i] < 0.f) c[i] = 0.f;
}

/* 1 at `centre` degrees of hue, falling smoothly to 0 at `width` degrees either side */
static float hue_bump(float hue, float centre, float width) {
    float d = fabsf(fmodf(hue - centre + 540.f, 360.f) - 180.f);
    if (d >= width) return 0.f;
    float c = cosf(1.5707963f * d / width);
    return c * c;
}

/* The Muted film's colour (inspired by Fujifilm's Classic Chrome, from how its pictures look):
 * everything a little less colourful, blues turned towards cyan and quietened, greens turned
 * towards yellow (olive) and quietened most, reds held back a little, skin left as it is. Oklab
 * hues: red 30, skin 55, yellow 110, green 140, cyan 195, blue 265. */
static void muted_colour(float lab[3]) {
    float chroma = sqrtf(lab[1] * lab[1] + lab[2] * lab[2]);
    if (chroma < 1e-6f) return;
    float hue = atan2f(lab[2], lab[1]) * 57.29578f;
    float blue = hue_bump(hue, 265.f, 50.f), green = hue_bump(hue, 140.f, 45.f), red = hue_bump(hue, 25.f, 30.f),
          skin = hue_bump(hue, 55.f, 25.f), cyan = hue_bump(hue, 195.f, 35.f);
    float gain = 0.8f * (1.f - 0.15f * blue) * (1.f - 0.2f * green) * (1.f - 0.08f * red) * (1.f - 0.15f * cyan) *
                 (1.f + 0.15f * skin);
    hue += -12.f * blue - 15.f * green + 5.f * red;
    lab[0] -= 0.02f * green * fminf(1.f, chroma / 0.1f);
    chroma *= gain;
    lab[1] = chroma * cosf(hue / 57.29578f);
    lab[2] = chroma * sinf(hue / 57.29578f);
}

/* Colour depth (and its blue-only version): strong colours get darker and denser, so they keep
 * their gradation instead of glowing flat; greys and weak colours are left alone. */
static void colour_depth(const look_recipe *r, float lab[3]) {
    float chroma = sqrtf(lab[1] * lab[1] + lab[2] * lab[2]);
    float t = clamp01((chroma - 0.04f) / 0.14f), strong = t * t * (3.f - 2.f * t);
    float blue = chroma > 1e-6f ? hue_bump(atan2f(lab[2], lab[1]) * 57.29578f, 265.f, 45.f) : 0.f;
    lab[0] *= 1.f - 0.15f * strong * (r->colour_depth + r->blue_depth * blue);
}

static float smoothstep01(float t) {
    t = clamp01(t);
    return t * t * (3.f - 2.f * t);
}

/* What look_pixel works out once per recipe rather than once per pixel: table builds and photo
 * developments prepare once and then run every pixel through pixel(). */
typedef struct {
    int mixer;
    float shadow_tint[2], highlight_tint[2];   /* Oklab directions of the grading hues */
    float balance_power;
} prepared;

static void grade_direction(float hue, float out[2]);

static void prepare(const look_recipe *r, prepared *p) {
    p->mixer = 0;
    for (int band = 0; band < LOOK_MIX_BANDS; band++)
        if (r->mix_hue[band] != 0.f || r->mix_saturation[band] != 0.f || r->mix_lightness[band] != 0.f) p->mixer = 1;
    grade_direction(r->grade_shadow_hue, p->shadow_tint);
    grade_direction(r->grade_highlight_hue, p->highlight_tint);
    p->balance_power = exp2f(-r->grade_balance);
}

/* Colour mixer and vibrance, on an Oklab colour. Between two band centres the adjustment blends
 * smoothly from one band's to the next, so every hue gets one, and moving every band the same
 * way moves every colour the same way. Greys have no hue and are left alone. */
static void mix_and_vibrance(const look_recipe *r, const prepared *p, float lab[3]) {
    float chroma = sqrtf(lab[1] * lab[1] + lab[2] * lab[2]);
    if (chroma < 1e-6f) return;
    float hue = atan2f(lab[2], lab[1]) * 57.29578f;
    if (hue < 0.f) hue += 360.f;
    if (p->mixer) {
        int below = LOOK_MIX_BANDS - 1;
        for (int band = 0; band < LOOK_MIX_BANDS; band++)
            if (MIX_BANDS[band].hue <= hue) below = band;
        int above = (below + 1) % LOOK_MIX_BANDS;
        float from = MIX_BANDS[below].hue, to = MIX_BANDS[above].hue;
        if (to <= from) to += 360.f;
        float at = hue < from ? hue + 360.f : hue;
        float s = smoothstep01((at - from) / (to - from)), keep = 1.f - s;
        float turn = keep * r->mix_hue[below] + s * r->mix_hue[above];
        float saturation = keep * r->mix_saturation[below] + s * r->mix_saturation[above];
        float lightness = keep * r->mix_lightness[below] + s * r->mix_lightness[above];
        /* weak colours change less in lightness, so a near-grey wall doesn't go blotchy */
        lab[0] *= 1.f + 0.25f * lightness * smoothstep01(chroma / 0.08f);
        hue += 30.f * turn;
        chroma *= 1.f + saturation;
    }
    if (r->vibrance != 0.f) {
        /* most for weak colours, nothing past strong ones; when adding, skin gets less */
        float weak = 1.f - smoothstep01(chroma / 0.2f);
        float skin = r->vibrance > 0.f ? 0.5f * hue_bump(hue, 55.f, 30.f) : 0.f;
        chroma *= 1.f + 0.8f * r->vibrance * weak * (1.f - skin);
    }
    lab[1] = chroma * cosf(hue / 57.29578f);
    lab[2] = chroma * sinf(hue / 57.29578f);
}

/* The Oklab direction of a hue on the usual colour wheel: that of the fully saturated sRGB colour */
static void grade_direction(float hue, float out[2]) {
    float h = fmodf(hue, 360.f) / 60.f;
    if (h < 0.f) h += 6.f;
    float x = 1.f - fabsf(fmodf(h, 2.f) - 1.f), rgb[3];
    switch ((int)h) {
    case 0: rgb[0] = 1.f; rgb[1] = x; rgb[2] = 0.f; break;
    case 1: rgb[0] = x; rgb[1] = 1.f; rgb[2] = 0.f; break;
    case 2: rgb[0] = 0.f; rgb[1] = 1.f; rgb[2] = x; break;
    case 3: rgb[0] = 0.f; rgb[1] = x; rgb[2] = 1.f; break;
    case 4: rgb[0] = x; rgb[1] = 0.f; rgb[2] = 1.f; break;
    default: rgb[0] = 1.f; rgb[1] = 0.f; rgb[2] = x; break;
    }
    float lin[3] = {srgb_to_linear(rgb[0]), srgb_to_linear(rgb[1]), srgb_to_linear(rgb[2])}, lab[3];
    linear_to_oklab(lin, lab);
    float length = sqrtf(lab[1] * lab[1] + lab[2] * lab[2]);
    out[0] = lab[1] / length;
    out[1] = lab[2] / length;
}

static void colour_of_lab(float a, float b, float rgb[3]) {
    float lab[3] = {0.72f, a, b}, lin[3];
    oklab_to_linear(lab, lin);
    for (int c = 0; c < 3; c++) rgb[c] = linear_to_srgb(clamp01(lin[c]));
}

void look_grade_colour(float hue, float rgb[3]) {
    float d[2];
    grade_direction(hue, d);
    colour_of_lab(0.12f * d[0], 0.12f * d[1], rgb);
}

void look_mix_band_colour(int band, float rgb[3]) {
    float hue = MIX_BANDS[band >= 0 && band < LOOK_MIX_BANDS ? band : 0].hue / 57.29578f;
    colour_of_lab(0.13f * cosf(hue), 0.13f * sinf(hue), rgb);
}

/* Colour grading: the shadow tint fades out towards the highlights and the other way round, with
 * balance moving where they meet. Black and white keep a little of their purity: the tints thin
 * out in the last few percent at either end. */
static void grade(const look_recipe *r, const prepared *p, float lab[3]) {
    float lightness = clamp01(lab[0]);
    float t = p->balance_power == 1.f ? lightness : powf(lightness, p->balance_power);
    float shadow = (1.f - t) * (1.f - t) * fminf(1.f, lightness / 0.08f) * r->grade_shadow_amount;
    float highlight = t * t * fminf(1.f, (1.f - lightness) / 0.1f) * r->grade_highlight_amount;
    lab[1] += 0.08f * (shadow * p->shadow_tint[0] + highlight * p->highlight_tint[0]);
    lab[2] += 0.08f * (shadow * p->shadow_tint[1] + highlight * p->highlight_tint[1]);
}

/* Brightness on linear light: like exposure in the shadows and midtones, rolling off into white
 * instead of clipping, and the mirror of that when darkening. Black and white stay where they are. */
static float brighten(const look_recipe *r, float luma) {
    if (r->brightness == 0.f) return luma;
    float g = exp2f(r->brightness);
    return g * luma / (1.f + (g - 1.f) * luma);
}

/* Fade, on the finished sRGB value of each channel: blacks lifted towards grey and whites softened,
 * each mostly at its own end so the midtones stay put. Neutral grey is added, so faded shadows
 * also lose a little colour, as on a matte print. */
static float fade(const look_recipe *r, float x) {
    float dark = 1.f - x;
    return x + r->fade * (0.13f * dark * dark * dark - 0.06f * x * x * x);
}

static void pixel(const look_recipe *r, const prepared *p, float rgb[3]) {
    float lin[3] = {srgb_to_linear(clamp01(rgb[0])), srgb_to_linear(clamp01(rgb[1])),
                    srgb_to_linear(clamp01(rgb[2]))};
    const float wr = 0.2126f, wg = 0.7152f, wb = 0.0722f;
    float before = wr * lin[0] + wg * lin[1] + wb * lin[2];

    /* colour shift: gains on red and blue, like a white-balance shift, brightness kept */
    lin[0] *= exp2f(0.35f * r->shift_red);
    lin[2] *= exp2f(0.35f * r->shift_blue);
    float after = wr * lin[0] + wg * lin[1] + wb * lin[2];
    if (after > 1e-6f) {
        float k = before / after;
        lin[0] *= k;
        lin[1] *= k;
        lin[2] *= k;
    }

    float luma;
    int mono = look_is_mono(r);
    if (mono) {
        luma = r->mono_red * lin[0] + r->mono_green * lin[1] + r->mono_blue * lin[2];
        lin[0] = lin[1] = lin[2] = luma;
    } else {
        /* the film's colour first, then colour depth, then the recipe's saturation adjusting the
         * chosen film. Skipped when unused, so older recipes give exactly what they gave before */
        if (r->film == LOOK_FILM_MUTED || r->colour_depth > 0.f || r->blue_depth > 0.f || r->vibrance != 0.f ||
            p->mixer) {
            float lab[3];
            linear_to_oklab(lin, lab);
            if (r->film == LOOK_FILM_MUTED) muted_colour(lab);
            colour_depth(r, lab);
            mix_and_vibrance(r, p, lab);
            oklab_to_linear(lab, lin);
        }
        luma = wr * lin[0] + wg * lin[1] + wb * lin[2];
        float sat = 1.f + r->saturation;
        for (int c = 0; c < 3; c++) lin[c] = luma + (lin[c] - luma) * sat;
        for (int c = 0; c < 3; c++) if (lin[c] < 0.f) lin[c] = 0.f;
        luma = wr * lin[0] + wg * lin[1] + wb * lin[2];
    }

    /* tone on brightness only, then scale all channels: keeps hue */
    if (luma > 1e-7f) {
        float target = srgb_to_linear(tone(r, linear_to_srgb(clamp01(brighten(r, luma)))));
        float k = target / luma;
        for (int c = 0; c < 3; c++) lin[c] *= k;
    } else {
        float t = srgb_to_linear(tone(r, 0.f));
        lin[0] = lin[1] = lin[2] = t;
    }
    /* toning a black and white picture, strongest in the midtones so black stays black and
     * white stays white */
    int toning = mono && (r->tone_warm != 0.f || r->tone_magenta != 0.f);
    if (toning || r->grade_shadow_amount > 0.f || r->grade_highlight_amount > 0.f) {
        float lab[3];
        linear_to_oklab(lin, lab);
        if (toning) {
            float mid = 4.f * clamp01(lab[0]) * (1.f - clamp01(lab[0]));
            /* warm is Oklab's yellow direction; magenta sits between its red and blue directions */
            lab[1] += 0.03f * r->tone_magenta * mid;
            lab[2] += (0.05f * r->tone_warm - 0.015f * r->tone_magenta) * mid;
        }
        grade(r, p, lab);
        oklab_to_linear(lab, lin);
    }
    for (int c = 0; c < 3; c++) rgb[c] = linear_to_srgb(clamp01(lin[c]));
    if (r->fade > 0.f)
        for (int c = 0; c < 3; c++) rgb[c] = fade(r, rgb[c]);
}

void look_pixel(const look_recipe *r, float rgb[3]) {
    prepared p;
    prepare(r, &p);
    pixel(r, &p, rgb);
}

void look_build_rgb_table(const look_recipe *r, int n, float *table) {
    prepared prep;
    prepare(r, &prep);
    for (int b = 0; b < n; b++)
        for (int g = 0; g < n; g++)
            for (int red = 0; red < n; red++) {
                float *p = table + 3 * ((b * n + g) * n + red);
                p[0] = (float)red / (float)(n - 1);
                p[1] = (float)g / (float)(n - 1);
                p[2] = (float)b / (float)(n - 1);
                pixel(r, &prep, p);
            }
}

void look_table_apply(const float *table, int n, float rgb[3]) {
    float f[3];
    int i0[3], i1[3];
    for (int c = 0; c < 3; c++) {
        float x = clamp01(rgb[c]) * (float)(n - 1);
        i0[c] = (int)x;
        if (i0[c] > n - 2) i0[c] = n - 2;
        i1[c] = i0[c] + 1;
        f[c] = x - (float)i0[c];
    }
    float out[3] = {0, 0, 0};
    for (int corner = 0; corner < 8; corner++) {
        int ir = corner & 1 ? i1[0] : i0[0], ig = corner & 2 ? i1[1] : i0[1], ib = corner & 4 ? i1[2] : i0[2];
        float w = (corner & 1 ? f[0] : 1.f - f[0]) * (corner & 2 ? f[1] : 1.f - f[1]) * (corner & 4 ? f[2] : 1.f - f[2]);
        const float *p = table + 3 * ((ib * n + ig) * n + ir);
        for (int c = 0; c < 3; c++) out[c] += w * p[c];
    }
    for (int c = 0; c < 3; c++) rgb[c] = out[c];
}

/* BT.601, video range: Y 16..235, U and V 16..240 */
void look_yuv_to_rgb(float y, float u, float v, float rgb[3]) {
    float yl = (y - 16.f) / 219.f, cb = (u - 128.f) / 224.f, cr = (v - 128.f) / 224.f;
    rgb[0] = clamp01(yl + 1.402f * cr);
    rgb[1] = clamp01(yl - 0.344136f * cb - 0.714136f * cr);
    rgb[2] = clamp01(yl + 1.772f * cb);
}

void look_rgb_to_yuv(const float rgb[3], float yuv[3]) {
    float yl = 0.299f * rgb[0] + 0.587f * rgb[1] + 0.114f * rgb[2];
    yuv[0] = 16.f + 219.f * yl;
    yuv[1] = 128.f + 224.f * (rgb[2] - yl) / 1.772f;
    yuv[2] = 128.f + 224.f * (rgb[0] - yl) / 1.402f;
}

static unsigned char byte_of(float x) {
    x = x + 0.5f;
    return x < 0.f ? 0 : x > 255.f ? 255 : (unsigned char)x;
}

void look_build_yuv_table(const look_recipe *r, int n, unsigned char *table) {
    prepared prep;
    prepare(r, &prep);
    for (int v = 0; v < n; v++)
        for (int u = 0; u < n; u++)
            for (int y = 0; y < n; y++) {
                float rgb[3], yuv[3];
                float step = 255.f / (float)(n - 1);
                look_yuv_to_rgb((float)y * step, (float)u * step, (float)v * step, rgb);
                pixel(r, &prep, rgb);
                look_rgb_to_yuv(rgb, yuv);
                unsigned char *p = table + 3 * ((v * n + u) * n + y);
                p[0] = byte_of(yuv[0]);
                p[1] = byte_of(yuv[1]);
                p[2] = byte_of(yuv[2]);
            }
}

/* Trilinear lookup in the YUV table, as three rounded linear passes (Y, then U, then V) in
 * 8.8 fixed point. Multiplying three truncated weights instead loses up to 3% brightness. */
static void yuv_lookup(const unsigned char *table, int n, int y, int u, int v, int out[3]) {
    int scale = (n - 1) * 256;
    int fy = y * scale / 255, fu = u * scale / 255, fv = v * scale / 255;
    int iy = fy >> 8, iu = fu >> 8, iv = fv >> 8;
    if (iy > n - 2) iy = n - 2;
    if (iu > n - 2) iu = n - 2;
    if (iv > n - 2) iv = n - 2;
    int wy = fy - (iy << 8), wu = fu - (iu << 8), wv = fv - (iv << 8);
    for (int c = 0; c < 3; c++) {
        int along_u[2];
        for (int dv = 0; dv < 2; dv++) {
            int along_y[2];
            for (int du = 0; du < 2; du++) {
                const unsigned char *p = table + 3 * (((iv + dv) * n + iu + du) * n + iy) + c;
                along_y[du] = (p[0] << 8) + (p[3] - p[0]) * wy;
            }
            along_u[dv] = along_y[0] + (((along_y[1] - along_y[0]) * wu + 128) >> 8);
        }
        int value = along_u[0] + (((along_u[1] - along_u[0]) * wv + 128) >> 8);
        out[c] = (value + 128) >> 8;
    }
}

void look_apply_nv12(const unsigned char *table, int n, unsigned char *y_plane, int y_stride,
                     unsigned char *uv_plane, int uv_stride, int width, int height) {
    for (int by = 0; by < height / 2; by++) {
        unsigned char *uv = uv_plane + by * uv_stride;
        unsigned char *row0 = y_plane + (2 * by) * y_stride, *row1 = row0 + y_stride;
        for (int bx = 0; bx < width / 2; bx++) {
            int u = uv[2 * bx], v = uv[2 * bx + 1];
            int out[3], su = 0, sv = 0;
            unsigned char *px[4] = {row0 + 2 * bx, row0 + 2 * bx + 1, row1 + 2 * bx, row1 + 2 * bx + 1};
            for (int k = 0; k < 4; k++) {
                yuv_lookup(table, n, *px[k], u, v, out);
                *px[k] = (unsigned char)(out[0] > 255 ? 255 : out[0]);
                su += out[1];
                sv += out[2];
            }
            uv[2 * bx] = (unsigned char)((su + 2) >> 2);
            uv[2 * bx + 1] = (unsigned char)((sv + 2) >> 2);
        }
    }
}

/* Table layout: [u][v][y] for brightness, [u][v][y][2] for colour. For one colour corner, y runs
 * contiguously, so neighbouring pixels of similar brightness hit the same cache lines. */
void look_build_nv12_tables(const look_recipe *r, unsigned char *y_table, unsigned char *uv_table) {
    look_build_nv12_tables_part(r, y_table, uv_table, 0, LOOK_UV_N);
}

void look_build_nv12_tables_part(const look_recipe *r, unsigned char *y_table, unsigned char *uv_table,
                                 int u_begin, int u_end) {
    prepared prep;
    prepare(r, &prep);
    for (int iu = u_begin; iu < u_end; iu++)
        for (int iv = 0; iv < LOOK_UV_N; iv++)
            for (int y = 0; y < 256; y++) {
                float rgb[3], yuv[3];
                float step = 255.f / (float)(LOOK_UV_N - 1);
                look_yuv_to_rgb((float)y, (float)iu * step, (float)iv * step, rgb);
                pixel(r, &prep, rgb);
                look_rgb_to_yuv(rgb, yuv);
                int at = (iu * LOOK_UV_N + iv) * 256 + y;
                y_table[at] = byte_of(yuv[0]);
                uv_table[2 * at] = byte_of(yuv[1]);
                uv_table[2 * at + 1] = byte_of(yuv[2]);
            }
}

typedef struct { unsigned char index, weight; } grid_step;
static grid_step uv_steps[256];
static int uv_steps_ready;

static void init_uv_steps(void) {
    for (int x = 0; x < 256; x++) {
        int fixed = x * (LOOK_UV_N - 1) * 256 / 255;   /* 8.8 position on the grid */
        int index = fixed >> 8;
        if (index > LOOK_UV_N - 2) index = LOOK_UV_N - 2;
        uv_steps[x].index = (unsigned char)index;
        uv_steps[x].weight = (unsigned char)(fixed - (index << 8) > 255 ? 255 : fixed - (index << 8));
    }
    uv_steps_ready = 1;
}

static inline int blend4(const unsigned char *c00, const unsigned char *c01, const unsigned char *c10,
                         const unsigned char *c11, int at, int wu, int wv) {
    int top = (c00[at] << 8) + (c01[at] - c00[at]) * wv;
    int bottom = (c10[at] << 8) + (c11[at] - c10[at]) * wv;
    return ((top << 8) + (bottom - top) * wu + 32768) >> 16;
}

void look_apply_nv12_fast(const unsigned char *y_table, const unsigned char *uv_table,
                          unsigned char *y_plane, int y_stride, unsigned char *uv_plane, int uv_stride,
                          int width, int row_begin, int row_end) {
    if (!uv_steps_ready) init_uv_steps();
    const int corner_step = 256, row_step = LOOK_UV_N * 256;
    for (int y = row_begin; y < row_end; y += 2) {
        unsigned char *row0 = y_plane + y * y_stride, *row1 = row0 + y_stride;
        unsigned char *uv = uv_plane + (y / 2) * uv_stride;
        for (int x = 0; x < width; x += 2) {
            grid_step su = uv_steps[uv[x]], sv = uv_steps[uv[x + 1]];
            int base = su.index * row_step + sv.index * corner_step;
            const unsigned char *c00 = y_table + base, *c01 = c00 + corner_step;
            const unsigned char *c10 = c00 + row_step, *c11 = c10 + corner_step;
            int wu = su.weight, wv = sv.weight;
            int y00 = row0[x], y01 = row0[x + 1], y10 = row1[x], y11 = row1[x + 1];
            row0[x] = (unsigned char)blend4(c00, c01, c10, c11, y00, wu, wv);
            row0[x + 1] = (unsigned char)blend4(c00, c01, c10, c11, y01, wu, wv);
            row1[x] = (unsigned char)blend4(c00, c01, c10, c11, y10, wu, wv);
            row1[x + 1] = (unsigned char)blend4(c00, c01, c10, c11, y11, wu, wv);
            /* one colour per block, looked up at the block's mean brightness */
            int mean = (y00 + y01 + y10 + y11 + 2) >> 2;
            const unsigned char *d00 = uv_table + 2 * base, *d01 = d00 + 2 * corner_step;
            const unsigned char *d10 = d00 + 2 * row_step, *d11 = d10 + 2 * corner_step;
            uv[x] = (unsigned char)blend4(d00, d01, d10, d11, 2 * mean, wu, wv);
            uv[x + 1] = (unsigned char)blend4(d00, d01, d10, d11, 2 * mean + 1, wu, wv);
        }
    }
}

int look_nv12_uv_is_neutral(const unsigned char *uv_table) {
    for (int i = 0; i < LOOK_NV12_UV_TABLE_SIZE; i++)
        if (uv_table[i] != 128) return 0;
    return 1;
}

/* look_apply_nv12_fast when every colour in the table is neutral (black and white): brightness as
 * usual, colour straight to 128. A blend of four 128s is exactly 128, so the result is identical. */
void look_apply_nv12_fast_mono(const unsigned char *y_table, unsigned char *y_plane, int y_stride,
                               unsigned char *uv_plane, int uv_stride, int width, int row_begin, int row_end) {
    if (!uv_steps_ready) init_uv_steps();
    const int corner_step = 256, row_step = LOOK_UV_N * 256;
    for (int y = row_begin; y < row_end; y += 2) {
        unsigned char *row0 = y_plane + y * y_stride, *row1 = row0 + y_stride;
        unsigned char *uv = uv_plane + (y / 2) * uv_stride;
        for (int x = 0; x < width; x += 2) {
            grid_step su = uv_steps[uv[x]], sv = uv_steps[uv[x + 1]];
            int base = su.index * row_step + sv.index * corner_step;
            const unsigned char *c00 = y_table + base, *c01 = c00 + corner_step;
            const unsigned char *c10 = c00 + row_step, *c11 = c10 + corner_step;
            int wu = su.weight, wv = sv.weight;
            row0[x] = (unsigned char)blend4(c00, c01, c10, c11, row0[x], wu, wv);
            row0[x + 1] = (unsigned char)blend4(c00, c01, c10, c11, row0[x + 1], wu, wv);
            row1[x] = (unsigned char)blend4(c00, c01, c10, c11, row1[x], wu, wv);
            row1[x + 1] = (unsigned char)blend4(c00, c01, c10, c11, row1[x + 1], wu, wv);
            uv[x] = 128;
            uv[x + 1] = 128;
        }
    }
}

/* The same tables regrouped per colour cell: for every brightness, the cell's four corners next to
 * each other, so one load fetches all four (y_corners: 4 bytes; uv_corners: 4 U,V pairs). */
#define UV_CELLS (LOOK_UV_N - 1)
void look_build_nv12_corners(const unsigned char *y_table, const unsigned char *uv_table,
                             unsigned char *y_corners, unsigned char *uv_corners) {
    for (int iu = 0; iu < UV_CELLS; iu++)
        for (int iv = 0; iv < UV_CELLS; iv++)
            for (int k = 0; k < 4; k++) {
                /* k: 0 this corner, 1 the next v, 2 the next u, 3 both */
                int from = ((iu + (k >> 1)) * LOOK_UV_N + iv + (k & 1)) * 256, cell = iu * UV_CELLS + iv;
                for (int y = 0; y < 256; y++) {
                    y_corners[(cell * 256 + y) * 4 + k] = y_table[from + y];
                    if (!uv_corners) continue;
                    uv_corners[((cell * 256 + y) * 4 + k) * 2] = uv_table[2 * (from + y)];
                    uv_corners[((cell * 256 + y) * 4 + k) * 2 + 1] = uv_table[2 * (from + y) + 1];
                }
            }
}

/* blend4 over four corners `step` bytes apart */
static inline int blend_corners(const unsigned char *c, int step, int wu, int wv) {
    int top = (c[0] << 8) + (c[step] - c[0]) * wv;
    int bottom = (c[2 * step] << 8) + (c[3 * step] - c[2 * step]) * wv;
    return ((top << 8) + (bottom - top) * wu + 32768) >> 16;
}

#if defined(__ARM_NEON)
/* uv_steps' weights, computed for eight grid positions at once: floor(x * 8192 / 255) is
 * 32x + floor(32x / 255), and init_uv_steps checks that against the table for all 256 values */
static inline uint16x8_t uv_weights(uint8x8_t x) {
    uint16x8_t t = vshll_n_u8(x, 5);
    uint16x8_t fixed = vaddq_u16(t, vshrq_n_u16(vaddq_u16(vaddq_u16(t, vshrq_n_u16(t, 8)), vdupq_n_u16(1)), 8));
    uint16x8_t index = vminq_u16(vshrq_n_u16(fixed, 8), vdupq_n_u16(LOOK_UV_N - 2));
    return vminq_u16(vsubq_u16(fixed, vshlq_n_u16(index, 8)), vdupq_n_u16(255));
}

static int uv_weights_match(void) {
    if (!uv_steps_ready) init_uv_steps();
    for (int x = 0; x < 256; x += 8) {
        uint8_t in[8];
        uint16_t out[8];
        for (int k = 0; k < 8; k++) in[k] = (uint8_t)(x + k);
        vst1q_u16(out, uv_weights(vld1_u8(in)));
        for (int k = 0; k < 8; k++)
            if (out[k] != uv_steps[x + k].weight) return 0;
    }
    return 1;
}

/* blend4 for eight pixels: c holds each pixel's four corners, wu and wv its weights */
static inline uint16x8_t blend8(uint16x8_t c00, uint16x8_t c01, uint16x8_t c10, uint16x8_t c11,
                                uint16x8_t wu, uint16x8_t wv) {
    /* both halves stay within 0..65280, so 16-bit wrap-around arithmetic lands on the exact value */
    uint16x8_t top = vmlaq_u16(vshlq_n_u16(c00, 8), vsubq_u16(c01, c00), wv);
    uint16x8_t bottom = vmlaq_u16(vshlq_n_u16(c10, 8), vsubq_u16(c11, c10), wv);
    /* (top << 8) + (bottom - top) * wu is top * (256 - wu) + bottom * wu */
    uint16x8_t iwu = vsubq_u16(vdupq_n_u16(256), wu);
    uint32x4_t lo = vmlal_u16(vmull_u16(vget_low_u16(top), vget_low_u16(iwu)), vget_low_u16(bottom), vget_low_u16(wu));
    uint32x4_t hi = vmlal_u16(vmull_u16(vget_high_u16(top), vget_high_u16(iwu)), vget_high_u16(bottom), vget_high_u16(wu));
    return vcombine_u16(vrshrn_n_u32(lo, 16), vrshrn_n_u32(hi, 16));
}

static inline uint8x8_t blend8_bytes(uint8x8x4_t c, uint16x8_t wu, uint16x8_t wv) {
    return vmovn_u16(blend8(vmovl_u8(c.val[0]), vmovl_u8(c.val[1]), vmovl_u8(c.val[2]), vmovl_u8(c.val[3]), wu, wv));
}

/* Eight pixels (two per block) of one row: each pixel's four corners in one load, sorted into one
 * vector per corner (val[k] = corner k of pixels 0..7). */
static inline uint8x8x4_t corners8(const unsigned char *const cell[4], eight_bytes px) {
    uint8x8x4_t c;
    c.val[0] = c.val[1] = c.val[2] = c.val[3] = vdup_n_u8(0);
    c = vld4_lane_u8(cell[0] + 4 * byte_at(px, 0), c, 0);
    c = vld4_lane_u8(cell[0] + 4 * byte_at(px, 1), c, 1);
    c = vld4_lane_u8(cell[1] + 4 * byte_at(px, 2), c, 2);
    c = vld4_lane_u8(cell[1] + 4 * byte_at(px, 3), c, 3);
    c = vld4_lane_u8(cell[2] + 4 * byte_at(px, 4), c, 4);
    c = vld4_lane_u8(cell[2] + 4 * byte_at(px, 5), c, 5);
    c = vld4_lane_u8(cell[3] + 4 * byte_at(px, 6), c, 6);
    c = vld4_lane_u8(cell[3] + 4 * byte_at(px, 7), c, 7);
    return c;
}

static void colour_rows_vector(const unsigned char *y_corners, const unsigned char *uv_corners,
                               unsigned char *y_plane, int y_stride, unsigned char *uv_plane, int uv_stride,
                               int width, int row_begin, int row_end) {
    static const uint8_t pick_u[8] = {0, 0, 2, 2, 4, 4, 6, 6}, pick_v[8] = {1, 1, 3, 3, 5, 5, 7, 7};
    static const uint8_t block_u[8] = {0, 2, 4, 6, 0, 2, 4, 6}, block_v[8] = {1, 3, 5, 7, 1, 3, 5, 7};
    static const uint8_t interleave[8] = {0, 4, 1, 5, 2, 6, 3, 7};
    const uint8x8_t pu = vld1_u8(pick_u), pv = vld1_u8(pick_v), bu = vld1_u8(block_u), bv = vld1_u8(block_v);
    const uint8x8_t mix = vld1_u8(interleave);
    for (int y = row_begin; y < row_end; y += 2) {
        unsigned char *row0 = y_plane + y * y_stride, *row1 = row0 + y_stride;
        unsigned char *uv = uv_plane + (y / 2) * uv_stride;
        for (int x = 0; x < width; x += 8) {
            /* four 2x2 blocks: their colour cells and weights */
            eight_bytes colours = load_eight(uv + x), top = load_eight(row0 + x), under = load_eight(row1 + x);
            uint8x8_t uvs = eight_vector(colours);
            const unsigned char *cell[4];
            for (int b = 0; b < 4; b++)
                cell[b] = y_corners + (uv_steps[byte_at(colours, 2 * b)].index * UV_CELLS +
                                       uv_steps[byte_at(colours, 2 * b + 1)].index) * 1024;
            uint8x8x4_t r0 = corners8(cell, top), r1 = corners8(cell, under);
            if (uv_corners) {
                /* one colour per block, at the block's mean brightness before the look */
                uint16x4x4_t d;
                d.val[0] = d.val[1] = d.val[2] = d.val[3] = vdup_n_u16(0);
#define BLOCK_COLOUR(b) do { \
                    int mean = (int)(byte_at(top, 2 * (b)) + byte_at(top, 2 * (b) + 1) + byte_at(under, 2 * (b)) + \
                                     byte_at(under, 2 * (b) + 1) + 2) >> 2; \
                    const unsigned char *c = uv_corners + (cell[b] - y_corners) * 2 + 8 * mean; \
                    d = vld4_lane_u16((const uint16_t *)(const void *)c, d, b); \
                } while (0)
                BLOCK_COLOUR(0);
                BLOCK_COLOUR(1);
                BLOCK_COLOUR(2);
                BLOCK_COLOUR(3);
#undef BLOCK_COLOUR
                /* lanes 0-3: U of the four blocks, 4-7: V */
                const uint16x4_t low = vdup_n_u16(255);
                uint16x8_t c00 = vcombine_u16(vand_u16(d.val[0], low), vshr_n_u16(d.val[0], 8));
                uint16x8_t c01 = vcombine_u16(vand_u16(d.val[1], low), vshr_n_u16(d.val[1], 8));
                uint16x8_t c10 = vcombine_u16(vand_u16(d.val[2], low), vshr_n_u16(d.val[2], 8));
                uint16x8_t c11 = vcombine_u16(vand_u16(d.val[3], low), vshr_n_u16(d.val[3], 8));
                uint8x8_t colour = vmovn_u16(blend8(c00, c01, c10, c11, uv_weights(vtbl1_u8(uvs, bu)), uv_weights(vtbl1_u8(uvs, bv))));
                vst1_u8(uv + x, vtbl1_u8(colour, mix));
            } else {
                vst1_u8(uv + x, vdup_n_u8(128));
            }
            uint16x8_t wu = uv_weights(vtbl1_u8(uvs, pu)), wv = uv_weights(vtbl1_u8(uvs, pv));
            vst1_u8(row0 + x, blend8_bytes(r0, wu, wv));
            vst1_u8(row1 + x, blend8_bytes(r1, wu, wv));
        }
    }
}
#endif

/* look_apply_nv12_fast (uv_corners set) or look_apply_nv12_fast_mono (uv_corners null), from
 * look_build_nv12_corners' tables. Same result, fewer loads. */
void look_apply_nv12_corners(const unsigned char *y_corners, const unsigned char *uv_corners,
                             unsigned char *y_plane, int y_stride, unsigned char *uv_plane, int uv_stride,
                             int width, int row_begin, int row_end) {
    if (!uv_steps_ready) init_uv_steps();
#if defined(__ARM_NEON)
    static int weights_checked, weights_ok;
    if (!weights_checked) {
        weights_ok = uv_weights_match();
        weights_checked = 1;
    }
    if (nv12_vector && weights_ok && width % 8 == 0) {
        colour_rows_vector(y_corners, uv_corners, y_plane, y_stride, uv_plane, uv_stride, width, row_begin, row_end);
        return;
    }
#endif
    for (int y = row_begin; y < row_end; y += 2) {
        unsigned char *row0 = y_plane + y * y_stride, *row1 = row0 + y_stride;
        unsigned char *uv = uv_plane + (y / 2) * uv_stride;
        for (int x = 0; x < width; x += 2) {
            grid_step su = uv_steps[uv[x]], sv = uv_steps[uv[x + 1]];
            int cell = su.index * UV_CELLS + sv.index, wu = su.weight, wv = sv.weight;
            const unsigned char *c = y_corners + cell * 1024;
            int y00 = row0[x], y01 = row0[x + 1], y10 = row1[x], y11 = row1[x + 1];
            row0[x] = (unsigned char)blend_corners(c + 4 * y00, 1, wu, wv);
            row0[x + 1] = (unsigned char)blend_corners(c + 4 * y01, 1, wu, wv);
            row1[x] = (unsigned char)blend_corners(c + 4 * y10, 1, wu, wv);
            row1[x + 1] = (unsigned char)blend_corners(c + 4 * y11, 1, wu, wv);
            if (uv_corners) {
                int mean = (y00 + y01 + y10 + y11 + 2) >> 2;
                const unsigned char *d = uv_corners + cell * 2048 + 8 * mean;
                uv[x] = (unsigned char)blend_corners(d, 2, wu, wv);
                uv[x + 1] = (unsigned char)blend_corners(d + 1, 2, wu, wv);
            } else {
                uv[x] = 128;
                uv[x + 1] = 128;
            }
        }
    }
}

/* ---- spatial effects ---- */

static unsigned int hash3(unsigned int seed, int x, int y) {
    unsigned int h = seed * 0x9e3779b9u ^ (unsigned int)x * 0x85ebca6bu ^ (unsigned int)y * 0xc2b2ae35u;
    h ^= h >> 16;
    h *= 0x7feb352du;
    h ^= h >> 15;
    h *= 0x846ca68bu;
    h ^= h >> 16;
    return h;
}

/* ---- grain ----
 * Film-like grain: per-pixel random noise smoothed to the grain size, plus a coarser layer
 * so grains clump. Sizes are fractions of the picture height, so a 640x480 live view and the
 * full photo have the same grain once both are seen at the same size. Grain changes brightness
 * only (equal on R, G and B), strongest in the midtones. */

/* approximately standard normal: the sum of four uniforms, rescaled */
static float gaussian_noise(unsigned int seed, int x, int y) {
    unsigned int a = hash3(seed, x, y), b = hash3(seed ^ 0x68bc21ebu, x, y);
    float sum = (float)(a & 0xffff) + (float)(a >> 16) + (float)(b & 0xffff) + (float)(b >> 16);
    return (sum / 65535.f - 2.f) * 1.7320508f;
}

/* Gaussian blur of one channel, wrapping at the edges so a tile repeats seamlessly. Returns the
 * factor that brings blurred white noise back to unit standard deviation. Blurring with a
 * normalised kernel k in both directions leaves a variance of (sum k^2)^2, so the standard
 * deviation shrinks by sum(k^2). */
typedef struct { float *field, *tmp; const float *kernel; int w, h, radius; } wrapped_blur_job;

/* along each row, through a copy of the row padded with its own wrapped ends */
static void wrapped_blur_rows(void *ctx, int row_begin, int row_end) {
    const wrapped_blur_job *j = ctx;
    int w = j->w, radius = j->radius;
    float *pad = malloc((size_t)(w + 2 * radius) * sizeof *pad);
    if (!pad) return;
    for (int y = row_begin; y < row_end; y++) {
        const float *in = j->field + (size_t)y * w;
        float *out = j->tmp + (size_t)y * w;
        for (int x = -radius; x < w + radius; x++) pad[x + radius] = in[((x % w) + w) % w];
        for (int x = 0; x < w; x++) out[x] = 0.f;
        for (int i = 0; i <= 2 * radius; i++) {
            float k = j->kernel[i];
            const float *src = pad + i;
            for (int x = 0; x < w; x++) out[x] += k * src[x];
        }
    }
    free(pad);
}

/* down each column: whole rows at a time, so memory is read in order */
static void wrapped_blur_columns(void *ctx, int row_begin, int row_end) {
    const wrapped_blur_job *j = ctx;
    int w = j->w, h = j->h, radius = j->radius;
    for (int y = row_begin; y < row_end; y++) {
        float *out = j->field + (size_t)y * w;
        for (int x = 0; x < w; x++) out[x] = 0.f;
        for (int i = -radius; i <= radius; i++) {
            float k = j->kernel[i + radius];
            const float *src = j->tmp + (size_t)((((y + i) % h) + h) % h) * w;
            for (int x = 0; x < w; x++) out[x] += k * src[x];
        }
    }
}

/* Gaussian blur of one channel, wrapping at the edges so a tile repeats seamlessly. Returns the
 * factor that brings blurred white noise back to unit standard deviation. Blurring with a
 * normalised kernel k in both directions leaves a variance of (sum k^2)^2, so the standard
 * deviation shrinks by sum(k^2). */
static float blur_wrapped(float *field, float *tmp, int w, int h, float sigma) {
    int radius = (int)ceilf(sigma * 3.f);
    if (radius > 64) radius = 64;
    float kernel[129], sum = 0.f, sum_sq = 0.f;
    for (int i = -radius; i <= radius; i++) sum += kernel[i + radius] = expf(-(float)(i * i) / (2.f * sigma * sigma));
    for (int i = 0; i <= 2 * radius; i++) {
        kernel[i] /= sum;
        sum_sq += kernel[i] * kernel[i];
    }
    wrapped_blur_job job = {field, tmp, kernel, w, h, radius};
    for_bands(h, &job, wrapped_blur_rows);
    for_bands(h, &job, wrapped_blur_columns);
    return 1.f / sum_sq;
}

float look_grain_length(const look_recipe *r, int image_height) {
    /* 0.025%..0.125% of the height: about 1.5..8 px on a full X1D frame */
    return (0.00025f + 0.001f * r->grain_size) * (float)image_height;
}

float look_grain_amplitude(const look_recipe *r, float brightness) {
    float t = powf(clamp01(brightness), 0.8f);
    return r->grain * 0.06f * (0.2f + 0.8f * 4.f * t * (1.f - t));
}

/* One layer of grain with correlation length `length` pixels, unit variance where the grain is
 * larger than a pixel, and weaker where it is smaller (several grains average inside a pixel). */
typedef struct { float *field; unsigned int seed; int w; float k; } noise_job;
static void fill_noise(void *ctx, int row_begin, int row_end) {
    const noise_job *j = ctx;
    for (int y = row_begin; y < row_end; y++)
        for (int x = 0; x < j->w; x++) j->field[(size_t)y * j->w + x] = gaussian_noise(j->seed, x, y);
}
static void scale_rows(void *ctx, int row_begin, int row_end) {
    const noise_job *j = ctx;
    for (size_t i = (size_t)row_begin * j->w; i < (size_t)row_end * j->w; i++) j->field[i] *= j->k;
}

static void grain_layer(unsigned int seed, int w, int h, float length, float *field, float *tmp) {
    noise_job job = {field, seed, w, 1.f};
    for_bands(h, &job, fill_noise);
    float sigma = 0.5f * length, restore = 1.f;
    if (sigma >= 0.3f) restore = blur_wrapped(field, tmp, w, h, sigma);
    float visible = length / sqrtf(length * length + 0.36f);
    job.k = restore * visible;
    for_bands(h, &job, scale_rows);
}

/* the three layers into one: the unshaped sum goes to coarse (for the variance), the shaped one to field */
typedef struct { float *field, *coarse; const float *fine; int w; float fine_weight; } combine_job;
static void combine_layers(void *ctx, int row_begin, int row_end) {
    const combine_job *j = ctx;
    for (size_t i = (size_t)row_begin * j->w; i < (size_t)row_end * j->w; i++) {
        float g = 0.8f * j->field[i] + 0.45f * j->coarse[i] + j->fine_weight * j->fine[i];
        j->coarse[i] = g;
        j->field[i] = g + 0.08f * g * g * g;
    }
}

int look_build_grain_field(const look_recipe *r, unsigned int seed, int w, int h, int image_height, float *field) {
    size_t n = (size_t)w * (size_t)h;
    float *coarse = malloc(n * sizeof *coarse), *fine = malloc(n * sizeof *fine), *tmp = malloc(n * sizeof *tmp);
    if (!coarse || !fine || !tmp) {
        free(coarse);
        free(fine);
        free(tmp);
        return 0;
    }
    float length = look_grain_length(r, image_height), finest = 0.00025f * (float)image_height;
    grain_layer(seed, w, h, length, field, tmp);
    grain_layer(seed ^ 0x5bd1e995u, w, h, 1.7f * length, coarse, tmp);
    grain_layer(seed ^ 0x27d4eb2fu, w, h, finest, fine, tmp);
    /* Blurred noise alone reads as soft cloud once the grain is several pixels wide. A little
     * of the finest grain gives the clumps texture, and a gentle cubic makes their edges firmer;
     * the result is rescaled to the variance before shaping so size doesn't change strength. */
    float fine_weight = 0.35f * (1.f - finest / length);
    combine_job job = {field, coarse, fine, w, fine_weight};
    for_bands(h, &job, combine_layers);
    /* the sums stay serial, in order, so they come out the same on every machine */
    double before = 0.0, after = 0.0;
    for (size_t i = 0; i < n; i++) {
        before += (double)coarse[i] * coarse[i];
        after += (double)field[i] * field[i];
    }
    noise_job rescale = {field, 0, w, after > 0.0 ? sqrtf((float)(before / after)) : 1.f};
    for_bands(h, &rescale, scale_rows);
    free(coarse);
    free(fine);
    free(tmp);
    return 1;
}

void look_build_grain_nv12(const look_recipe *r, unsigned int seed, int image_height, signed char *tile, short *amplitude) {
    float *field = malloc(sizeof(float) * LOOK_GRAIN_TILE * LOOK_GRAIN_TILE);
    if (field && look_build_grain_field(r, seed, LOOK_GRAIN_TILE, LOOK_GRAIN_TILE, image_height, field)) {
        for (int i = 0; i < LOOK_GRAIN_TILE * LOOK_GRAIN_TILE; i++) {
            float q = field[i] * 32.f;
            tile[i] = (signed char)(q > 127.f ? 127 : q < -127.f ? -127 : (int)(q + (q < 0.f ? -0.5f : 0.5f)));
        }
    } else {
        memset(tile, 0, LOOK_GRAIN_TILE * LOOK_GRAIN_TILE);
    }
    free(field);
    for (int y = 0; y < 256; y++) {
        float levels = look_grain_amplitude(r, clamp01(((float)y - 16.f) / 219.f)) * 219.f;
        amplitude[y] = (short)(levels * 256.f / 32.f + 0.5f);
    }
}

void look_apply_grain_nv12(const signed char *tile, const short *amplitude, unsigned int frame_seed,
                           unsigned char *y_plane, int y_stride, int width, int row_begin, int row_end) {
    unsigned int h = hash3(frame_seed, 17, 29);
    int ox = (int)(h & (LOOK_GRAIN_TILE - 1)), oy = (int)((h >> 8) & (LOOK_GRAIN_TILE - 1));
    for (int y = row_begin; y < row_end; y++) {
        unsigned char *row = y_plane + y * y_stride;
        const signed char *grain = tile + ((y + oy) & (LOOK_GRAIN_TILE - 1)) * LOOK_GRAIN_TILE;
#if defined(__ARM_NEON)
        if (nv12_vector && width % 8 == 0) {
            /* the tile row rotated by ox, so eight neighbours are always next to each other */
            signed char turned[LOOK_GRAIN_TILE];
            memcpy(turned, grain + ox, (size_t)(LOOK_GRAIN_TILE - ox));
            memcpy(turned + LOOK_GRAIN_TILE - ox, grain, (size_t)ox);
            for (int x = 0; x < width; x += 8) {
                eight_bytes px = load_eight(row + x);
                uint8x8_t v = eight_vector(px);
                int16x8_t g = vmovl_s8(vld1_s8(turned + (x & (LOOK_GRAIN_TILE - 1))));
                int16x8_t a = gather_shorts(amplitude, px);
                int16x8_t change = vcombine_s16(vrshrn_n_s32(vmull_s16(vget_low_s16(g), vget_low_s16(a)), 8),
                                                vrshrn_n_s32(vmull_s16(vget_high_s16(g), vget_high_s16(a)), 8));
                vst1_u8(row + x, vqmovun_s16(vaddq_s16(vreinterpretq_s16_u16(vmovl_u8(v)), change)));
            }
            continue;
        }
#endif
        for (int x = 0; x < width; x++) {
            int v = row[x];
            int out = v + ((grain[(x + ox) & (LOOK_GRAIN_TILE - 1)] * amplitude[v] + 128) >> 8);
            row[x] = (unsigned char)(out < 0 ? 0 : out > 255 ? 255 : out);
        }
    }
}

typedef struct { const float *src; float *dst, *tmp; const float *kernel; int w, h, radius; } blur3_job;

static void blur3_rows(void *ctx, int row_begin, int row_end) {
    const blur3_job *j = ctx;
    int w = j->w, radius = j->radius;
    for (int y = row_begin; y < row_end; y++)
        for (int x = 0; x < w; x++)
            for (int c = 0; c < 3; c++) {
                float acc = 0.f;
                for (int i = -radius; i <= radius; i++) {
                    int xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i;
                    acc += j->kernel[i + radius] * j->src[3 * ((size_t)y * w + xx) + c];
                }
                j->tmp[3 * ((size_t)y * w + x) + c] = acc;
            }
}

static void blur3_columns(void *ctx, int row_begin, int row_end) {
    const blur3_job *j = ctx;
    int w = j->w, h = j->h, radius = j->radius;
    size_t row = 3 * (size_t)w;
    for (int y = row_begin; y < row_end; y++) {
        float *out = j->dst + (size_t)y * row;
        for (size_t x = 0; x < row; x++) out[x] = 0.f;
        for (int i = -radius; i <= radius; i++) {
            int yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i;
            float k = j->kernel[i + radius];
            const float *src = j->tmp + (size_t)yy * row;
            for (size_t x = 0; x < row; x++) out[x] += k * src[x];
        }
    }
}

static void gaussian_blur(const float *src, float *dst, float *tmp, int w, int h, float sigma) {
    int radius = (int)ceilf(sigma * 3.f);
    if (radius > 64) radius = 64;
    float kernel[129], sum = 0.f;
    for (int i = -radius; i <= radius; i++) sum += kernel[i + radius] = expf(-(float)(i * i) / (2.f * sigma * sigma));
    for (int i = 0; i <= 2 * radius; i++) kernel[i] /= sum;
    blur3_job job = {src, dst, tmp, kernel, w, h, radius};
    for_bands(h, &job, blur3_rows);
    for_bands(h, &job, blur3_columns);
}

static float sample_channel(const float *img, int w, int h, float x, float y, int c) {
    if (x < 0.f) x = 0.f;
    if (y < 0.f) y = 0.f;
    if (x > (float)(w - 1)) x = (float)(w - 1);
    if (y > (float)(h - 1)) y = (float)(h - 1);
    int ix = (int)x, iy = (int)y;
    int ix1 = ix + 1 < w ? ix + 1 : ix, iy1 = iy + 1 < h ? iy + 1 : iy;
    float fx = x - (float)ix, fy = y - (float)iy;
    float a = img[3 * (iy * w + ix) + c], b = img[3 * (iy * w + ix1) + c];
    float d = img[3 * (iy1 * w + ix) + c], e = img[3 * (iy1 * w + ix1) + c];
    return (a + (b - a) * fx) * (1.f - fy) + (d + (e - d) * fx) * fy;
}

/* Vignette as a gain on linear light, by distance from the centre as a fraction of the half
 * diagonal, so it is the same at every resolution. Shared by the photo and live-view paths. */
float look_vignette_gain(const look_recipe *r, float x, float y, int w, int h) {
    float cx = 0.5f * (float)(w - 1), cy = 0.5f * (float)(h - 1);
    float dx = x - cx, dy = y - cy;
    float radius = sqrtf(dx * dx + dy * dy) / sqrtf(cx * cx + cy * cy);
    float gain = 1.f - 0.55f * r->vignette * powf(radius, 2.5f);
    return gain < 0.f ? 0.f : gain;
}

void look_build_vignette_nv12(const look_recipe *r, int w, int h, unsigned char *level_map,
                              unsigned char *y_curves, unsigned short *uv_scale) {
    float lo = 1.f, hi = 1.f;
    for (int corner = 0; corner < 2; corner++) {
        float g = look_vignette_gain(r, corner ? 0.f : 0.5f * (float)(w - 1), corner ? 0.f : 0.5f * (float)(h - 1), w, h);
        if (g < lo) lo = g;
        if (g > hi) hi = g;
    }
    float span = hi - lo;
    for (int level = 0; level < LOOK_VIGNETTE_LEVELS; level++) {
        float gain = lo + span * (float)level / (float)(LOOK_VIGNETTE_LEVELS - 1);
        for (int y = 0; y < 256; y++) {
            /* a grey of this brightness, scaled in linear light, back to video-range Y */
            float grey = clamp01(((float)y - 16.f) / 219.f);
            float out = linear_to_srgb(clamp01(srgb_to_linear(grey) * gain));
            float y_out = 16.f + 219.f * out;
            y_curves[level * 256 + y] = byte_of(y_out);
            /* colour scales with the encoded brightness ratio; that's exact for a linear gain
             * applied equally to R, G and B, up to the sRGB curve's shape */
            float ratio = grey > 0.002f ? out / grey : powf(gain, 1.f / 2.4f);
            uv_scale[level * 256 + y] = (unsigned short)(ratio * 256.f + 0.5f);
        }
    }
    /* The gain depends only on the distance from the centre, and x and w-1-x are the same distance
     * from it in floating point too (both offsets are exact half-integers), so a quarter of the
     * map, mirrored, is the whole map bit for bit, in a quarter of the time. */
    for (int y = 0; y < (h + 1) / 2; y++)
        for (int x = 0; x < (w + 1) / 2; x++) {
            float g = look_vignette_gain(r, (float)x, (float)y, w, h);
            float t = span > 1e-6f ? (g - lo) / span : 1.f;
            int level = (int)(t * (float)(LOOK_VIGNETTE_LEVELS - 1) + 0.5f);
            unsigned char v = (unsigned char)(level < 0 ? 0 : level >= LOOK_VIGNETTE_LEVELS ? LOOK_VIGNETTE_LEVELS - 1 : level);
            int x2 = w - 1 - x, y2 = h - 1 - y;
            level_map[y * w + x] = level_map[y * w + x2] = level_map[y2 * w + x] = level_map[y2 * w + x2] = v;
        }
}

#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
/* look_apply_vignette_nv12 four pixels at a time: the lookups can't be vectorised, but reading and
 * writing whole words, held in locals, saves the compiler from reloading every byte after each
 * store (a store to the frame could, as far as it knows, change the tables). */
static inline uint32_t vignette_word(const unsigned char *y_curves, uint32_t levels, uint32_t px) {
    return (uint32_t)y_curves[(levels & 255u) << 8 | (px & 255u)] |
           (uint32_t)y_curves[(levels >> 8 & 255u) << 8 | (px >> 8 & 255u)] << 8 |
           (uint32_t)y_curves[(levels >> 16 & 255u) << 8 | (px >> 16 & 255u)] << 16 |
           (uint32_t)y_curves[(levels >> 24) << 8 | px >> 24] << 24;
}

static inline unsigned scaled_colour(unsigned c, int scale) {
    int out = 128 + ((((int)c - 128) * scale + 128) >> 8);
    return (unsigned)(out < 0 ? 0 : out > 255 ? 255 : out);
}

static void vignette_rows_words(const unsigned char *level_map, const unsigned char *y_curves,
                                const unsigned short *uv_scale, unsigned char *y_plane, int y_stride,
                                unsigned char *uv_plane, int uv_stride, int width, int row_begin, int row_end) {
    for (int y = row_begin; y < row_end; y += 2) {
        unsigned char *row0 = y_plane + y * y_stride, *row1 = row0 + y_stride;
        const unsigned char *lv0 = level_map + y * width, *lv1 = lv0 + width;
        unsigned char *uv = uv_plane + (y / 2) * uv_stride;
        for (int x = 0; x < width; x += 4) {
            uint32_t a, b, la, lb, c;
            memcpy(&a, row0 + x, 4);
            memcpy(&b, row1 + x, 4);
            memcpy(&la, lv0 + x, 4);
            memcpy(&lb, lv1 + x, 4);
            memcpy(&c, uv + x, 4);
            uint32_t out_a = vignette_word(y_curves, la, a), out_b = vignette_word(y_curves, lb, b);
            memcpy(row0 + x, &out_a, 4);
            memcpy(row1 + x, &out_b, 4);
            /* neutral stays neutral at any scale (black and white skips this altogether) */
            if (c == 0x80808080u) continue;
            for (int k = 0; k < 2; k++) {
                unsigned u = c >> (16 * k) & 255u, v = c >> (16 * k + 8) & 255u;
                if (u == 128 && v == 128) continue;
                unsigned mean = ((a >> (16 * k) & 255u) + (a >> (16 * k + 8) & 255u) + (b >> (16 * k) & 255u) +
                                 (b >> (16 * k + 8) & 255u) + 2) >> 2;
                int scale = uv_scale[(la >> (16 * k) & 255u) << 8 | mean];
                c = (c & ~(0xffffu << (16 * k))) | scaled_colour(u, scale) << (16 * k) | scaled_colour(v, scale) << (16 * k + 8);
            }
            memcpy(uv + x, &c, 4);
        }
    }
}
#endif

void look_apply_vignette_nv12(const unsigned char *level_map, const unsigned char *y_curves,
                              const unsigned short *uv_scale, unsigned char *y_plane, int y_stride,
                              unsigned char *uv_plane, int uv_stride, int width, int row_begin, int row_end) {
#if defined(__BYTE_ORDER__) && __BYTE_ORDER__ == __ORDER_LITTLE_ENDIAN__
    if (nv12_vector && width % 4 == 0) {
        vignette_rows_words(level_map, y_curves, uv_scale, y_plane, y_stride, uv_plane, uv_stride, width, row_begin, row_end);
        return;
    }
#endif
    for (int y = row_begin; y < row_end; y += 2) {
        unsigned char *row0 = y_plane + y * y_stride, *row1 = row0 + y_stride;
        const unsigned char *lv0 = level_map + y * width, *lv1 = lv0 + width;
        unsigned char *uv = uv_plane + (y / 2) * uv_stride;
        for (int x = 0; x < width; x += 2) {
            int mean = (row0[x] + row0[x + 1] + row1[x] + row1[x + 1] + 2) >> 2;
            row0[x] = y_curves[lv0[x] * 256 + row0[x]];
            row0[x + 1] = y_curves[lv0[x + 1] * 256 + row0[x + 1]];
            row1[x] = y_curves[lv1[x] * 256 + row1[x]];
            row1[x + 1] = y_curves[lv1[x + 1] * 256 + row1[x + 1]];
            /* neutral stays neutral at any scale (black and white skips this altogether) */
            if (uv[x] == 128 && uv[x + 1] == 128) continue;
            int scale = uv_scale[lv0[x] * 256 + mean];
            int u = 128 + (((uv[x] - 128) * scale + 128) >> 8);
            int v = 128 + (((uv[x + 1] - 128) * scale + 128) >> 8);
            uv[x] = (unsigned char)(u < 0 ? 0 : u > 255 ? 255 : u);
            uv[x + 1] = (unsigned char)(v < 0 ? 0 : v > 255 ? 255 : v);
        }
    }
}

/* ---- clarity ----
 * Self-guided filter (He and Sun's fast guided filter): on the coarse grid, each cell gets a and b
 * so that a*L + b is the local average where the picture is smooth, and follows L across strong
 * edges (local standard deviation well above 0.1). L - (a*L + b) is then local detail without the
 * halos a plain blur leaves at edges. */
#define CLARITY_RADIUS 1
#define CLARITY_EPS 0.01f

int look_clarity_cols(int w, int h) {
    int cols = (w * LOOK_CLARITY_ROWS + h / 2) / h;
    return cols < 1 ? 1 : cols > LOOK_CLARITY_MAX_COLS ? LOOK_CLARITY_MAX_COLS : cols;
}

/* amount times a midtone weight, so shadows and highlights don't block up or clip */
float look_clarity_gain(const look_recipe *r, float brightness) {
    float t = clamp01(brightness), weight = 6.4f * t * (1.f - t);
    if (weight > 1.f) weight = 1.f;
    /* no negative clarity: removing detail this way blurs fine texture too and reads as fog */
    return 1.2f * r->clarity * weight;
}

/* The guided filter in whole numbers (brightness x4096), with running sums: the same result on
 * the Mac and the camera, and fast on the camera, whose floating-point adds are slow when each
 * one waits for the last. Only one thread may run it at a time (static buffers). */
static int q_lum[LOOK_CLARITY_GRID], q_row_sum[LOOK_CLARITY_GRID], q_mean[LOOK_CLARITY_GRID];
static int q_a[LOOK_CLARITY_GRID], q_b[LOOK_CLARITY_GRID];
static long long q_row_sum_sq[LOOK_CLARITY_GRID], q_mean_sq[LOOK_CLARITY_GRID];

/* how many cells a window centred on i covers, clipped to 0..size-1 */
static int window_count(int i, int size) {
    int lo = i - CLARITY_RADIUS < 0 ? 0 : i - CLARITY_RADIUS;
    int hi = i + CLARITY_RADIUS >= size ? size - 1 : i + CLARITY_RADIUS;
    return hi - lo + 1;
}

static const int RECIPROCAL[26] = {0, 65536, 32768, 21845, 16384, 13107, 10923, 9362, 8192, 7282, 6554,
                                   5958, 5461, 5041, 4681, 4369, 4096, 3855, 3641, 3449, 3277, 3121,
                                   2979, 2849, 2731, 2621};

/* Box mean over the clipped window. Both passes walk the grid row by row: walking down columns
 * lands every step on a new cache line, which cost more than the arithmetic on the camera.
 * tmp holds horizontal sums; the vertical pass keeps one running sum per column. src may be dst. */
static void box_mean_q(const int *src, int *dst, int *tmp, int gw, int gh) {
    int col[LOOK_CLARITY_MAX_COLS], nx[LOOK_CLARITY_MAX_COLS];
    for (int y = 0; y < gh; y++) {
        const int *row = src + y * gw;
        int sum = 0;
        for (int i = 0; i <= CLARITY_RADIUS && i < gw; i++) sum += row[i];
        for (int x = 0; x < gw; x++) {
            tmp[y * gw + x] = sum;
            if (x + CLARITY_RADIUS + 1 < gw) sum += row[x + CLARITY_RADIUS + 1];
            if (x - CLARITY_RADIUS >= 0) sum -= row[x - CLARITY_RADIUS];
        }
    }
    for (int x = 0; x < gw; x++) {
        col[x] = 0;
        nx[x] = window_count(x, gw);
    }
    for (int i = 0; i <= CLARITY_RADIUS && i < gh; i++)
        for (int x = 0; x < gw; x++) col[x] += tmp[i * gw + x];
    for (int y = 0; y < gh; y++) {
        int ny = window_count(y, gh);
        int *out = dst + y * gw;
        const int *add = y + CLARITY_RADIUS + 1 < gh ? tmp + (y + CLARITY_RADIUS + 1) * gw : 0;
        const int *sub = y - CLARITY_RADIUS >= 0 ? tmp + (y - CLARITY_RADIUS) * gw : 0;
        for (int x = 0; x < gw; x++) {
            out[x] = (int)(((long long)col[x] * RECIPROCAL[nx[x] * ny] + 32768) >> 16);
            if (add) col[x] += add[x];
            if (sub) col[x] -= sub[x];
        }
    }
}

/* the same for squares, in 64 bits */
static void box_mean_sq_q(const int *src, long long *dst, long long *tmp, int gw, int gh) {
    long long col[LOOK_CLARITY_MAX_COLS];
    int nx[LOOK_CLARITY_MAX_COLS];
    for (int y = 0; y < gh; y++) {
        const int *row = src + y * gw;
        long long sum = 0;
        for (int i = 0; i <= CLARITY_RADIUS && i < gw; i++) sum += (long long)row[i] * row[i];
        for (int x = 0; x < gw; x++) {
            tmp[y * gw + x] = sum;
            if (x + CLARITY_RADIUS + 1 < gw) sum += (long long)row[x + CLARITY_RADIUS + 1] * row[x + CLARITY_RADIUS + 1];
            if (x - CLARITY_RADIUS >= 0) sum -= (long long)row[x - CLARITY_RADIUS] * row[x - CLARITY_RADIUS];
        }
    }
    for (int x = 0; x < gw; x++) {
        col[x] = 0;
        nx[x] = window_count(x, gw);
    }
    for (int i = 0; i <= CLARITY_RADIUS && i < gh; i++)
        for (int x = 0; x < gw; x++) col[x] += tmp[i * gw + x];
    for (int y = 0; y < gh; y++) {
        int ny = window_count(y, gh);
        long long *out = dst + y * gw;
        const long long *add = y + CLARITY_RADIUS + 1 < gh ? tmp + (y + CLARITY_RADIUS + 1) * gw : 0;
        const long long *sub = y - CLARITY_RADIUS >= 0 ? tmp + (y - CLARITY_RADIUS) * gw : 0;
        for (int x = 0; x < gw; x++) {
            out[x] = (col[x] * RECIPROCAL[nx[x] * ny] + 32768) >> 16;
            if (add) col[x] += add[x];
            if (sub) col[x] -= sub[x];
        }
    }
}

/* In: luminance (0..1) in the first gw*gh floats of work. Out: q_a and q_b (x4096), and the same
 * as floats in the 6th and 7th grids of work, for the photo path. */
static void clarity_coefficients(float *work, int gw, int gh) {
    int n = gw * gh;
    for (int i = 0; i < n; i++) {
        float v = work[i] * 4096.f + 0.5f;
        q_lum[i] = v < 0.f ? 0 : v > 4096.f ? 4096 : (int)v;
    }
    box_mean_q(q_lum, q_mean, q_row_sum, gw, gh);
    box_mean_sq_q(q_lum, q_mean_sq, q_row_sum_sq, gw, gh);
    /* eps 0.01 in brightness squared, x4096^2 */
    const float eps = 0.01f * 4096.f * 4096.f;
    for (int i = 0; i < n; i++) {
        long long var = q_mean_sq[i] - (long long)q_mean[i] * q_mean[i];
        /* at most 4096^2, so it fits in 32 bits; converting from 64 bits is a library call here */
        float v = var < 0 ? 0.f : (float)(int)var;
        int k = (int)(v / (v + eps) * 4096.f + 0.5f);
        q_a[i] = k;
        q_b[i] = (q_mean[i] * (4096 - k) + 2048) >> 12;
    }
    box_mean_q(q_a, q_a, q_row_sum, gw, gh);
    box_mean_q(q_b, q_b, q_row_sum, gw, gh);
    float *a = work + 5 * n, *b = work + 6 * n;
    for (int i = 0; i < n; i++) {
        a[i] = (float)q_a[i] / 4096.f;
        b[i] = (float)q_b[i] / 4096.f;
    }
}

/* grid position of pixel x in 8.8 fixed point, centre-aligned, clamped to the grid */
static int grid_pos(int x, int size, int cells) {
    int pos = (int)(((long long)(2 * x + 1) * cells * 128) / size) - 128;
    return pos < 0 ? 0 : pos > (cells - 1) * 256 ? (cells - 1) * 256 : pos;
}

void look_apply_clarity(const look_recipe *r, float *rgb, int w, int h) {
    if (r->clarity <= 0.f) return;
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS, n = gw * gh;
    float *work = malloc(sizeof(float) * LOOK_CLARITY_WORK);
    if (!work) return;
    const float *a = work + 5 * n, *b = work + 6 * n;
    for (int gy = 0; gy < gh; gy++)
        for (int gx = 0; gx < gw; gx++) {
            int x0 = gx * w / gw, x1 = (gx + 1) * w / gw, y0 = gy * h / gh, y1 = (gy + 1) * h / gh;
            double sum = 0.0;
            for (int y = y0; y < y1; y++)
                for (int x = x0; x < x1; x++) {
                    const float *p = rgb + 3 * ((size_t)y * w + x);
                    sum += 0.299f * p[0] + 0.587f * p[1] + 0.114f * p[2];
                }
            int count = (x1 - x0) * (y1 - y0);
            work[gy * gw + gx] = count ? (float)(sum / count) : 0.f;
        }
    clarity_coefficients(work, gw, gh);
    for (int y = 0; y < h; y++) {
        int py = grid_pos(y, h, gh), iy = py >> 8, iy1 = iy + 1 < gh ? iy + 1 : iy;
        float fy = (float)(py & 255) / 256.f;
        for (int x = 0; x < w; x++) {
            int px = grid_pos(x, w, gw), ix = px >> 8, ix1 = ix + 1 < gw ? ix + 1 : ix;
            float fx = (float)(px & 255) / 256.f;
            float ca = (a[iy * gw + ix] * (1.f - fx) + a[iy * gw + ix1] * fx) * (1.f - fy) +
                       (a[iy1 * gw + ix] * (1.f - fx) + a[iy1 * gw + ix1] * fx) * fy;
            float cb = (b[iy * gw + ix] * (1.f - fx) + b[iy * gw + ix1] * fx) * (1.f - fy) +
                       (b[iy1 * gw + ix] * (1.f - fx) + b[iy1 * gw + ix1] * fx) * fy;
            float *p = rgb + 3 * ((size_t)y * w + x);
            float lum = 0.299f * p[0] + 0.587f * p[1] + 0.114f * p[2];
            float delta = look_clarity_gain(r, lum) * (lum - (ca * lum + cb));
            for (int c = 0; c < 3; c++) p[c] = clamp01(p[c] + delta);
        }
    }
    free(work);
}

/* Live view works in video-range Y. With L = (Y - 16) / 219, the detail in Y levels is
 * (1 - a) * (Y - 16) - 219 * b, so each cell stores p = (1 - a) and q = 219 * b, both x4096. */
void look_build_clarity_nv12(const look_recipe *r, short *gain) {
    for (int y = 0; y < 256; y++) gain[y] = (short)floorf(look_clarity_gain(r, ((float)y - 16.f) / 219.f) * 256.f + 0.5f);
}

/* Per pixel column: its grid cell for shrinking, and its position between grid cells for
 * blending back up. Computed once per frame width, because integer division is slow on the
 * camera. look_clarity_setup must run before two threads use these (see look.h). */
static int cells_w = -1, cells_gw;
static unsigned char cell_of_x[2048];
static unsigned short cell_width[LOOK_CLARITY_MAX_COLS];
static short blend_frac[2048];
/* for blending a grid row out to full width: where each cell's run of pixels starts, and
 * blend_frac times 128 (vqdmulh by it is (d * frac) >> 8), padded for eight-at-a-time stores */
static short blend_start[LOOK_CLARITY_MAX_COLS + 1], blend_frac128[2048 + 8];
static void clarity_columns(int w, int gw) {
    if (w == cells_w && gw == cells_gw) return;
    for (int gx = 0; gx < gw; gx++) {
        int x0 = gx * w / gw, x1 = (gx + 1) * w / gw;
        cell_width[gx] = (unsigned short)(x1 - x0);
        for (int x = x0; x < x1; x++) cell_of_x[x] = (unsigned char)gx;
    }
    for (int i = 0; i <= gw; i++) blend_start[i] = (short)w;
    for (int x = w - 1; x >= 0; x--) {
        int px = grid_pos(x, w, gw);
        blend_frac[x] = (short)(px & 255);
        blend_frac128[x] = (short)((px & 255) * 128);
        blend_start[px >> 8] = (short)x;
    }
    /* a cell no pixel centre falls in starts where the next one does */
    for (int i = gw - 1; i >= 0; i--)
        if (blend_start[i] > blend_start[i + 1]) blend_start[i] = blend_start[i + 1];
    cells_w = w;
    cells_gw = gw;
}

void look_clarity_setup(int w, int h) {
    int gw = look_clarity_cols(w, h);
    if (w <= 2048 && gw <= 255) clarity_columns(w, gw);
}

void look_clarity_downsample_nv12(const unsigned char *y_plane, int y_stride, int w, int h,
                                  int row_begin, int row_end, float *work) {
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS;
    if (w > 2048 || gw > 255) return;
    clarity_columns(w, gw);
    unsigned int sums[LOOK_CLARITY_MAX_COLS];
    /* each pixel column summed down the cell's rows first (sixteen columns at a time where NEON
     * is on), then the columns into cells: the same sums, with one add per column per grid row
     * instead of one per pixel. A cell is at most 255 rows of 255, so a column fits 16 bits. */
    unsigned short column[2048] __attribute__((aligned(16)));
    for (int gy = row_begin * gh / h; gy < gh && gy * h / gh < row_end; gy++) {
        int y0 = gy * h / gh, y1 = (gy + 1) * h / gh;
        for (int gx = 0; gx < gw; gx++) sums[gx] = 0;
#if defined(__ARM_NEON)
        if (nv12_vector && w % 16 == 0 && y1 - y0 <= 257) {
            for (int x = 0; x < w; x += 16) {
                uint16x8_t lo = vdupq_n_u16(0), hi = vdupq_n_u16(0);
                for (int y = y0; y < y1; y++) {
                    uint8x16_t px = vld1q_u8(y_plane + y * y_stride + x);
                    lo = vaddw_u8(lo, vget_low_u8(px));
                    hi = vaddw_u8(hi, vget_high_u8(px));
                }
                vst1q_u16(column + x, lo);
                vst1q_u16(column + x + 8, hi);
            }
            for (int x = 0; x < w; x++) sums[cell_of_x[x]] += column[x];
        } else
#endif
        for (int y = y0; y < y1; y++) {
            const unsigned char *row = y_plane + y * y_stride;
            for (int x = 0; x < w; x++) sums[cell_of_x[x]] += row[x];
        }
        for (int gx = 0; gx < gw; gx++) {
            float count = (float)(cell_width[gx] * (y1 - y0));
            work[gy * gw + gx] = count > 0.f ? ((float)sums[gx] / count - 16.f) / 219.f : 0.f;
        }
    }
}

void look_clarity_coefficients_nv12(int w, int h, int *p_grid, int *q_grid, float *work) {
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS, n = gw * gh;
    clarity_coefficients(work, gw, gh);
    for (int i = 0; i < n; i++) {
        q_grid[i] = 219 * q_b[i];
        p_grid[i] = 4096 - q_a[i];
    }
}

void look_prepare_clarity_nv12(const unsigned char *y_plane, int y_stride, int w, int h,
                               int *p_grid, int *q_grid, float *work) {
    look_clarity_setup(w, h);
    look_clarity_downsample_nv12(y_plane, y_stride, w, h, 0, h, work);
    look_clarity_coefficients_nv12(w, h, p_grid, q_grid, work);
}

/* One grid row blended out to every pixel column: p (0..4096) and q / 64, both fitting 16 bits,
 * so the per-pixel work below only blends two of these rows and runs in 16-bit lanes. Each cell
 * fills its own run of pixels; the vector path writes whole eights past the run's end, and the
 * next cell, filled after it, writes over those. */
static void clarity_wide_row(const int *p_cells, const int *q_cells, int gw, short *p_wide, short *q_wide) {
    short p[LOOK_CLARITY_MAX_COLS + 1], q[LOOK_CLARITY_MAX_COLS + 1];
    for (int i = 0; i < gw; i++) {
        int pi = p_cells[i], qi = (q_cells[i] + 32) >> 6;
        p[i] = (short)(pi < 0 ? 0 : pi > 4096 ? 4096 : pi);
        q[i] = (short)(qi < -16384 ? -16384 : qi > 16383 ? 16383 : qi);
    }
    p[gw] = p[gw - 1];
    q[gw] = q[gw - 1];
    for (int i = 0; i < gw; i++) {
        int x0 = blend_start[i], x1 = blend_start[i + 1];
        int p0 = p[i], dp = p[i + 1] - p[i], q0 = q[i], dq = q[i + 1] - q[i];
#if defined(__ARM_NEON)
        if (nv12_vector) {
            int16x8_t pv = vdupq_n_s16((short)p0), dpv = vdupq_n_s16((short)dp);
            int16x8_t qv = vdupq_n_s16((short)q0), dqv = vdupq_n_s16((short)dq);
            for (int x = x0; x < x1; x += 8) {
                int16x8_t f = vld1q_s16(blend_frac128 + x);
                vst1q_s16(p_wide + x, vaddq_s16(pv, vqdmulhq_s16(dpv, f)));
                vst1q_s16(q_wide + x, vaddq_s16(qv, vqdmulhq_s16(dqv, f)));
            }
            continue;
        }
#endif
        for (int x = x0; x < x1; x++) {
            p_wide[x] = (short)(p0 + ((dp * blend_frac[x]) >> 8));
            q_wide[x] = (short)(q0 + ((dq * blend_frac[x]) >> 8));
        }
    }
}

#if defined(__ARM_NEON)
/* One row of look_apply_clarity_nv12, eight pixels at a time; the same arithmetic as the plain
 * loop there, lane for lane. vqdmulh by fy * 128 is (d * fy) >> 8. */
static void clarity_row_vector(const short *pa, const short *pb, const short *qa, const short *qb, int fy,
                               const short *gain, unsigned char *row, int w) {
    const int16x8_t sixteen = vdupq_n_s16(16);
    const short weight = (short)(fy * 128);
    for (int x = 0; x < w; x += 8) {
        int16x8_t p0 = vld1q_s16(pa + x), q0 = vld1q_s16(qa + x);
        int16x8_t p = vaddq_s16(p0, vqdmulhq_n_s16(vsubq_s16(vld1q_s16(pb + x), p0), weight));
        int16x8_t q = vaddq_s16(q0, vqdmulhq_n_s16(vsubq_s16(vld1q_s16(qb + x), q0), weight));
        eight_bytes px = load_eight(row + x);
        int16x8_t v = vreinterpretq_s16_u16(vmovl_u8(eight_vector(px)));
        int16x8_t above_black = vsubq_s16(v, sixteen);
        int16x8_t detail = vsubq_s16(vcombine_s16(vshrn_n_s32(vmull_s16(vget_low_s16(p), vget_low_s16(above_black)), 6),
                                                  vshrn_n_s32(vmull_s16(vget_high_s16(p), vget_high_s16(above_black)), 6)),
                                     q);
        int16x8_t g = gather_shorts(gain, px);
        int16x8_t d = vcombine_s16(vrshrn_n_s32(vmull_s16(vget_low_s16(detail), vget_low_s16(g)), 14),
                                   vrshrn_n_s32(vmull_s16(vget_high_s16(detail), vget_high_s16(g)), 14));
        vst1_u8(row + x, vqmovun_s16(vaddq_s16(v, d)));
    }
}
#endif

void look_apply_clarity_nv12(const int *p_grid, const int *q_grid, const short *gain, unsigned char *y_plane,
                             int y_stride, int w, int h, int row_begin, int row_end) {
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS;
    if (w != cells_w || gw != cells_gw) return;  /* look_clarity_setup wasn't called for this size */
    /* the two grid rows around the current pixel row, blended out to full width; a band of rows
     * needs only a few, and moving down one grid row reuses the lower one as the upper */
    short wide[4][2048 + 8] __attribute__((aligned(16)));
    short *pa = wide[0], *qa = wide[1], *pb = wide[2], *qb = wide[3];
    int have_a = -1, have_b = -1;
    for (int y = row_begin; y < row_end; y++) {
        int py = grid_pos(y, h, gh), iy = py >> 8, iy1 = iy + 1 < gh ? iy + 1 : iy, fy = py & 255;
        if (have_a != iy) {
            if (have_b == iy) {
                short *t = pa; pa = pb; pb = t;
                t = qa; qa = qb; qb = t;
                have_a = iy;
                have_b = -1;
            } else {
                clarity_wide_row(p_grid + iy * gw, q_grid + iy * gw, gw, pa, qa);
                have_a = iy;
            }
        }
        if (have_b != iy1) {
            clarity_wide_row(p_grid + iy1 * gw, q_grid + iy1 * gw, gw, pb, qb);
            have_b = iy1;
        }
        unsigned char *row = y_plane + y * y_stride;
#if defined(__ARM_NEON)
        if (nv12_vector && w % 8 == 0) {
            clarity_row_vector(pa, pb, qa, qb, fy, gain, row, w);
            continue;
        }
#endif
        for (int x = 0; x < w; x++) {
            int p = pa[x] + (((pb[x] - pa[x]) * fy) >> 8);
            int q = qa[x] + (((qb[x] - qa[x]) * fy) >> 8);
            int v = row[x];
            int detail = ((p * (v - 16)) >> 6) - q;
            int out = v + ((detail * gain[v] + (1 << 13)) >> 14);
            row[x] = (unsigned char)(out < 0 ? 0 : out > 255 ? 255 : out);
        }
    }
}

/* ---- halation ---- (see look.h) */
/* only nearly blown-out light halates: a bright wall shouldn't glow at every edge */
#define HALATION_FROM 0.9f
/* glow per unit of spread highlight before it clips at full */
#define HALATION_REACH 8
/* added light at full glow and halation 1, in 0..1 brightness, and its colour: red, a little
 * orange, as the red layer catches it */
#define HALATION_LIGHT 0.45f
static const float HALATION_TINT[3] = {1.f, 0.22f, 0.05f};

static int h_share[LOOK_CLARITY_GRID], h_spread[LOOK_CLARITY_GRID], h_tmp[LOOK_CLARITY_GRID];

/* share (0..1 per cell) -> glow (0..4096 per cell). One thread at a time (static buffers). */
static void halation_glow(const float *share, int gw, int gh, int *glow) {
    int n = gw * gh;
    for (int i = 0; i < n; i++) h_share[i] = (int)(clamp01(share[i]) * 4096.f + 0.5f);
    /* twice over, for a glow that fades out over two cells instead of stopping at one */
    box_mean_q(h_share, h_spread, h_tmp, gw, gh);
    box_mean_q(h_spread, h_spread, h_tmp, gw, gh);
    for (int i = 0; i < n; i++) {
        /* the cell's own highlight comes off: a highlight's inside doesn't glow, its edge does */
        int g = (h_spread[i] - h_share[i]) * HALATION_REACH;
        glow[i] = g < 0 ? 0 : g > 4096 ? 4096 : g;
    }
}

static void halation_tint(const look_recipe *r, float rgb[3]) {
    float a = r->halation * HALATION_LIGHT;
    if (look_is_mono(r)) {
        float grey = 0.299f * HALATION_TINT[0] + 0.587f * HALATION_TINT[1] + 0.114f * HALATION_TINT[2];
        rgb[0] = rgb[1] = rgb[2] = a * grey;
    } else {
        for (int c = 0; c < 3; c++) rgb[c] = a * HALATION_TINT[c];
    }
}

/* the photo's glow grid, from the picture before the look; 0 when there is no halation */
static int *halation_measure(const look_recipe *r, const float *rgb, int w, int h) {
    if (r->halation <= 0.f) return 0;
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS;
    float *share = malloc(sizeof(float) * LOOK_CLARITY_GRID);
    int *glow = malloc(sizeof(int) * LOOK_CLARITY_GRID);
    if (!share || !glow) {
        free(share);
        free(glow);
        return 0;
    }
    for (int gy = 0; gy < gh; gy++)
        for (int gx = 0; gx < gw; gx++) {
            int x0 = gx * w / gw, x1 = (gx + 1) * w / gw, y0 = gy * h / gh, y1 = (gy + 1) * h / gh;
            double sum = 0.0;
            for (int y = y0; y < y1; y++)
                for (int x = x0; x < x1; x++) {
                    const float *p = rgb + 3 * ((size_t)y * w + x);
                    float lum = 0.299f * p[0] + 0.587f * p[1] + 0.114f * p[2];
                    sum += clamp01((lum - HALATION_FROM) / (1.f - HALATION_FROM));
                }
            int count = (x1 - x0) * (y1 - y0);
            share[gy * gw + gx] = count ? (float)(sum / count) : 0.f;
        }
    halation_glow(share, gw, gh, glow);
    free(share);
    return glow;
}

static void halation_apply(const look_recipe *r, const int *glow, float *rgb, int w, int h) {
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS;
    float tint[3];
    halation_tint(r, tint);
    for (int y = 0; y < h; y++) {
        int py = grid_pos(y, h, gh), iy = py >> 8, iy1 = iy + 1 < gh ? iy + 1 : iy;
        float fy = (float)(py & 255) / 256.f;
        for (int x = 0; x < w; x++) {
            int px = grid_pos(x, w, gw), ix = px >> 8, ix1 = ix + 1 < gw ? ix + 1 : ix;
            float fx = (float)(px & 255) / 256.f;
            float g = ((glow[iy * gw + ix] * (1.f - fx) + glow[iy * gw + ix1] * fx) * (1.f - fy) +
                       (glow[iy1 * gw + ix] * (1.f - fx) + glow[iy1 * gw + ix1] * fx) * fy) / 4096.f;
            float *p = rgb + 3 * ((size_t)y * w + x);
            for (int c = 0; c < 3; c++) p[c] = clamp01(p[c] + g * tint[c]);
        }
    }
}

void look_build_halation_nv12(const look_recipe *r, short tint[3]) {
    float rgb[3], yuv[3], zero[3] = {0.f, 0.f, 0.f}, base[3];
    halation_tint(r, rgb);
    look_rgb_to_yuv(rgb, yuv);
    look_rgb_to_yuv(zero, base);
    for (int c = 0; c < 3; c++) tint[c] = (short)floorf(yuv[c] - base[c] + 0.5f);
}

/* a pixel's highlight share, in Y levels above the threshold (213 is 0.9 of video range) */
#define HALATION_Y_FROM 213
#define HALATION_Y_SPAN 22

void look_halation_downsample_nv12(const unsigned char *y_plane, int y_stride, int w, int h,
                                   int row_begin, int row_end, float *share) {
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS;
    if (w > 2048 || gw > 255) return;
    clarity_columns(w, gw);
    unsigned int sums[LOOK_CLARITY_MAX_COLS];
    unsigned short column[2048] __attribute__((aligned(16)));
    for (int gy = row_begin * gh / h; gy < gh && gy * h / gh < row_end; gy++) {
        int y0 = gy * h / gh, y1 = (gy + 1) * h / gh;
        for (int gx = 0; gx < gw; gx++) sums[gx] = 0;
#if defined(__ARM_NEON)
        if (nv12_vector && w % 16 == 0 && y1 - y0 <= 1489) {
            const uint8x16_t from = vdupq_n_u8(HALATION_Y_FROM), span = vdupq_n_u8(HALATION_Y_SPAN);
            for (int x = 0; x < w; x += 16) {
                uint16x8_t lo = vdupq_n_u16(0), hi = vdupq_n_u16(0);
                for (int y = y0; y < y1; y++) {
                    uint8x16_t px = vminq_u8(vqsubq_u8(vld1q_u8(y_plane + y * y_stride + x), from), span);
                    lo = vaddw_u8(lo, vget_low_u8(px));
                    hi = vaddw_u8(hi, vget_high_u8(px));
                }
                vst1q_u16(column + x, lo);
                vst1q_u16(column + x + 8, hi);
            }
            for (int x = 0; x < w; x++) sums[cell_of_x[x]] += column[x];
        } else
#endif
        for (int y = y0; y < y1; y++) {
            const unsigned char *row = y_plane + y * y_stride;
            for (int x = 0; x < w; x++) {
                int v = row[x] - HALATION_Y_FROM;
                sums[cell_of_x[x]] += (unsigned)(v < 0 ? 0 : v > HALATION_Y_SPAN ? HALATION_Y_SPAN : v);
            }
        }
        for (int gx = 0; gx < gw; gx++) {
            float count = (float)(cell_width[gx] * (y1 - y0) * HALATION_Y_SPAN);
            share[gy * gw + gx] = count > 0.f ? (float)sums[gx] / count : 0.f;
        }
    }
}

void look_halation_grid_nv12(int w, int h, const float *share, int *glow) {
    halation_glow(share, look_clarity_cols(w, h), LOOK_CLARITY_ROWS, glow);
}

/* one grid row of glow blended out to every pixel column, 0..256 */
static void halation_wide_row(const int *cells, int gw, short *wide) {
    short g[LOOK_CLARITY_MAX_COLS + 1];
    for (int i = 0; i < gw; i++) g[i] = (short)((cells[i] + 8) >> 4);
    g[gw] = g[gw - 1];
    for (int i = 0; i < gw; i++) {
        int x0 = blend_start[i], x1 = blend_start[i + 1], g0 = g[i], dg = g[i + 1] - g[i];
#if defined(__ARM_NEON)
        if (nv12_vector) {
            int16x8_t gv = vdupq_n_s16((short)g0), dgv = vdupq_n_s16((short)dg);
            for (int x = x0; x < x1; x += 8) vst1q_s16(wide + x, vaddq_s16(gv, vqdmulhq_s16(dgv, vld1q_s16(blend_frac128 + x))));
            continue;
        }
#endif
        for (int x = x0; x < x1; x++) wide[x] = (short)(g0 + ((dg * blend_frac[x]) >> 8));
    }
}

/* Glow lifts Y up to video white (235), as the photo stops at white; brighter input stays as it was. */
void look_apply_halation_nv12(const int *glow, const short tint[3], unsigned char *y_plane, int y_stride,
                              unsigned char *uv_plane, int uv_stride, int w, int h, int row_begin, int row_end) {
    int gw = look_clarity_cols(w, h), gh = LOOK_CLARITY_ROWS;
    if (w != cells_w || gw != cells_gw) return;
    short wide[2][2048 + 8] __attribute__((aligned(16)));
    short row_glow[2048 + 8] __attribute__((aligned(16)));
    short *ga = wide[0], *gb = wide[1];
    int have_a = -1, have_b = -1, dy = tint[0], du = tint[1], dv = tint[2], colour = du || dv;
    for (int y = row_begin; y < row_end; y++) {
        int py = grid_pos(y, h, gh), iy = py >> 8, iy1 = iy + 1 < gh ? iy + 1 : iy, fy = py & 255;
        if (have_a != iy) {
            if (have_b == iy) {
                short *t = ga; ga = gb; gb = t;
                have_b = -1;
            } else {
                halation_wide_row(glow + iy * gw, gw, ga);
            }
            have_a = iy;
        }
        if (have_b != iy1) {
            halation_wide_row(glow + iy1 * gw, gw, gb);
            have_b = iy1;
        }
        unsigned char *row = y_plane + y * y_stride;
        unsigned char *uv = colour && y % 2 == 0 ? uv_plane + (y / 2) * uv_stride : 0;
#if defined(__ARM_NEON)
        if (nv12_vector && w % 8 == 0) {
            const short weight = (short)(fy * 128);
            const int16x8_t dyv = vdupq_n_s16((short)dy);
            const int16x8_t duv = vcombine_s16(vcreate_s16((uint64_t)(uint16_t)du | (uint64_t)(uint16_t)dv << 16 |
                                                           (uint64_t)(uint16_t)du << 32 | (uint64_t)(uint16_t)dv << 48),
                                               vcreate_s16((uint64_t)(uint16_t)du | (uint64_t)(uint16_t)dv << 16 |
                                                           (uint64_t)(uint16_t)du << 32 | (uint64_t)(uint16_t)dv << 48));
            for (int x = 0; x < w; x += 8) {
                int16x8_t g0 = vld1q_s16(ga + x);
                int16x8_t g = vaddq_s16(g0, vqdmulhq_n_s16(vsubq_s16(vld1q_s16(gb + x), g0), weight));
                uint8x8_t in = vld1_u8(row + x);
                int16x8_t v = vreinterpretq_s16_u16(vmovl_u8(in));
                uint8x8_t out = vqmovun_s16(vaddq_s16(v, vrshrq_n_s16(vmulq_s16(g, dyv), 8)));
                vst1_u8(row + x, vmin_u8(out, vmax_u8(in, vdup_n_u8(235))));
                if (uv) {
                    /* U and V of pixels 0, 2, 4, 6 take those pixels' glow */
                    int16x8_t ge = vtrnq_s16(g, g).val[0];
                    int16x8_t c = vreinterpretq_s16_u16(vmovl_u8(vld1_u8(uv + x)));
                    vst1_u8(uv + x, vqmovun_s16(vaddq_s16(c, vrshrq_n_s16(vmulq_s16(ge, duv), 8))));
                }
            }
            continue;
        }
#endif
        for (int x = 0; x < w; x++) {
            int g = ga[x] + (((gb[x] - ga[x]) * fy) >> 8);
            row_glow[x] = (short)g;
            int in = row[x], out = in + ((g * dy + 128) >> 8), top = in > 235 ? in : 235;
            row[x] = (unsigned char)(out < 0 ? 0 : out > top ? top : out);
        }
        if (uv)
            for (int x = 0; x + 1 < w; x += 2) {
                int g = row_glow[x];
                int u = uv[x] + ((g * du + 128) >> 8), v = uv[x + 1] + ((g * dv + 128) >> 8);
                uv[x] = (unsigned char)(u < 0 ? 0 : u > 255 ? 255 : u);
                uv[x + 1] = (unsigned char)(v < 0 ? 0 : v > 255 ? 255 : v);
            }
    }
}

typedef struct {
    const look_recipe *r;
    float *rgb;
    const float *copy, *blur, *grain;
    int w, h;
    float cx, cy, k, amount;
} spatial_job;

/* chromatic aberration: red scaled outwards, blue inwards */
static void aberration_rows(void *ctx, int row_begin, int row_end) {
    const spatial_job *j = ctx;
    for (int y = row_begin; y < row_end; y++)
        for (int x = 0; x < j->w; x++) {
            float dx = (float)x - j->cx, dy = (float)y - j->cy;
            j->rgb[3 * ((size_t)y * j->w + x) + 0] = sample_channel(j->copy, j->w, j->h, j->cx + dx * (1.f - j->k), j->cy + dy * (1.f - j->k), 0);
            j->rgb[3 * ((size_t)y * j->w + x) + 2] = sample_channel(j->copy, j->w, j->h, j->cx + dx * (1.f + j->k), j->cy + dy * (1.f + j->k), 2);
        }
}

static void sharpen_rows(void *ctx, int row_begin, int row_end) {
    const spatial_job *j = ctx;
    for (size_t i = 3 * (size_t)row_begin * j->w; i < 3 * (size_t)row_end * j->w; i++)
        j->rgb[i] = clamp01(j->rgb[i] + j->amount * (j->rgb[i] - j->blur[i]));
}

static void grain_and_vignette_rows(void *ctx, int row_begin, int row_end) {
    const spatial_job *j = ctx;
    const look_recipe *r = j->r;
    for (int y = row_begin; y < row_end; y++)
        for (int x = 0; x < j->w; x++) {
            float *p = j->rgb + 3 * ((size_t)y * j->w + x);
            float lin_gain = r->vignette != 0.f ? look_vignette_gain(r, (float)x, (float)y, j->w, j->h) : 1.f;

            if (j->grain) {
                /* video-range Y of this pixel, the same brightness measure live view uses */
                float brightness = 0.299f * p[0] + 0.587f * p[1] + 0.114f * p[2];
                float delta = j->grain[(size_t)y * j->w + x] * look_grain_amplitude(r, brightness);
                for (int c = 0; c < 3; c++) p[c] = clamp01(p[c] + delta);
            }
            if (lin_gain != 1.f) {
                if (lin_gain < 0.f) lin_gain = 0.f;
                for (int c = 0; c < 3; c++) p[c] = linear_to_srgb(clamp01(srgb_to_linear(p[c]) * lin_gain));
            }
        }
}

void look_apply_spatial(const look_recipe *r, float *rgb, int w, int h) {
    size_t count = (size_t)w * (size_t)h * 3;
    float cx = 0.5f * (float)(w - 1), cy = 0.5f * (float)(h - 1);
    float half_diag = sqrtf(cx * cx + cy * cy);
    spatial_job job = {r, rgb, 0, 0, 0, w, h, cx, cy, 0.f, 0.f};

    /* chromatic aberration: 0.15% of the height at the corner */
    if (r->aberration > 0.f) {
        float *copy = malloc(count * sizeof *copy);
        if (copy) {
            memcpy(copy, rgb, count * sizeof *copy);
            job.copy = copy;
            job.k = r->aberration * 0.0015f * (float)h / half_diag;
            for_bands(h, &job, aberration_rows);
            free(copy);
        }
    }

    /* sharpness: unsharp mask with a radius of 0.06% of the height. At live-view size that is
     * well under a pixel, which is also what the eye sees when a photo is shown that small. */
    float sigma = 0.0006f * (float)h;
    if (r->sharpness != 0.f && sigma >= 0.35f) {
        float *blur = malloc(count * sizeof *blur), *tmp = malloc(count * sizeof *tmp);
        if (blur && tmp) {
            gaussian_blur(rgb, blur, tmp, w, h, sigma);
            job.blur = blur;
            job.amount = r->sharpness > 0.f ? 1.5f * r->sharpness : r->sharpness;
            for_bands(h, &job, sharpen_rows);
        }
        free(blur);
        free(tmp);
    }

    float *grain = 0;
    if (r->grain > 0.f) {
        grain = malloc((size_t)w * (size_t)h * sizeof *grain);
        if (grain && !look_build_grain_field(r, r->seed, w, h, h, grain)) {
            free(grain);
            grain = 0;
        }
    }
    job.grain = grain;
    for_bands(h, &job, grain_and_vignette_rows);
    free(grain);
}

typedef struct { const look_recipe *r; float *rgb; int w; } pixel_job;
static void pixel_rows(void *ctx, int row_begin, int row_end) {
    const pixel_job *j = ctx;
    prepared p;
    prepare(j->r, &p);
    for (size_t i = (size_t)row_begin * j->w; i < (size_t)row_end * j->w; i++) pixel(j->r, &p, j->rgb + 3 * i);
}

void look_apply_image(const look_recipe *r, float *rgb, int w, int h) {
    int *glow = halation_measure(r, rgb, w, h);
    look_apply_clarity(r, rgb, w, h);
    pixel_job job = {r, rgb, w};
    for_bands(h, &job, pixel_rows);
    if (glow) halation_apply(r, glow, rgb, w, h);
    free(glow);
    look_apply_spatial(r, rgb, w, h);
}
