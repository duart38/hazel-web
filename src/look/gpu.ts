// The look's per-pixel part on the GPU, for instant feedback while a slider moves: the picture
// through the table look.c builds (LookEngine.buildTable, 33 points), with the same trilinear
// blend as look_table_apply. Spatial effects (clarity, grain, vignette, halation, sharpness,
// aberration) aren't in the table: show this while dragging and swap in applyImage's picture
// when it arrives.

import type { DevelopedImage } from '../engine/types'

/** A picture already decoded by the browser (a JPEG preview, say): sRGB-encoded 8-bit. */
export type PreviewSource = ImageBitmap | HTMLImageElement | HTMLCanvasElement | OffscreenCanvas | ImageData

/** Part of the picture to draw, in 0..1 of its width and height (default: all of it). */
export interface PreviewRegion {
  x: number
  y: number
  width: number
  height: number
}

const VERTEX = `#version 300 es
uniform vec4 u_region;
out vec2 v_uv;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  v_uv = u_region.xy + corner * u_region.zw;
  gl_Position = vec4(corner.x * 2.0 - 1.0, 1.0 - corner.y * 2.0, 0.0, 1.0);
}`

// look_table_apply, line for line: the position on each axis, the lower grid point (never the
// last), and the eight corners summed in the same order with the same weights.
const FRAGMENT = `#version 300 es
precision highp float;
precision highp int;
precision highp sampler3D;
uniform sampler2D u_image;
uniform sampler3D u_table;
uniform int u_n;
uniform bool u_look;
in vec2 v_uv;
out vec4 colour;
void main() {
  vec3 rgb = texture(u_image, v_uv).rgb;
  if (!u_look) { colour = vec4(rgb, 1.0); return; }
  vec3 x = clamp(rgb, 0.0, 1.0) * float(u_n - 1);
  ivec3 i0 = min(ivec3(x), ivec3(u_n - 2));
  vec3 f = x - vec3(i0);
  vec3 sum = vec3(0.0);
  for (int corner = 0; corner < 8; corner++) {
    ivec3 on = ivec3(corner & 1, (corner >> 1) & 1, (corner >> 2) & 1);
    float w = (on.x == 1 ? f.x : 1.0 - f.x) * (on.y == 1 ? f.y : 1.0 - f.y) * (on.z == 1 ? f.z : 1.0 - f.z);
    sum += w * texelFetch(u_table, i0 + on, 0).rgb;
  }
  colour = vec4(sum, 1.0);
}`

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type)
  if (!shader) throw new Error('WebGL2: no shader')
  gl.shaderSource(shader, source)
  gl.compileShader(shader)
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(`WebGL2 shader: ${gl.getShaderInfoLog(shader)}`)
  return shader
}

function isDeveloped(source: DevelopedImage | PreviewSource): source is DevelopedImage {
  return 'rgb' in source && source.rgb instanceof Float32Array
}

export class LookPreview {
  private readonly gl: WebGL2RenderingContext
  private readonly program: WebGLProgram
  private readonly image: WebGLTexture
  private readonly table: WebGLTexture
  private readonly floatLinear: boolean
  private n = 0
  private imageSize = { width: 0, height: 0 }
  private readonly uniforms: {
    region: WebGLUniformLocation | null
    n: WebGLUniformLocation | null
    look: WebGLUniformLocation | null
    image: WebGLUniformLocation | null
    table: WebGLUniformLocation | null
  }

  readonly canvas: HTMLCanvasElement | OffscreenCanvas

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    this.canvas = canvas
    const attributes: WebGLContextAttributes = { antialias: false, premultipliedAlpha: false, alpha: false }
    const gl =
      typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement
        ? canvas.getContext('webgl2', attributes)
        : (canvas as OffscreenCanvas).getContext('webgl2', attributes)
    if (!gl) throw new Error('This browser has no WebGL2')
    this.gl = gl
    // Linear filtering of float textures is an extension (most desktops, few phones); without
    // it a float picture is sampled nearest, fine when it's developed at about the canvas size.
    this.floatLinear = gl.getExtension('OES_texture_float_linear') !== null
    const program = gl.createProgram()
    if (!program) throw new Error('WebGL2: no program')
    gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(program)
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`WebGL2 program: ${gl.getProgramInfoLog(program)}`)
    this.program = program
    this.uniforms = {
      region: gl.getUniformLocation(program, 'u_region'),
      n: gl.getUniformLocation(program, 'u_n'),
      look: gl.getUniformLocation(program, 'u_look'),
      image: gl.getUniformLocation(program, 'u_image'),
      table: gl.getUniformLocation(program, 'u_table'),
    }
    const image = gl.createTexture()
    const table = gl.createTexture()
    if (!image || !table) throw new Error('WebGL2: no texture')
    this.image = image
    this.table = table
  }

  get width(): number {
    return this.imageSize.width
  }

  get height(): number {
    return this.imageSize.height
  }

  /** The picture to preview: a developed one (float RGB) or one the browser decoded. */
  setImage(source: DevelopedImage | PreviewSource): void {
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.image)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false)
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false)
    // the look works on the encoded values: no colour management on the way in
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE)
    let filter: number = gl.LINEAR
    if (isDeveloped(source)) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, source.width, source.height, 0, gl.RGB, gl.FLOAT, source.rgb)
      this.imageSize = { width: source.width, height: source.height }
      if (!this.floatLinear) filter = gl.NEAREST
    } else {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, source)
      this.imageSize = { width: source.width, height: source.height }
    }
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
  }

  /** The look's table: buildTable(settings, n), n*n*n RGB floats, red fastest. */
  setTable(table: Float32Array, n: number): void {
    if (table.length !== 3 * n * n * n) throw new RangeError(`${table.length} floats for a ${n}-point table`)
    const gl = this.gl
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.table)
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
    // red fastest: x is red, y green, z blue, as look_table_apply indexes it
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, n, n, n, 0, gl.RGB, gl.FLOAT, table)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    this.n = n
  }

  /** Draws the picture (or part of it) over the whole canvas, with the look unless `look` is
   *  false or no table was set. Size the canvas to the picture's aspect ratio yourself. */
  draw(options: { region?: PreviewRegion; look?: boolean } = {}): void {
    const gl = this.gl
    const region = options.region ?? { x: 0, y: 0, width: 1, height: 1 }
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight)
    gl.useProgram(this.program)
    gl.activeTexture(gl.TEXTURE0)
    gl.bindTexture(gl.TEXTURE_2D, this.image)
    gl.activeTexture(gl.TEXTURE1)
    gl.bindTexture(gl.TEXTURE_3D, this.table)
    gl.uniform1i(this.uniforms.image, 0)
    gl.uniform1i(this.uniforms.table, 1)
    gl.uniform1i(this.uniforms.n, this.n)
    gl.uniform1i(this.uniforms.look, options.look !== false && this.n >= 2 ? 1 : 0)
    gl.uniform4f(this.uniforms.region, region.x, region.y, region.width, region.height)
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
  }

  /** The drawn pixels, RGBA bytes, bottom row first (WebGL's order): for tests and snapshots. */
  readPixels(): Uint8Array {
    const gl = this.gl
    const pixels = new Uint8Array(4 * gl.drawingBufferWidth * gl.drawingBufferHeight)
    gl.readPixels(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.RGBA, gl.UNSIGNED_BYTE, pixels)
    return pixels
  }

  dispose(): void {
    const gl = this.gl
    gl.deleteTexture(this.image)
    gl.deleteTexture(this.table)
    gl.deleteProgram(this.program)
  }
}
