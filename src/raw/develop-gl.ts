import type { DevelopedImage } from '../engine/types'
import { developTuning, TONE_CURVE, TONE_LOG2_MIN, type DevelopParams } from './colour'
import { outputSize } from './develop-cpu'
import { orientToRgb } from './orient'

// The raw is developed a band of output rows at a time, so the GPU never holds more than the raw
// itself plus a few small bands (a full-size float image would be 800 MB):
//   L  once per develop: the raw binned 8×8 into a small picture, whose colour is smoothed
//      across a wide area (LD); the difference is the low-frequency colour noise B removes
//   A  raw → white-balanced camera RGB: Malvar-He-Cutler demosaic, or 2×2 binning for previews;
//      clipped highlights blended towards a reconstructed colour
//   B  noise reduction (square-root domain, bilateral luma and chroma) and camera → linear sRGB
//   S  capture sharpening (unsharp mask of the square-root luma), full-resolution develops only
//   C  area downscale to the requested size and the tone curve, read back as 32-bit floats

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`

const RAW_COMMON = `
uniform usampler2D raw;
uniform ivec2 size;      // crop size
uniform ivec2 parity;    // crop origin & 1
uniform ivec4 cfa;
uniform vec4 black;
uniform vec4 scale;
uniform vec4 ceiling;    // each cell's level at the white point (its white-balance multiplier)

int cell(ivec2 q) { return ((q.y + parity.y) & 1) * 2 + ((q.x + parity.x) & 1); }
ivec2 mirror(ivec2 q) {
  q = abs(q);
  return min(q, 2 * (size - 1) - q);
}
// White-balanced level, not clipped at 1: a channel the white balance multiplies keeps the range
// above 1 it really recorded, which the highlight blend uses.
float level(ivec2 q) {
  q = mirror(q);
  int i = cell(q);
  return clamp((float(texelFetch(raw, q, 0).r) - black[i]) * scale[i], 0.0, ceiling[i]);
}
`

const PASS_L = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
${RAW_COMMON}
uniform int factor;
out vec4 colour;

void main() {
  ivec2 o = ivec2(gl_FragCoord.xy) * factor;
  vec3 sum = vec3(0.0);
  vec3 n = vec3(0.0);
  for (int y = 0; y < factor; y++) {
    for (int x = 0; x < factor; x++) {
      ivec2 q = min(o + ivec2(x, y), size - 1);
      int c = cfa[cell(q)];
      sum[c] += min(level(q), 1.0);
      n[c] += 1.0;
    }
  }
  colour = vec4(sqrt(sum / max(n, vec3(1.0))), 1.0);
}`

// Colour of the small picture smoothed by a wide bilateral filter (range from luma and chroma, so
// real colour edges stay); the output is the change, in the square-root domain, chroma only.
const PASS_LD = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D source;
uniform ivec2 size;
uniform int step;
uniform float sigma;      // noise of one small-picture pixel, square-root domain
uniform float chromaRange;
uniform float amount;
uniform bool accumulate;  // second round: source holds L + previous change
uniform sampler2D previous;
out vec4 colour;

float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
vec3 at(ivec2 p) {
  p = clamp(p, ivec2(0), size - 1);
  vec3 c = texelFetch(source, p, 0).rgb;
  return accumulate ? c + texelFetch(previous, p, 0).rgb : c;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 c = at(p);
  float y = luma(c);
  vec3 chroma = c - y;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int j = -3; j <= 3; j++) {
    for (int i = -3; i <= 3; i++) {
      vec3 cn = at(p + ivec2(i, j) * step);
      float yn = luma(cn);
      vec3 chromaN = cn - yn;
      float d = (yn - y) / (sigma * 4.0);
      vec3 dc = (chromaN - chroma) / (sigma * chromaRange);
      float w = exp(-float(i * i + j * j) / 8.0 - 0.5 * d * d - 0.5 * dot(dc, dc));
      sum += w * chromaN;
      total += w;
    }
  }
  vec3 change = (sum / total - chroma) * amount;
  vec3 before = accumulate ? texelFetch(previous, p, 0).rgb : vec3(0.0);
  colour = vec4(before + change, 1.0);
}`

// The change blurred over a few small-picture pixels: its pixel-scale part is noise the full
// resolution filter in B already removes, and adding it again would put that noise back.
const PASS_LB = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D source;
uniform ivec2 size;
out vec4 colour;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      float w = exp(-float(i * i + j * j) / 2.0);
      sum += w * texelFetch(source, clamp(p + ivec2(i, j), ivec2(0), size - 1), 0).rgb;
      total += w;
    }
  }
  colour = vec4(sum / total, 1.0);
}`

const SAMPLE = `
${RAW_COMMON}
uniform float sigma;

bool nearClip = false;
float saturation = 0.0;   // the highest sample read, as a fraction of its channel's white point
// A hot pixel is brighter than its four same-colour neighbours by far more than noise; it is
// replaced by their maximum before the demosaic can spread it into a coloured cross.
float v(ivec2 q) {
  float c = level(q);
  float fraction = c / ceiling[cell(mirror(q))];
  saturation = max(saturation, fraction);
  if (fraction >= 0.995) nearClip = true;
  float m = max(max(level(q + ivec2(2, 0)), level(q - ivec2(2, 0))), max(level(q + ivec2(0, 2)), level(q - ivec2(0, 2))));
  float limit = m + 0.01 + 12.0 * sigma * sqrt(m);
  if (c <= limit) return c;
  // A speck of real light (sky through leaves) also lifts the adjacent samples, along both axes.
  // A stuck pair of samples (one on the X1D sits at 1706,5875) lifts one axis only; and comparing
  // the adjacent samples with the centre directly fails in saturated colour, where the white
  // balance makes the other colours larger (green hot pixels in a purple sky stayed).
  float across = max(level(q + ivec2(1, 0)), level(q - ivec2(1, 0))) - max(level(q + ivec2(3, 0)), level(q - ivec2(3, 0)));
  float down = max(level(q + ivec2(0, 1)), level(q - ivec2(0, 1))) - max(level(q + ivec2(0, 3)), level(q - ivec2(0, 3)));
  return min(across, down) > 0.25 * (c - m) ? c : m;
}
`

// Green at every pixel (full-resolution develops): Hamilton-Adams, interpolating along the
// direction with the smaller gradient, so a line one pixel thin keeps its own green.
const PASS_G = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
${SAMPLE}
uniform int rowBase;
out vec4 colour;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, rowBase);
  float C = v(p);
  if (cfa[cell(mirror(p))] == 1) {
    colour = vec4(C, 0.0, 0.0, 1.0);
    return;
  }
  float N = v(p + ivec2(0, -1)), S = v(p + ivec2(0, 1)), E = v(p + ivec2(1, 0)), W = v(p + ivec2(-1, 0));
  float N2 = v(p + ivec2(0, -2)), S2 = v(p + ivec2(0, 2)), E2 = v(p + ivec2(2, 0)), W2 = v(p + ivec2(-2, 0));
  float g;
  if (nearClip) {
    // a clipped sample's level is only a lower bound: no gradients from it
    g = 0.25 * (N + S + E + W);
  } else {
    // the curvature term is kept within the two greens it interpolates: a highlight smaller than
    // the filter pattern would otherwise push green far past both and turn it cyan
    float alongRow = clamp(0.5 * (E + W) + 0.25 * (2.0 * C - E2 - W2), min(E, W), max(E, W));
    float alongCol = clamp(0.5 * (N + S) + 0.25 * (2.0 * C - N2 - S2), min(N, S), max(N, S));
    float dRow = abs(E - W) + abs(2.0 * C - E2 - W2);
    float dCol = abs(N - S) + abs(2.0 * C - N2 - S2);
    g = (alongRow * dCol + alongCol * dRow + 1e-7 * (alongRow + alongCol)) / (dRow + dCol + 2e-7);
  }
  colour = vec4(g, 0.0, 0.0, 1.0);
}`

const PASS_A = `#version 300 es
precision highp float;
precision highp int;
precision highp usampler2D;
${SAMPLE}
uniform int rowBase;
uniform bool binned;
uniform sampler2D green;
uniform int greenRow;     // picture row of the green band's first row
out vec4 colour;

float G(ivec2 q) {
  q = mirror(q);
  return texelFetch(green, ivec2(q.x, q.y - greenRow), 0).r;
}

// dcraw's highlight blend: where a channel passed the level every channel can reach (1), keep the
// unclipped brightness and hue but only as much colour as the clipped pixel has, so clipped areas
// fade to white smoothly instead of turning magenta or cyan at their edges.
vec3 blendHighlights(vec3 rgb) {
  // Next to a sample at the white point the clipped channel is only a lower bound, so the others
  // read too low against it (cyan rims round sky highlights): lift them towards it.
  rgb = mix(rgb, vec3(max(rgb.r, max(rgb.g, rgb.b))), smoothstep(0.9, 1.0, saturation));
  if (max(rgb.r, max(rgb.g, rgb.b)) <= 1.0) return rgb;
  vec3 clipped = min(rgb, vec3(1.0));
  vec2 ab = vec2(1.7320508 * (rgb.r - rgb.g), 2.0 * rgb.b - rgb.r - rgb.g);
  vec2 abClipped = vec2(1.7320508 * (clipped.r - clipped.g), 2.0 * clipped.b - clipped.r - clipped.g);
  float lengthAb = length(ab);
  ab *= lengthAb > 0.0 ? length(abClipped) / lengthAb : 0.0;
  float l = rgb.r + rgb.g + rgb.b;
  return vec3(l + 0.8660254 * ab.x - 0.5 * ab.y, l - 0.8660254 * ab.x - 0.5 * ab.y, l + ab.y) / 3.0;
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, rowBase);
  if (binned) {
    vec3 sum = vec3(0.0);
    vec3 n = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      ivec2 q = 2 * p + ivec2(k & 1, k >> 1);
      int c = cfa[cell(q)];
      sum[c] += v(q);
      n[c] += 1.0;
    }
    colour = vec4(blendHighlights(sum / max(n, vec3(1.0))), 1.0);
    return;
  }
  float C = v(p);
  float N = v(p + ivec2(0, -1)), S = v(p + ivec2(0, 1)), E = v(p + ivec2(1, 0)), W = v(p + ivec2(-1, 0));
  float NE = v(p + ivec2(1, -1)), NW = v(p + ivec2(-1, -1)), SE = v(p + ivec2(1, 1)), SW = v(p + ivec2(-1, 1));
  // Clipped samples one step further out lift the colour half as much. Every pixel two steps
  // from a clipped area sees several of its samples whatever the filter colour, so unlike reading
  // a few further samples this cannot alternate along an edge.
  for (int j = -2; j <= 2; j++) {
    for (int i = -2; i <= 2; i++) {
      if (max(abs(i), abs(j)) < 2) continue;
      ivec2 o = p + ivec2(i, j);
      if (level(o) >= 0.995 * ceiling[cell(mirror(o))]) saturation = max(saturation, 0.95);
    }
  }
  int c = cfa[cell(mirror(p))];
  vec3 rgb;
  if (nearClip) {
    // next to a clipped sample colour differences are wrong and draw coloured dots along the
    // edge: plain bilinear
    if (c == 1) {
      int rowColour = cfa[cell(mirror(p + ivec2(1, 0)))];
      rgb = rowColour == 0 ? vec3(0.5 * (E + W), C, 0.5 * (N + S)) : vec3(0.5 * (N + S), C, 0.5 * (E + W));
    } else {
      float g = 0.25 * (N + S + E + W);
      float other = 0.25 * (NE + NW + SE + SW);
      rgb = c == 0 ? vec3(C, g, other) : vec3(other, g, C);
    }
  } else if (c == 1) {
    // red and blue from the colour differences of their nearest samples, which vary far more
    // slowly than the colours themselves
    float alongRow = C + 0.5 * (E - G(p + ivec2(1, 0)) + W - G(p - ivec2(1, 0)));
    float alongCol = C + 0.5 * (N - G(p - ivec2(0, 1)) + S - G(p + ivec2(0, 1)));
    int rowColour = cfa[cell(mirror(p + ivec2(1, 0)))];
    rgb = rowColour == 0 ? vec3(alongRow, C, alongCol) : vec3(alongCol, C, alongRow);
  } else {
    float g = G(p);
    float other = g + 0.25 * (NE - G(p + ivec2(1, -1)) + NW - G(p + ivec2(-1, -1)) + SE - G(p + ivec2(1, 1)) + SW - G(p + ivec2(-1, 1)));
    rgb = c == 0 ? vec3(C, g, other) : vec3(other, g, C);
  }
  colour = vec4(blendHighlights(max(rgb, vec3(0.0))), 1.0);
}`

const PASS_B = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D source;
uniform ivec2 size;       // source band texture's valid area
uniform int offset;       // source band texture row of output row 0
uniform int rowBase;      // picture row of output row 0
uniform vec2 picture;     // picture size in source pixels
uniform int step;         // chroma sampling step
uniform float sigma;
uniform float lumaAmount;
uniform float lumaRange;
uniform float chromaAmount;
uniform float chromaSigma;
uniform float lowAmount;
uniform sampler2D lowChange;
uniform sampler2D lowPicture;
uniform float lowRange;
uniform float lowReplace;
uniform bool falseColour;
uniform sampler2D lowBlur;
uniform mat3 matrix;
out vec4 colour;

vec3 q(ivec2 p) {
  p = clamp(p, ivec2(0), size - 1);
  return sqrt(max(texelFetch(source, p, 0).rgb, vec3(0.0)));
}
float luma(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }

// sorts a pair, each channel on its own
#define SORT(a, b) { vec3 t = min(a, b); b = max(a, b); a = t; }
// Each channel's median of the 3×3 colour, as a sorting network (Paeth's, 19 exchanges).
vec3 medianChroma(ivec2 p) {
  vec3 m[9];
  for (int k = 0; k < 9; k++) {
    vec3 c = q(p + ivec2(k % 3 - 1, k / 3 - 1));
    m[k] = c - luma(c);
  }
  SORT(m[1], m[2]) SORT(m[4], m[5]) SORT(m[7], m[8]) SORT(m[0], m[1]) SORT(m[3], m[4]) SORT(m[6], m[7])
  SORT(m[1], m[2]) SORT(m[4], m[5]) SORT(m[7], m[8]) SORT(m[0], m[3]) SORT(m[5], m[8]) SORT(m[4], m[7])
  SORT(m[3], m[6]) SORT(m[1], m[4]) SORT(m[2], m[5]) SORT(m[4], m[7]) SORT(m[4], m[2]) SORT(m[6], m[4])
  SORT(m[4], m[2])
  return m[4];
}

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, offset);
  vec3 c = q(p);
  float y = luma(c);
  vec3 chroma = c - y;
  // A colour the demosaic made up for a detail finer than the colour filter pattern (a speck of
  // sky through twigs, a one-pixel highlight) differs from all its neighbours; the bilateral
  // filter below keeps such outliers, a median does not.
  if (falseColour) chroma = medianChroma(p);
  if (lumaAmount > 0.0) {
    float sum = 0.0, total = 0.0;
    for (int j = -2; j <= 2; j++) {
      for (int i = -2; i <= 2; i++) {
        float yn = luma(q(p + ivec2(i, j)));
        float d = (yn - y) / lumaRange;
        float w = exp(-float(i * i + j * j) / 4.5 - 0.5 * d * d);
        sum += w * yn;
        total += w;
      }
    }
    y = mix(y, sum / total, lumaAmount);
  }
  if (chromaAmount > 0.0) {
    // colour noise is blotchy, so it is averaged over a wider, sparser window than the luma
    float lumaSigma = sigma * 4.0;
    vec3 sum = vec3(0.0);
    float total = 0.0;
    for (int j = -4; j <= 4; j++) {
      for (int i = -4; i <= 4; i++) {
        vec3 cn = q(p + ivec2(i, j) * step);
        float yn = luma(cn);
        vec3 chromaN = cn - yn;
        float d = (yn - y) / lumaSigma;
        vec3 dc = (chromaN - chroma) / chromaSigma;
        float w = exp(-float(i * i + j * j) / 12.5 - 0.5 * d * d - 0.5 * dot(dc, dc));
        sum += w * chromaN;
        total += w;
      }
    }
    chroma = mix(chroma, sum / total, chromaAmount);
  }
  if (lowAmount > 0.0) {
    vec2 at = vec2(gl_FragCoord.x, gl_FragCoord.y + float(rowBase)) / picture;
    // at a colour edge the small picture mixes both sides; its change belongs to neither
    vec3 lowRoot = texture(lowPicture, at).rgb;
    vec3 apart = (chroma - (lowRoot - luma(lowRoot))) / lowRange;
    vec3 change = texture(lowChange, at).rgb;
    vec3 blurRoot = texture(lowBlur, at).rgb;
    change += lowReplace * (blurRoot - luma(blurRoot) - chroma);
    chroma += lowAmount * exp(-0.5 * dot(apart, apart)) * change;
  }
  vec3 root = max(chroma + y, vec3(0.0));
  // alpha carries the square-root luma for the sharpening pass
  colour = vec4(matrix * (root * root), y);
}`

const PASS_S = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D source;
uniform ivec2 size;       // source band texture's valid area
uniform int offset;       // source band texture row of output row 0
uniform float amount;
uniform float radius;
uniform float limit;
out vec4 colour;

void main() {
  ivec2 p = ivec2(gl_FragCoord.xy) + ivec2(0, offset);
  vec4 centre = texelFetch(source, clamp(p, ivec2(0), size - 1), 0);
  float sum = 0.0, total = 0.0;
  float inv = -0.5 / (radius * radius);
  for (int j = -4; j <= 4; j++) {
    for (int i = -4; i <= 4; i++) {
      float w = exp(float(i * i + j * j) * inv);
      sum += w * texelFetch(source, clamp(p + ivec2(i, j), ivec2(0), size - 1), 0).a;
      total += w;
    }
  }
  // the boost is limited so a hard edge gets a crisp step rather than a bright halo
  float d = clamp(amount * (centre.a - sum / total), -limit, limit);
  vec3 root = sqrt(max(centre.rgb, vec3(0.0))) + d;
  colour = vec4(max(root, vec3(0.0)) * root, 1.0);
}`

const PASS_C = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D source;
uniform ivec2 size;       // source band's valid area
uniform vec2 ratio;       // source pixels per output pixel
uniform int outputRow;    // first output row of the band, in the whole picture
uniform int sourceRow;    // first source row in the band texture, in the whole picture
uniform sampler2D curve;
uniform int curveLength;
uniform float curveMin;
uniform float shadowShift;
out vec4 colour;

float tone(float x) {
  if (!(x > 0.0)) return 0.0;
  float t = (log2(x) - curveMin) / -curveMin * float(curveLength - 1);
  if (t <= 0.0) return texelFetch(curve, ivec2(0, 0), 0).r;
  if (t >= float(curveLength - 1)) return 1.0;
  int i = int(floor(t));
  float a = texelFetch(curve, ivec2(i, 0), 0).r;
  float b = texelFetch(curve, ivec2(i + 1, 0), 0).r;
  return mix(a, b, t - float(i));
}

void main() {
  vec2 o = vec2(floor(gl_FragCoord.x), float(int(gl_FragCoord.y) + outputRow));
  vec2 lo = o * ratio;
  vec2 hi = lo + ratio;
  vec3 sum = vec3(0.0);
  float total = 0.0;
  for (int y = int(floor(lo.y)); float(y) < hi.y; y++) {
    float wy = min(hi.y, float(y + 1)) - max(lo.y, float(y));
    int by = clamp(y - sourceRow, 0, size.y - 1);
    for (int x = int(floor(lo.x)); float(x) < hi.x; x++) {
      float w = wy * (min(hi.x, float(x + 1)) - max(lo.x, float(x)));
      sum += w * texelFetch(source, ivec2(clamp(x, 0, size.x - 1), by), 0).rgb;
      total += w;
    }
  }
  vec3 linear = sum / total - shadowShift;
  colour = vec4(tone(linear.r), tone(linear.g), tone(linear.b), 1.0);
}`

type GL = WebGL2RenderingContext

function compile(gl: GL, fragment: string): WebGLProgram {
  const program = gl.createProgram()
  for (const [type, source] of [[gl.VERTEX_SHADER, VERTEX], [gl.FRAGMENT_SHADER, fragment]] as const) {
    const shader = gl.createShader(type)
    if (!shader) throw new Error('WebGL: no shader')
    gl.shaderSource(shader, source)
    gl.compileShader(shader)
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`WebGL shader: ${gl.getShaderInfoLog(shader)}`)
    gl.attachShader(program, shader)
  }
  gl.linkProgram(program)
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL link: ${gl.getProgramInfoLog(program)}`)
  return program
}

/** Creates the texture on unit 7, which no pass samples, so units already bound stay put. */
function texture(gl: GL, internal: number, width: number, height: number, filter: number = gl.NEAREST): WebGLTexture {
  const t = gl.createTexture()
  gl.activeTexture(gl.TEXTURE7)
  gl.bindTexture(gl.TEXTURE_2D, t)
  gl.texStorage2D(gl.TEXTURE_2D, 1, internal, width, height)
  for (const p of [gl.TEXTURE_MIN_FILTER, gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D, p, filter)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  return t
}

export interface RawImage {
  data: Uint16Array
  width: number
  height: number
}

/** Raw pixels per pixel of the small picture that the wide colour noise reduction works on. */
const LOW_FACTOR = 4
const LOW_ROUNDS = 2

export class GlDeveloper {
  private readonly gl: GL
  private readonly passL: WebGLProgram
  private readonly passLD: WebGLProgram
  private readonly passLB: WebGLProgram
  private readonly passA: WebGLProgram
  private readonly passG: WebGLProgram
  private readonly passB: WebGLProgram
  private readonly passS: WebGLProgram
  private readonly passC: WebGLProgram
  private readonly framebuffer: WebGLFramebuffer
  private readonly curve: WebGLTexture
  private rawTexture: WebGLTexture | null = null
  private rawKey: unknown = null
  readonly maxTextureSize: number

  /** Throws when WebGL2 or float render targets are missing; use developCpu then. */
  constructor(canvas: OffscreenCanvas | HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { antialias: false, depth: false, stencil: false, premultipliedAlpha: false }) as GL | null
    if (!gl) throw new Error('WebGL2 is not available')
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('WebGL2 cannot render to float textures')
    this.gl = gl
    this.maxTextureSize = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number
    this.passL = compile(gl, PASS_L)
    this.passLD = compile(gl, PASS_LD)
    this.passLB = compile(gl, PASS_LB)
    this.passA = compile(gl, PASS_A)
    this.passG = compile(gl, PASS_G)
    this.passB = compile(gl, PASS_B)
    this.passS = compile(gl, PASS_S)
    this.passC = compile(gl, PASS_C)
    this.framebuffer = gl.createFramebuffer()
    gl.bindVertexArray(gl.createVertexArray())
    this.curve = texture(gl, gl.R32F, TONE_CURVE.length, 1)
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TONE_CURVE.length, 1, gl.RED, gl.FLOAT, TONE_CURVE)
  }

  /** Uploads the crop of the raw once; later develops of the same `key` reuse it. */
  private upload(raw: RawImage, p: DevelopParams, key: unknown): void {
    const gl = this.gl
    if (this.rawKey === key && this.rawTexture) return
    if (this.rawTexture) gl.deleteTexture(this.rawTexture)
    const { width, height, x, y } = p.crop
    if (width > this.maxTextureSize || height > this.maxTextureSize) throw new Error('raw is larger than this GPU allows')
    this.rawTexture = texture(gl, gl.R16UI, width, height)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 2)
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, raw.width)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x)
    const chunk = 1024
    for (let row = 0; row < height; row += chunk) {
      const rows = Math.min(chunk, height - row)
      gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y + row)
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, row, width, rows, gl.RED_INTEGER, gl.UNSIGNED_SHORT, raw.data)
    }
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0)
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0)
    this.rawKey = key
  }

  /** Drops the uploaded raw (100 MB of GPU memory for an X1D file). */
  release(): void {
    if (this.rawTexture) this.gl.deleteTexture(this.rawTexture)
    this.rawTexture = null
    this.rawKey = null
  }

  develop(raw: RawImage, p: DevelopParams, key: unknown, options: { longSide?: number; noiseReduction?: number } = {}): DevelopedImage {
    const gl = this.gl
    this.upload(raw, p, key)
    const crop = p.crop
    const full = outputSize(crop.width, crop.height, options.longSide)
    const binned = full.width * 2 <= crop.width && full.height * 2 <= crop.height
    const srcW = binned ? crop.width >> 1 : crop.width
    const srcH = binned ? crop.height >> 1 : crop.height
    const outW = full.width
    const outH = full.height
    const ratioX = srcW / outW
    const ratioY = srcH / outH
    const step = binned ? 1 : 2
    const tuning = developTuning(p.iso, options.noiseReduction ?? 0, binned)
    const sharpen = tuning.sharpenAmount > 0
    const marginS = sharpen ? 4 : 0
    const marginB = 4 * step
    const sigma = tuning.sigma

    const bandOut = Math.max(1, Math.floor(512 / ratioY))
    const bandSrc = Math.ceil(bandOut * ratioY) + 2
    const texA = texture(gl, gl.RGBA16F, srcW, bandSrc + 2 * (marginB + marginS))
    const texG = binned ? null : texture(gl, gl.R32F, srcW, bandSrc + 2 * (marginB + marginS) + 2)
    const texB = texture(gl, gl.RGBA16F, srcW, bandSrc + 2 * marginS)
    const texS = sharpen ? texture(gl, gl.RGBA16F, srcW, bandSrc) : null
    const texC = texture(gl, gl.RGBA32F, outW, bandOut)
    const band = new Float32Array(outW * bandOut * 4)
    const lowW = Math.max(1, Math.floor(crop.width / LOW_FACTOR))
    const lowH = Math.max(1, Math.floor(crop.height / LOW_FACTOR))
    const low = texture(gl, gl.RGBA16F, lowW, lowH, gl.LINEAR)
    const lowChange = [texture(gl, gl.RGBA16F, lowW, lowH, gl.LINEAR), texture(gl, gl.RGBA16F, lowW, lowH, gl.LINEAR)]
    const lowBlur = tuning.lowReplace > 0 ? texture(gl, gl.RGBA16F, lowW, lowH, gl.LINEAR) : null
    const swap = p.orientation >= 5 && p.orientation <= 8
    const result = new Float32Array(outW * outH * 3)

    const target = (t: WebGLTexture, w: number, h: number) => {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0)
      gl.viewport(0, 0, w, h)
    }
    const bind = (program: WebGLProgram, unit: number, name: string, t: WebGLTexture) => {
      gl.activeTexture(gl.TEXTURE0 + unit)
      gl.bindTexture(gl.TEXTURE_2D, t)
      gl.uniform1i(gl.getUniformLocation(program, name), unit)
    }
    const u = (program: WebGLProgram, name: string) => gl.getUniformLocation(program, name)

    const scale = [0, 1, 2, 3].map((i) => p.wb[p.cfa[i]] / (p.white - p.black[i]))
    const ceiling = [0, 1, 2, 3].map((i) => p.wb[p.cfa[i]])
    // the CFA cell order is (0,0) (1,0) (0,1) (1,1); the parity moves it to crop coordinates
    for (const program of [this.passA, this.passG, this.passL]) {
      gl.useProgram(program)
      bind(program, 0, 'raw', this.rawTexture as WebGLTexture)
      gl.uniform2i(u(program, 'size'), crop.width, crop.height)
      gl.uniform2i(u(program, 'parity'), crop.x & 1, crop.y & 1)
      gl.uniform4i(u(program, 'cfa'), p.cfa[0], p.cfa[1], p.cfa[2], p.cfa[3])
      gl.uniform4f(u(program, 'black'), p.black[0], p.black[1], p.black[2], p.black[3])
      gl.uniform4f(u(program, 'scale'), scale[0], scale[1], scale[2], scale[3])
      gl.uniform4f(u(program, 'ceiling'), ceiling[0], ceiling[1], ceiling[2], ceiling[3])
    }
    gl.useProgram(this.passA)
    gl.uniform1i(u(this.passA, 'binned'), binned ? 1 : 0)
    // a float sampler, never left on unit 0 where the integer raw is
    gl.uniform1i(u(this.passA, 'green'), 3)
    gl.uniform1f(u(this.passA, 'sigma'), tuning.rawSigma)
    gl.useProgram(this.passG)
    gl.uniform1f(u(this.passG, 'sigma'), tuning.rawSigma)

    // the low-frequency colour noise, measured once on a small picture of the whole frame
    if (tuning.lowAmount > 0) {
      gl.useProgram(this.passL)
      gl.uniform1i(u(this.passL, 'factor'), LOW_FACTOR)
      target(low, lowW, lowH)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      gl.useProgram(this.passLD)
      gl.uniform2i(u(this.passLD, 'size'), lowW, lowH)
      gl.uniform1f(u(this.passLD, 'sigma'), tuning.lowSigma)
      gl.uniform1f(u(this.passLD, 'chromaRange'), tuning.lowChromaRange)
      gl.uniform1f(u(this.passLD, 'amount'), 1)
      bind(this.passLD, 1, 'source', low)
      // rounds three times wider each: blotches from a few to about forty raw pixels
      for (let round = 0; round < LOW_ROUNDS; round++) {
        gl.uniform1i(u(this.passLD, 'step'), 3 ** round)
        gl.uniform1i(u(this.passLD, 'accumulate'), round > 0 ? 1 : 0)
        bind(this.passLD, 2, 'previous', lowChange[(round + 1) % 2])
        target(lowChange[round % 2], lowW, lowH)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
      gl.useProgram(this.passLB)
      gl.uniform2i(u(this.passLB, 'size'), lowW, lowH)
      bind(this.passLB, 1, 'source', lowChange[(LOW_ROUNDS - 1) % 2])
      target(lowChange[LOW_ROUNDS % 2], lowW, lowH)
      gl.drawArrays(gl.TRIANGLES, 0, 3)
      if (lowBlur) {
        bind(this.passLB, 1, 'source', low)
        target(lowBlur, lowW, lowH)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
      }
    }

    gl.useProgram(this.passB)
    const m = p.matrix
    // uniformMatrix3fv takes columns
    gl.uniformMatrix3fv(u(this.passB, 'matrix'), false, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]])
    gl.uniform1i(u(this.passB, 'step'), step)
    gl.uniform1f(u(this.passB, 'sigma'), sigma)
    gl.uniform1f(u(this.passB, 'lumaAmount'), tuning.lumaAmount)
    gl.uniform1f(u(this.passB, 'lumaRange'), tuning.lumaRange)
    gl.uniform1f(u(this.passB, 'chromaAmount'), tuning.chromaAmount)
    gl.uniform1f(u(this.passB, 'chromaSigma'), tuning.chromaRange)
    gl.uniform1f(u(this.passB, 'lowAmount'), tuning.lowAmount)
    gl.uniform1f(u(this.passB, 'lowRange'), tuning.lowSigma * tuning.lowChromaRange)
    gl.uniform1f(u(this.passB, 'lowReplace'), lowBlur ? tuning.lowReplace : 0)
    gl.uniform1i(u(this.passB, 'falseColour'), binned ? 0 : 1)
    gl.uniform2f(u(this.passB, 'picture'), srcW, srcH)

    if (sharpen) {
      gl.useProgram(this.passS)
      gl.uniform1f(u(this.passS, 'amount'), tuning.sharpenAmount)
      gl.uniform1f(u(this.passS, 'radius'), tuning.sharpenRadius)
      gl.uniform1f(u(this.passS, 'limit'), tuning.sharpenLimit)
    }

    gl.useProgram(this.passC)
    gl.uniform2f(u(this.passC, 'ratio'), ratioX, ratioY)
    gl.uniform1i(u(this.passC, 'curveLength'), TONE_CURVE.length)
    gl.uniform1f(u(this.passC, 'curveMin'), TONE_LOG2_MIN)
    gl.uniform1f(u(this.passC, 'shadowShift'), p.shadowShift)

    for (let o0 = 0; o0 < outH; o0 += bandOut) {
      const o1 = Math.min(outH, o0 + bandOut)
      // source rows C reads, rows B writes (S's margin), rows A writes (B's margin)
      const c0 = Math.floor(o0 * ratioY)
      const c1 = Math.min(srcH, Math.ceil(o1 * ratioY))
      const b0 = Math.max(0, c0 - marginS)
      const b1 = Math.min(srcH, c1 + marginS)
      const a0 = Math.max(0, b0 - marginB)
      const a1 = Math.min(srcH, b1 + marginB)

      if (texG) {
        const g0 = Math.max(0, a0 - 1)
        const g1 = Math.min(srcH, a1 + 1)
        gl.useProgram(this.passG)
        target(texG, srcW, g1 - g0)
        gl.uniform1i(u(this.passG, 'rowBase'), g0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        gl.useProgram(this.passA)
        bind(this.passA, 3, 'green', texG)
        gl.uniform1i(u(this.passA, 'greenRow'), g0)
      }
      gl.useProgram(this.passA)
      target(texA, srcW, a1 - a0)
      gl.uniform1i(u(this.passA, 'rowBase'), a0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      gl.useProgram(this.passB)
      target(texB, srcW, b1 - b0)
      bind(this.passB, 1, 'source', texA)
      bind(this.passB, 4, 'lowChange', lowChange[LOW_ROUNDS % 2])
      bind(this.passB, 5, 'lowPicture', low)
      bind(this.passB, 6, 'lowBlur', lowBlur ?? low)
      gl.uniform2i(u(this.passB, 'size'), srcW, a1 - a0)
      gl.uniform1i(u(this.passB, 'offset'), b0 - a0)
      gl.uniform1i(u(this.passB, 'rowBase'), b0)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      let cSource = texB
      let cSourceRow = b0
      let cRows = b1 - b0
      if (texS) {
        gl.useProgram(this.passS)
        target(texS, srcW, c1 - c0)
        bind(this.passS, 1, 'source', texB)
        gl.uniform2i(u(this.passS, 'size'), srcW, b1 - b0)
        gl.uniform1i(u(this.passS, 'offset'), c0 - b0)
        gl.drawArrays(gl.TRIANGLES, 0, 3)
        cSource = texS
        cSourceRow = c0
        cRows = c1 - c0
      }

      gl.useProgram(this.passC)
      target(texC, outW, o1 - o0)
      bind(this.passC, 2, 'source', cSource)
      bind(this.passC, 3, 'curve', this.curve)
      gl.uniform2i(u(this.passC, 'size'), srcW, cRows)
      gl.uniform1i(u(this.passC, 'outputRow'), o0)
      gl.uniform1i(u(this.passC, 'sourceRow'), cSourceRow)
      gl.drawArrays(gl.TRIANGLES, 0, 3)

      gl.readPixels(0, 0, outW, o1 - o0, gl.RGBA, gl.FLOAT, band)
      orientToRgb(band, 4, outW, o1 - o0, p.orientation, result, o0, o1 - o0, outH)
    }
    for (const t of [texA, texG, texB, texC, texS, low, lowBlur, ...lowChange]) if (t) gl.deleteTexture(t)
    gl.bindFramebuffer(gl.FRAMEBUFFER, null)
    return { width: swap ? outH : outW, height: swap ? outW : outH, rgb: result }
  }
}
