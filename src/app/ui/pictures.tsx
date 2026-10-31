// Pictures on screen: small ones as images, large ones on a canvas that zooms and pans, and the
// shooting info line above a photo.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { ShootingInfo } from '../../engine/types'
import { infoHelp, infoParts, takenText } from '../../core/shootingInfo'
import { model } from '../model'
import { isAbort, type PhotoRef } from '../render'
import { FIT, isZoomed, useVisible, type Zoom } from './hooks'
import { Spinner, SwatchStrip } from './theme'

/** A small picture of a photo, as it comes from the camera or through a recipe, filling its
 *  frame. Without a photo, the recipe's colours instead. Made only once scrolled into view. */
export function Thumbnail({ photo, recipe, size = 280, alt = '' }: { photo: PhotoRef | null; recipe: string | null; size?: number; alt?: string }) {
  const [ref, visible] = useVisible<HTMLDivElement>()
  const [url, setUrl] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!visible || !photo) return
    const controller = new AbortController()
    setFailed(false)
    const load = (attempt: number) => {
      model.renderer.thumbnail(photo, size, recipe, controller.signal).then(
        (u) => !controller.signal.aborted && setUrl(u),
        (error: unknown) => {
          if (controller.signal.aborted) return
          // another view that shared this picture was closed first: ask again for ourselves
          if (isAbort(error) && attempt < 3) load(attempt + 1)
          else setFailed(true)
        },
      )
    }
    load(0)
    return () => controller.abort()
  }, [visible, photo, recipe, size])
  return (
    <div className="thumbnail" ref={ref}>
      {photo === null && recipe !== null ? (
        <SwatchStrip recipe={recipe} className="fill" />
      ) : url ? (
        <img src={url} alt={alt} draggable={false} />
      ) : failed ? (
        <span className="thumbnail-failed" title="This picture can't be shown">
          ×
        </span>
      ) : (
        visible && <Spinner label="Developing" />
      )}
    </div>
  )
}

/** An ImageBitmap on a canvas, which the browser scales to fit its box. */
export function BitmapView({ bitmap, className, style }: { bitmap: ImageBitmap; className?: string; style?: React.CSSProperties }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useLayoutEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    canvas.width = bitmap.width
    canvas.height = bitmap.height
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0)
  }, [bitmap])
  return <canvas ref={ref} className={className} style={style} aria-hidden="true" />
}

interface ZoomableProps {
  zoom: Zoom
  setZoom: (zoom: Zoom) => void
  /** the fitted picture's size on screen */
  size: { width: number; height: number }
  /** the photo's full width in pixels, so 100% is one photo pixel per screen pixel */
  fullPixels?: number
  children: ReactNode
  /** pressing and holding the picture (without moving it) */
  onHold?: (holding: boolean) => void
  /** drawn over the picture, not zoomed with it */
  overlay?: ReactNode
  label: string
}

/** Pinch, the scroll wheel, or the buttons to zoom; drag to move around when zoomed;
 *  double-click to go between the whole picture and 100%. */
export function Zoomable(props: ZoomableProps) {
  const { zoom, setZoom, size } = props
  const frame = useRef<HTMLDivElement>(null)
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ start: Zoom; distance: number; centre: { x: number; y: number }; moved: boolean } | null>(null)
  const hold = useRef<number | null>(null)
  const zoomRef = useRef(zoom)
  zoomRef.current = zoom

  const actualSize = props.fullPixels && size.width > 0 ? Math.max(props.fullPixels / (size.width * devicePixelRatio), 1) : 4
  const maxScale = actualSize * 2

  const clamp = useCallback(
    (z: Zoom): Zoom => {
      const scale = Math.min(Math.max(z.scale, 1), maxScale)
      const limitX = (size.width * (scale - 1)) / 2
      const limitY = (size.height * (scale - 1)) / 2
      return { scale, x: Math.min(Math.max(z.x, -limitX), limitX), y: Math.min(Math.max(z.y, -limitY), limitY) }
    },
    [maxScale, size.width, size.height],
  )

  /** zooms so the point under `at` (in the frame, from its top left) stays where it is */
  const zoomAround = useCallback(
    (from: Zoom, scale: number, at: { x: number; y: number }): Zoom => {
      const target = Math.min(Math.max(scale, 1), maxScale)
      const ax = at.x - size.width / 2
      const ay = at.y - size.height / 2
      const ratio = target / from.scale
      return clamp({ scale: target, x: ax - (ax - from.x) * ratio, y: ay - (ay - from.y) * ratio })
    },
    [clamp, maxScale, size.width, size.height],
  )

  const centre = { x: size.width / 2, y: size.height / 2 }
  const local = (event: { clientX: number; clientY: number }) => {
    const box = frame.current?.getBoundingClientRect()
    return { x: event.clientX - (box?.left ?? 0), y: event.clientY - (box?.top ?? 0) }
  }

  useEffect(() => {
    const element = frame.current
    if (!element) return
    const wheel = (event: WheelEvent) => {
      const current = zoomRef.current
      const mouseWheel = event.deltaMode !== 0 || (Number.isInteger(event.deltaY) && Math.abs(event.deltaY) >= 50 && event.deltaX === 0)
      if (event.ctrlKey || event.metaKey || mouseWheel) {
        event.preventDefault()
        const perStep = event.ctrlKey && !mouseWheel ? 0.01 : 0.0015
        const amount = event.deltaMode === 1 ? event.deltaY * 33 : event.deltaY
        setZoom(zoomAround(current, current.scale * Math.exp(-amount * perStep), local(event)))
      } else if (isZoomed(current)) {
        event.preventDefault()
        setZoom(clamp({ ...current, x: current.x - event.deltaX, y: current.y - event.deltaY }))
      }
    }
    element.addEventListener('wheel', wheel, { passive: false })
    return () => element.removeEventListener('wheel', wheel)
  })

  const stopHold = () => {
    if (hold.current !== null) window.clearTimeout(hold.current)
    hold.current = null
  }

  const onPointerDown = (event: React.PointerEvent) => {
    if ((event.target as HTMLElement).closest('.zoom-controls, .split-handle')) return
    frame.current?.setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, local(event))
    const points = [...pointers.current.values()]
    const mid = points.length === 2 ? { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 } : points[0]
    const distance = points.length === 2 ? Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y) : 0
    gesture.current = { start: zoomRef.current, distance, centre: mid, moved: false }
    stopHold()
    if (points.length === 1 && props.onHold) {
      const onHold = props.onHold
      hold.current = window.setTimeout(() => onHold(true), 300)
    } else props.onHold?.(false)
  }

  const onPointerMove = (event: React.PointerEvent) => {
    if (!pointers.current.has(event.pointerId) || !gesture.current) return
    pointers.current.set(event.pointerId, local(event))
    const points = [...pointers.current.values()]
    const g = gesture.current
    if (points.length === 2 && g.distance > 0) {
      const distance = Math.hypot(points[0].x - points[1].x, points[0].y - points[1].y)
      g.moved = true
      setZoom(zoomAround(g.start, g.start.scale * (distance / g.distance), g.centre))
    } else if (points.length === 1) {
      const dx = points[0].x - g.centre.x
      const dy = points[0].y - g.centre.y
      if (!g.moved && Math.hypot(dx, dy) < 6) return
      g.moved = true
      stopHold()
      if (isZoomed(g.start)) setZoom(clamp({ ...g.start, x: g.start.x + dx, y: g.start.y + dy }))
    }
  }

  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId)
    stopHold()
    props.onHold?.(false)
    const points = [...pointers.current.values()]
    gesture.current = points.length === 1 ? { start: zoomRef.current, distance: 0, centre: points[0], moved: true } : null
  }

  const step = (factor: number) => setZoom(zoomAround(zoom, zoom.scale * factor, centre))
  const percent = Math.round((zoom.scale / actualSize) * 100)

  return (
    <div
      ref={frame}
      className={`zoom-frame${isZoomed(zoom) ? ' zoomed' : ''}`}
      style={{ width: size.width, height: size.height }}
      role="img"
      aria-label={props.label}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onContextMenu={(e) => props.onHold && e.preventDefault()}
      onDoubleClick={(event) => setZoom(isZoomed(zoom) ? FIT : zoomAround(zoom, actualSize, local(event)))}
    >
      <div className="zoom-content" style={{ transform: `translate(${zoom.x}px, ${zoom.y}px) scale(${zoom.scale})` }}>
        {props.children}
      </div>
      {props.overlay}
      <div className="zoom-controls" onDoubleClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={() => setZoom(FIT)} disabled={!isZoomed(zoom)} title="Fit (Ctrl/⌘ 0)">
          Fit
        </button>
        <button type="button" className="zoom-step" onClick={() => step(1 / 1.25)} disabled={!isZoomed(zoom)} aria-label="Zoom out" title="Zoom out (Ctrl/⌘ −)">
          −
        </button>
        <span className="zoom-percent" aria-live="polite">
          {percent}%
        </span>
        <button type="button" className="zoom-step" onClick={() => step(1.25)} disabled={zoom.scale >= maxScale} aria-label="Zoom in" title="Zoom in (Ctrl/⌘ =)">
          +
        </button>
        <button type="button" onClick={() => setZoom(zoomAround(zoom, actualSize, centre))} title="100% (Ctrl/⌘ 1)">
          100%
        </button>
      </div>
    </div>
  )
}

/** A line above a photo with how it was taken: shutter speed, aperture, ISO, compensation,
 *  focal length, lens, and when (by the camera's own clock). */
export function ShootingInfoBar({ photo }: { photo: PhotoRef | null }) {
  const [info, setInfo] = useState<ShootingInfo | null>(null)
  useEffect(() => {
    setInfo(null)
    if (!photo) return
    let current = true
    model.renderer.info(photo).then(
      (i) => current && setInfo(i),
      () => {},
    )
    return () => {
      current = false
    }
  }, [photo])
  const parts = info ? infoParts(info) : []
  const exposure = Math.min(3, parts.length)
  return (
    <p className="shooting-info" title={info ? infoHelp(info) : undefined}>
      {parts.length === 0 && !info?.taken ? (
        ' '
      ) : (
        <>
          {parts.map((part, i) => (
            <span key={i} className={i < exposure ? 'bright' : undefined}>
              {part}
            </span>
          ))}
          {info?.taken && <span>{takenText(info.taken)}</span>}
        </>
      )}
    </p>
  )
}
