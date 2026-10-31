// The look on the GPU while it's changing: look.c's 33-point table (LookEngine.buildTable) on a
// developed picture, redrawn in the same frame as the slider moves. Spatial effects (grain,
// sharpness, clarity, vignette, halation, fringing) aren't in a table, so the full engine's
// picture replaces this one once it arrives for the same settings.

import { useLayoutEffect, useRef } from 'react'
import type { DevelopedImage, LookSettings } from '../../engine/types'
import { LookPreview, type PreviewRegion } from '../../look'
import { model } from '../model'
import type { Zoom } from './hooks'

const TABLE_POINTS = 33

interface LiveLookProps {
  /** the picture at about screen size */
  screen: DevelopedImage | null
  /** the whole photo, when it's been developed at full size for zooming in */
  full: DevelopedImage | null
  look: LookSettings | null
  /** changes exactly when `look` does (the recipe text), so the table is built once per change */
  lookKey: string
  /** false hides it, showing what's underneath */
  show: boolean
  zoom: Zoom
  /** the fitted picture's size on screen, CSS pixels */
  size: { width: number; height: number }
  /** only right of this fraction of the frame: the after side of a before/after split */
  clipLeft?: number
}

interface Crop {
  full: DevelopedImage
  /** in the full picture's pixels */
  x: number
  y: number
  width: number
  height: number
  step: number
  image: DevelopedImage
}

/** The part of the picture on screen, in 0..1 of the whole, for a zoom (translate, then scale
 *  about the centre). */
function visibleRegion(zoom: Zoom, size: { width: number; height: number }): PreviewRegion {
  const width = 1 / zoom.scale
  const height = 1 / zoom.scale
  return {
    x: 0.5 - width / 2 - zoom.x / (zoom.scale * size.width),
    y: 0.5 - height / 2 - zoom.y / (zoom.scale * size.height),
    width,
    height,
  }
}

/** A box-averaged cut of `full` around what's on screen, `step` full pixels to one. */
function cropOf(full: DevelopedImage, region: PreviewRegion, step: number): Crop {
  const margin = 0.25
  const x0 = Math.max(0, Math.floor((region.x - region.width * margin) * full.width))
  const y0 = Math.max(0, Math.floor((region.y - region.height * margin) * full.height))
  const x1 = Math.min(full.width, Math.ceil((region.x + region.width * (1 + margin)) * full.width))
  const y1 = Math.min(full.height, Math.ceil((region.y + region.height * (1 + margin)) * full.height))
  const width = Math.max(1, Math.floor((x1 - x0) / step))
  const height = Math.max(1, Math.floor((y1 - y0) / step))
  const rgb = new Float32Array(width * height * 3)
  const source = full.rgb
  const share = 1 / (step * step)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let r = 0
      let g = 0
      let b = 0
      for (let dy = 0; dy < step; dy++) {
        let at = ((y0 + y * step + dy) * full.width + x0 + x * step) * 3
        for (let dx = 0; dx < step; dx++, at += 3) {
          r += source[at]
          g += source[at + 1]
          b += source[at + 2]
        }
      }
      const out = (y * width + x) * 3
      rgb[out] = r * share
      rgb[out + 1] = g * share
      rgb[out + 2] = b * share
    }
  }
  return { full, x: x0, y: y0, width: width * step, height: height * step, step, image: { width, height, rgb } }
}

/** Drawn over the picture inside a Zoomable's overlay: it isn't zoomed itself, it draws the
 *  part of the picture that's on screen at the screen's resolution. */
export function LiveLook({ screen, full, look, lookKey, show, zoom, size, clipLeft = 0 }: LiveLookProps) {
  const holder = useRef<HTMLDivElement>(null)
  const gpu = useRef<{ canvas: HTMLCanvasElement; preview: LookPreview } | null>(null)
  const uploaded = useRef<DevelopedImage | null>(null)
  const table = useRef<string | null>(null)
  const crop = useRef<Crop | null>(null)

  // a canvas of its own per mount, given back on unmount: browsers keep only a few WebGL contexts
  useLayoutEffect(() => {
    const box = holder.current
    if (!box || !model.engines.webgl2) return
    const canvas = document.createElement('canvas')
    try {
      gpu.current = { canvas, preview: new LookPreview(canvas) }
    } catch (error) {
      console.warn('Hazel: no live look preview', error)
      return
    }
    box.append(canvas)
    uploaded.current = null
    table.current = null
    return () => {
      gpu.current?.preview.dispose()
      canvas.getContext('webgl2')?.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
      gpu.current = null
    }
  }, [])

  // every render: cheap unless the picture, the look or the view changed
  useLayoutEffect(() => {
    const box = holder.current
    if (!box) return
    const hide = () => {
      box.style.visibility = 'hidden'
    }
    if (!show || !screen || size.width <= 0 || size.height <= 0 || !gpu.current) return hide()
    const { canvas, preview } = gpu.current
    const pixels = { width: Math.round(size.width * devicePixelRatio), height: Math.round(size.height * devicePixelRatio) }
    if (canvas.width !== pixels.width || canvas.height !== pixels.height) {
      canvas.width = pixels.width
      canvas.height = pixels.height
    }

    // zoomed in on a full-size development: a cut of it around the view, sharp at 100%
    let region = visibleRegion(zoom, size)
    let source = screen
    if (full && zoom.scale > 1.01 && region.width * full.width > screen.width * 1.1) {
      const step = Math.max(1, Math.floor((region.width * full.width) / pixels.width))
      let cut = crop.current
      const inside =
        cut !== null &&
        cut.full === full &&
        cut.step === step &&
        region.x * full.width >= cut.x &&
        region.y * full.height >= cut.y &&
        (region.x + region.width) * full.width <= cut.x + cut.width &&
        (region.y + region.height) * full.height <= cut.y + cut.height
      if (!inside || !cut) cut = crop.current = cropOf(full, region, step)
      source = cut.image
      region = {
        x: (region.x * full.width - cut.x) / cut.width,
        y: (region.y * full.height - cut.y) / cut.height,
        width: (region.width * full.width) / cut.width,
        height: (region.height * full.height) / cut.height,
      }
    } else if (crop.current && crop.current.full !== full) crop.current = null

    if (uploaded.current !== source) {
      preview.setImage(source)
      uploaded.current = source
    }
    if (look && table.current !== lookKey) {
      preview.setTable(model.engines.look.buildTable(look, TABLE_POINTS), TABLE_POINTS)
      table.current = lookKey
    }
    preview.draw({ region, look: look !== null })
    box.style.visibility = 'visible'
  })

  return (
    <div
      ref={holder}
      className="live-look"
      aria-hidden="true"
      style={{ visibility: 'hidden', clipPath: clipLeft > 0 ? `inset(0 0 0 ${clipLeft * 100}%)` : undefined }}
    />
  )
}
