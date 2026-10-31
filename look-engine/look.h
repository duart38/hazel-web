/* Film-simulation look engine. Plain C99, no dependencies, so the same code runs in the camera's
 * live view, in the phone/Mac app (or as the reference for its GPU shader), and in tests.
 *
 * Two kinds of settings:
 *  - per-pixel (mono, contrast, shadows, highlights, saturation, colour shift): one function,
 *    look_pixel(), which is also baked into a 3D table. Live view and output use that same
 *    function, so they match exactly.
 *  - spatial (vignette, grain, sharpness, chromatic aberration): defined in terms of the picture's
 *    own size (fractions of the height), so a 640×480 live view and an 8272×6200 photo get the
 *    same look, not the same pixel counts. */

#ifndef LOOK_H
#define LOOK_H

/* The film a recipe starts from: the colour and tone the other settings then adjust. Standard
 * changes nothing; Muted is inspired by Fujifilm's Classic Chrome, Silver (black and white) by
 * its Acros. Our own names only: theirs are their trademarks. */
enum { LOOK_FILM_STANDARD = 0, LOOK_FILM_MUTED = 1, LOOK_FILM_SILVER = 2 };

typedef struct {
    int mono;             /* 0 colour, 1 black and white */
    int film;             /* LOOK_FILM_*; Silver is always black and white (look_is_mono) */
    float mono_red;       /* black-and-white filter mix: weights for R, G, B (normalised) */
    float mono_green;
    float mono_blue;
    float contrast;       /* -1..1, S-curve around mid grey */
    float shadows;        /* -1..1, lift (+) or crush (-) the dark end */
    float highlights;     /* -1..1, brighten (+) or hold back (-) the bright end */
    float saturation;     /* -1..1, -1 is grey, 0 unchanged */
    float shift_red;      /* colour shift like Fujifilm's WB shift, -1..1 per axis: red/cyan */
    float shift_blue;     /* blue/yellow */
    float vignette;       /* -1..1, + darkens corners, - brightens */
    float grain;          /* 0..1 strength */
    float grain_size;     /* 0..1, 0 fine, 1 coarse */
    float sharpness;      /* -1..1, - softens */
    float clarity;        /* 0..1, local contrast in the midtones, for a gritty look */
    float aberration;     /* 0..1, lateral colour fringing towards the corners */
    float dynamic_range;  /* 0..1, a softer shoulder that holds the brightest tones back */
    float colour_depth;   /* 0..1, deeper, denser strong colours */
    float blue_depth;     /* 0..1, the same for blues only */
    float tone_warm;      /* -1..1, black and white only: cool (-) or warm (+) toning */
    float tone_magenta;   /* -1..1, black and white only: green (-) or magenta (+) toning */
    float noise_reduction; /* -1..1, photos only: less (-) or more (+) noise reduction than the
                              raw developer's default, like High ISO NR. Applied while the raw is
                              decoded, so the engine itself doesn't use it; live view keeps the
                              camera's own */
    float fade;           /* 0..1, a matte print: blacks lifted to grey, whites softened */
    float brightness;     /* -1..1, about a stop either way in the midtones; black stays black and
                             white stays white */
    float vibrance;       /* -1..1, colour only: like saturation, but mostly for weak colours,
                             and gentle with skin */
    float halation;       /* 0..1, a red glow around bright lights, as on film without its
                             anti-halation layer (a neutral glow in black and white) */
    /* colour grading: a tint for the shadows and one for the highlights. Hue is in degrees on
     * the usual colour wheel (0 red, 60 yellow, 120 green, 240 blue), amount 0..1; balance
     * -1..1 gives more of the picture to the shadow (-) or highlight (+) tint. Recipe text:
     * `grade_shadows = <hue>, <amount>`, `grade_highlights = <hue>, <amount>`. */
    float grade_shadow_hue;
    float grade_shadow_amount;
    float grade_highlight_hue;
    float grade_highlight_amount;
    float grade_balance;
    /* colour mixer, colour only: for each of the LOOK_MIX_BANDS colours, -1..1 each, a turn of
     * its hue towards the next band (+) or the one before (-), its saturation, and its
     * lightness. Recipe text: `mix_<band> = <hue>, <saturation>, <lightness>`. */
    float mix_hue[8];
    float mix_saturation[8];
    float mix_lightness[8];
    unsigned int seed;    /* grain pattern; the app randomises it per photo */
} look_recipe;

#define LOOK_MIX_BANDS 8
/* the mixer's bands, in hue order: red, orange, yellow, green, aqua, blue, purple, magenta */
const char *look_mix_band_name(int band);
/* What a hue looks like, for drawing a colour wheel or the mixer's bands: sRGB 0..1. For the
 * grading hues (degrees on the usual wheel) this is the tint's own colour as the engine adds it. */
void look_grade_colour(float hue, float rgb[3]);
void look_mix_band_colour(int band, float rgb[3]);

void look_defaults(look_recipe *r);

/* Black and white: the mono switch, or a black and white film */
int look_is_mono(const look_recipe *r);

/* Reads "key = value" lines (the same text as the sidecar). Unknown keys are ignored so older
 * readers accept newer recipes. Returns the number of keys recognised. */
int look_parse(look_recipe *r, const char *text);

/* Writes the recipe as "key = value" lines. Returns bytes written (excluding the terminator). */
int look_format(const look_recipe *r, char *out, int size);

/* The single source of truth for per-pixel changes. rgb is sRGB-encoded, 0..1, in and out. */
void look_pixel(const look_recipe *r, float rgb[3]);

/* 3D table of look_pixel over RGB, n points per axis, n*n*n*3 floats, red fastest. */
void look_build_rgb_table(const look_recipe *r, int n, float *table);
void look_table_apply(const float *table, int n, float rgb[3]);

/* Live view: NV12 in place, video-range BT.601 (what the camera's capture path produces).
 * The table is built once per recipe, n*n*n entries of Y,U,V bytes, indexed [v][u][y]. */
void look_build_yuv_table(const look_recipe *r, int n, unsigned char *table);
void look_apply_nv12(const unsigned char *table, int n, unsigned char *y_plane, int y_stride,
                     unsigned char *uv_plane, int uv_stride, int width, int height);

/* Fast live-view path. Exact in brightness (all 256 levels), interpolated over a 33x33 colour
 * grid, so each pixel needs one 4-point blend and no division (the camera's Cortex-A9 has no
 * divide instruction). Build once per recipe; y_table and uv_table sizes are below. */
#define LOOK_UV_N 33
#define LOOK_NV12_Y_TABLE_SIZE (LOOK_UV_N * LOOK_UV_N * 256)
#define LOOK_NV12_UV_TABLE_SIZE (LOOK_UV_N * LOOK_UV_N * 256 * 2)
void look_build_nv12_tables(const look_recipe *r, unsigned char *y_table, unsigned char *uv_table);
/* The same for colour grid columns [u_begin, u_end) only, so two threads can share one build. */
void look_build_nv12_tables_part(const look_recipe *r, unsigned char *y_table, unsigned char *uv_table,
                                 int u_begin, int u_end);
/* Rows [row_begin, row_end) of the frame; both even. Lets two threads split one frame. */
void look_apply_nv12_fast(const unsigned char *y_table, const unsigned char *uv_table,
                          unsigned char *y_plane, int y_stride, unsigned char *uv_plane, int uv_stride,
                          int width, int row_begin, int row_end);

/* Black and white: when look_nv12_uv_is_neutral says every colour in the table is neutral, the
 * _mono version gives the same result without the colour lookups. */
int look_nv12_uv_is_neutral(const unsigned char *uv_table);
void look_apply_nv12_fast_mono(const unsigned char *y_table, unsigned char *y_plane, int y_stride,
                               unsigned char *uv_plane, int uv_stride, int width, int row_begin, int row_end);

/* The colour tables regrouped so each lookup fetches a colour cell's four corners at once, and the
 * matching look_apply_nv12_fast (uv_corners set) or _mono (uv_corners null) that uses them: the
 * same result, byte for byte, in fewer loads. */
#define LOOK_NV12_Y_CORNERS_SIZE ((LOOK_UV_N - 1) * (LOOK_UV_N - 1) * 256 * 4)
#define LOOK_NV12_UV_CORNERS_SIZE (LOOK_NV12_Y_CORNERS_SIZE * 2)
void look_build_nv12_corners(const unsigned char *y_table, const unsigned char *uv_table,
                             unsigned char *y_corners, unsigned char *uv_corners);
void look_apply_nv12_corners(const unsigned char *y_corners, const unsigned char *uv_corners,
                             unsigned char *y_plane, int y_stride, unsigned char *uv_plane, int uv_stride,
                             int width, int row_begin, int row_end);

/* On chips with NEON (the camera, Apple silicon) the live-view steps run eight pixels at a time,
 * with the same result byte for byte. Off (0) runs the plain versions, for tests. On by default. */
void look_nv12_set_vector(int on);

/* Vignette in live view: a per-pixel strength map (w*h bytes, LOOK_VIGNETTE_LEVELS levels),
 * a brightness curve per level (levels*256 bytes) and a colour scale per level and brightness
 * (levels*256 shorts, 8.8 fixed point). Applied after look_apply_nv12_fast. */
#define LOOK_VIGNETTE_LEVELS 64
float look_vignette_gain(const look_recipe *r, float x, float y, int w, int h);
void look_build_vignette_nv12(const look_recipe *r, int w, int h, unsigned char *level_map,
                              unsigned char *y_curves, unsigned short *uv_scale);
void look_apply_vignette_nv12(const unsigned char *level_map, const unsigned char *y_curves,
                              const unsigned short *uv_scale, unsigned char *y_plane, int y_stride,
                              unsigned char *uv_plane, int uv_stride, int width, int row_begin, int row_end);

/* Grain. The field is unit-variance film grain for a w*h picture whose full height is
 * image_height pixels (so a tile can stand in for part of a larger picture). Live view uses a
 * LOOK_GRAIN_TILE square tile at screen scale, shifted per frame so the grain moves like film.
 * amplitude is per Y level, 8.8 fixed point, in tile units (tile = grain * 32). */
#define LOOK_GRAIN_TILE 256
float look_grain_length(const look_recipe *r, int image_height);
float look_grain_amplitude(const look_recipe *r, float brightness);
int look_build_grain_field(const look_recipe *r, unsigned int seed, int w, int h, int image_height, float *field);
void look_build_grain_nv12(const look_recipe *r, unsigned int seed, int image_height, signed char *tile, short *amplitude);
void look_apply_grain_nv12(const signed char *tile, const short *amplitude, unsigned int frame_seed,
                           unsigned char *y_plane, int y_stride, int width, int row_begin, int row_end);

/* Clarity: an edge-aware local-contrast change, computed on a coarse grid LOOK_CLARITY_ROWS high (60: an 80x60 grid for 4:3; 120 looked the same and cost 4x on the camera)
 * (the fast guided filter). The grid has the same size for a live-view frame and a full photo, so
 * both get the same clarity at the same viewing size. Applied first, to the camera's own
 * brightness, before the per-pixel look.
 * Live view: per recipe, look_build_clarity_nv12 fills a 256-entry gain table; per frame,
 * look_prepare_clarity_nv12 fills the p and q grids (LOOK_CLARITY_GRID ints each) from the whole
 * frame, using `work` (LOOK_CLARITY_WORK floats); then look_apply_clarity_nv12 runs on any rows.
 * The engine keeps per-width column tables for this; look_clarity_setup(width, height) builds
 * them and must run on one thread before others shrink or apply (prepare calls it itself). */
#define LOOK_CLARITY_ROWS 60
#define LOOK_CLARITY_MAX_COLS 240
#define LOOK_CLARITY_GRID (LOOK_CLARITY_ROWS * LOOK_CLARITY_MAX_COLS)
#define LOOK_CLARITY_WORK (7 * LOOK_CLARITY_GRID)
int look_clarity_cols(int w, int h);
float look_clarity_gain(const look_recipe *r, float brightness);
void look_apply_clarity(const look_recipe *r, float *rgb, int width, int height);
void look_build_clarity_nv12(const look_recipe *r, short *gain);
void look_prepare_clarity_nv12(const unsigned char *y_plane, int y_stride, int width, int height,
                               int *p_grid, int *q_grid, float *work);
/* The same in two steps, so two threads can shrink their halves of the frame into the grid:
 * rows [row_begin, row_end) must start and end on grid rows (half the height always does). */
void look_clarity_downsample_nv12(const unsigned char *y_plane, int y_stride, int width, int height,
                                  int row_begin, int row_end, float *work);
void look_clarity_coefficients_nv12(int width, int height, int *p_grid, int *q_grid, float *work);
void look_clarity_setup(int width, int height);
void look_apply_clarity_nv12(const int *p_grid, const int *q_grid, const short *gain, unsigned char *y_plane,
                             int y_stride, int width, int height, int row_begin, int row_end);

/* Halation: each grid cell's share of highlight (brightness above 0.9), spread over its
 * neighbours, minus its own, so the glow sits around a bright light rather than on it.
 * Same grid as clarity, and it needs look_clarity_setup the same way. Measured on the frame as it
 * comes in, added after the per-pixel look.
 * Photo: look_apply_image does it all. Live view: per recipe, look_build_halation_nv12 gives the
 * change in Y, U and V at full glow; per frame, look_halation_downsample_nv12 (any rows, like the
 * clarity shrink) fills `share` (LOOK_CLARITY_GRID floats), look_halation_grid_nv12 turns it into
 * `glow` (LOOK_CLARITY_GRID ints), then look_apply_halation_nv12 runs on any rows (even row_begin). */
void look_build_halation_nv12(const look_recipe *r, short tint[3]);
void look_halation_downsample_nv12(const unsigned char *y_plane, int y_stride, int width, int height,
                                   int row_begin, int row_end, float *share);
void look_halation_grid_nv12(int width, int height, const float *share, int *glow);
void look_apply_halation_nv12(const int *glow, const short tint[3], unsigned char *y_plane, int y_stride,
                              unsigned char *uv_plane, int uv_stride, int width, int height, int row_begin, int row_end);

/* Spatial effects on an interleaved float RGB image (sRGB-encoded 0..1), in place. */
void look_apply_spatial(const look_recipe *r, float *rgb, int width, int height);

/* Everything, in the right order: clarity, per-pixel, halation, then the other spatial effects. */
void look_apply_image(const look_recipe *r, float *rgb, int width, int height);

void look_yuv_to_rgb(float y, float u, float v, float rgb[3]);
void look_rgb_to_yuv(const float rgb[3], float yuv[3]);

#endif
