/* Native reference dumps for the WebAssembly parity tests.
 *   native_dump format <recipe>            look_format of defaults+parse, to stdout
 *   native_dump recognised <recipe>        look_parse count
 *   native_dump table <recipe> <n>         look_build_rgb_table, float32 LE to stdout
 *   native_dump pixels <recipe> <n>        look_pixel on (i/(n-1)) grid, red fastest, float32
 *   native_dump apply <recipe> <w> <h>     look_apply_image on the synthetic image, float32 */
#include "look.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static char *slurp(const char *path) {
    FILE *f = fopen(path, "rb");
    if (!f) { perror(path); exit(1); }
    fseek(f, 0, SEEK_END); long n = ftell(f); fseek(f, 0, SEEK_SET);
    char *t = malloc(n + 1); fread(t, 1, n, f); t[n] = 0; fclose(f);
    return t;
}

int main(int argc, char **argv) {
    if (argc < 3) return 2;
    look_recipe r; look_defaults(&r);
    char *text = slurp(argv[2]);
    int count = look_parse(&r, text);
    if (!strcmp(argv[1], "format")) {
        char out[8192]; look_format(&r, out, sizeof out); fputs(out, stdout);
    } else if (!strcmp(argv[1], "recognised")) {
        printf("%d\n", count);
    } else if (!strcmp(argv[1], "table")) {
        int n = atoi(argv[3]);
        float *t = malloc(sizeof(float) * 3 * n * n * n);
        look_build_rgb_table(&r, n, t);
        fwrite(t, sizeof(float), 3 * (size_t)n * n * n, stdout);
    } else if (!strcmp(argv[1], "pixels")) {
        int n = atoi(argv[3]);
        for (int b = 0; b < n; b++) for (int g = 0; g < n; g++) for (int rr = 0; rr < n; rr++) {
            float p[3] = {(float)rr / (float)(n - 1), (float)g / (float)(n - 1), (float)b / (float)(n - 1)};
            look_pixel(&r, p);
            fwrite(p, sizeof(float), 3, stdout);
        }
    } else if (!strcmp(argv[1], "apply")) {
        int w = atoi(argv[3]), h = atoi(argv[4]);
        size_t count3 = (size_t)w * h * 3;
        float *rgb = malloc(count3 * sizeof(float));
        for (int y = 0; y < h; y++) for (int x = 0; x < w; x++) {
            float *p = rgb + 3 * ((size_t)y * w + x);
            p[0] = (float)((x * 37 + y * 11) % 257) / 256.f;
            p[1] = (float)((x * 5 + y * 29) % 257) / 256.f;
            p[2] = (float)((x * x + y * 3) % 257) / 256.f;
        }
        look_apply_image(&r, rgb, w, h);
        fwrite(rgb, sizeof(float), count3, stdout);
    }
    return 0;
}
