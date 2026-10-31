// What the picture components share: zoom state, element sizes, and being on screen.

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

/** How far a picture is zoomed and where it's moved to. Scale 1 is the whole picture fitted in
 *  its frame; the offset is in CSS pixels, from the centre. */
export interface Zoom {
  scale: number
  x: number
  y: number
}
export const FIT: Zoom = { scale: 1, x: 0, y: 0 }
export const isZoomed = (zoom: Zoom) => zoom.scale > 1.01

export function useElementSize<T extends HTMLElement>(): [RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      setSize((old) => (old.width === width && old.height === height ? old : { width, height }))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return [ref, size]
}

/** the largest size with this aspect ratio that fits */
export function fitted(aspect: number, box: { width: number; height: number }) {
  if (box.width <= 0 || box.height <= 0) return { width: 0, height: 0 }
  return box.width / box.height > aspect
    ? { width: box.height * aspect, height: box.height }
    : { width: box.width, height: box.width / aspect }
}

/** Ctrl/⌘ 0, −, = and 1 for the zoomable picture on screen. */
export function useZoomKeys(active: boolean, zoom: Zoom, setZoom: (zoom: Zoom) => void, size: { width: number; height: number }, fullPixels?: number) {
  useEffect(() => {
    if (!active) return
    const actualSize = fullPixels && size.width > 0 ? Math.max(fullPixels / (size.width * devicePixelRatio), 1) : 4
    const keys = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const clampScale = (s: number) => Math.min(Math.max(s, 1), actualSize * 2)
      // around the centre, never moved so far that the frame shows past the picture's edge
      const scaled = (s: number): Zoom => {
        const scale = clampScale(s)
        const ratio = scale / zoom.scale
        const limitX = (size.width * (scale - 1)) / 2
        const limitY = (size.height * (scale - 1)) / 2
        return {
          scale,
          x: Math.min(Math.max(zoom.x * ratio, -limitX), limitX),
          y: Math.min(Math.max(zoom.y * ratio, -limitY), limitY),
        }
      }
      if (event.key === '0') setZoom(FIT)
      else if (event.key === '-') setZoom(scaled(zoom.scale / 1.25))
      else if (event.key === '=' || event.key === '+') setZoom(scaled(zoom.scale * 1.25))
      else if (event.key === '1') setZoom(scaled(actualSize))
      else return
      event.preventDefault()
    }
    window.addEventListener('keydown', keys)
    return () => window.removeEventListener('keydown', keys)
  }, [active, zoom, setZoom, size.width, size.height, fullPixels])
}

/** Is this element on screen (or near it)? Pictures are only made for what's scrolled into view. */
export function useVisible<T extends Element>(margin = '300px'): [RefObject<T | null>, boolean] {
  const ref = useRef<T>(null)
  const [visible, setVisible] = useState(false)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: margin })
    observer.observe(element)
    return () => observer.disconnect()
  }, [margin])
  return [ref, visible]
}
