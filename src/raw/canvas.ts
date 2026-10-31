export type AnyCanvas = OffscreenCanvas | HTMLCanvasElement
export type Context2D = OffscreenCanvasRenderingContext2D | CanvasRenderingContext2D

export function makeCanvas(width: number, height: number): AnyCanvas {
  if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  return canvas
}

export function context2d(canvas: AnyCanvas): Context2D {
  const ctx = canvas.getContext('2d') as Context2D | null
  if (!ctx) throw new Error('no 2D canvas')
  return ctx
}

export async function canvasBlob(canvas: AnyCanvas, type: string, quality?: number): Promise<Blob> {
  if ('convertToBlob' in canvas) return canvas.convertToBlob({ type, quality })
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error(`could not encode ${type}`))), type, quality)
  })
}

/** A canvas holding `source` turned upright for EXIF `orientation`. */
export function orientedCanvas(source: CanvasImageSource & { width: number; height: number }, orientation: number): AnyCanvas {
  const w = source.width
  const h = source.height
  const swap = orientation >= 5 && orientation <= 8
  const canvas = makeCanvas(swap ? h : w, swap ? w : h)
  const ctx = context2d(canvas)
  // maps the stored picture onto the upright one; same table as orientToRgb
  const transforms: Record<number, [number, number, number, number, number, number]> = {
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, w, 0],
    3: [-1, 0, 0, -1, w, h],
    4: [1, 0, 0, -1, 0, h],
    5: [0, 1, 1, 0, 0, 0],
    6: [0, 1, -1, 0, h, 0],
    7: [0, -1, -1, 0, h, w],
    8: [0, -1, 1, 0, 0, w],
  }
  ctx.setTransform(...(transforms[orientation] ?? transforms[1]))
  ctx.drawImage(source, 0, 0)
  return canvas
}
