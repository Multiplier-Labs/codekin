/**
 * Pan and zoom for a Canvas viewport (diagrams, images): drag to pan, wheel
 * or trackpad pinch to zoom around the pointer, two-finger pinch on touch,
 * zoom buttons around the centre, and fit-to-view.
 *
 * The content is laid out at its natural size inside an absolutely placed
 * wrapper with `transform: translate(x, y) scale(scale)` and a top-left
 * origin; the hook only tracks that transform.
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'

export const MIN_SCALE = 0.1
export const MAX_SCALE = 8

export interface PanZoomView { scale: number; x: number; y: number }

interface Options {
  /**
   * What a plain wheel does. 'zoom' (diagrams): every wheel zooms. 'pan'
   * (images): the wheel scrolls the content, and pinch or Ctrl/Cmd+wheel zooms.
   */
  wheel?: 'zoom' | 'pan'
  /**
   * How fit-to-view sizes the content. 'contain' fits it whole; 'width' fits
   * its width and starts at the top, so a tall page reads by scrolling.
   */
  fitMode?: 'contain' | 'width'
  /** Space kept around the content when it is fitted, in px. */
  pad?: number
}

const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s))

/** The view after zooming to `scale` while keeping point (px, py) of the viewport still. */
function zoomAround(v: PanZoomView, scale: number, px: number, py: number): PanZoomView {
  const next = clampScale(scale)
  const k = next / v.scale
  return { scale: next, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
}

export function usePanZoom(viewportRef: RefObject<HTMLElement | null>, { wheel = 'zoom', fitMode = 'contain', pad = 48 }: Options = {}) {
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const size = useRef({ w: 0, h: 0 })

  /** Fit the content to the viewport (never above 100%). Pass its natural size when it changes. */
  const fit = useCallback((w?: number, h?: number) => {
    if (w !== undefined && h !== undefined) size.current = { w, h }
    const vp = viewportRef.current
    const { w: cw, h: ch } = size.current
    if (!vp || !cw || !ch) return
    const byWidth = (vp.clientWidth - pad) / cw
    const scale = clampScale(Math.min(1, fitMode === 'width' ? byWidth : Math.min(byWidth, (vp.clientHeight - pad) / ch)))
    const y = fitMode === 'width' && ch * scale + pad > vp.clientHeight
      ? pad / 2
      : Math.max(pad / 2, (vp.clientHeight - ch * scale) / 2)
    setView({ scale, x: (vp.clientWidth - cw * scale) / 2, y })
  }, [viewportRef, fitMode, pad])

  /** Zoom to an absolute scale around the viewport's centre, or around (px, py). */
  const zoomTo = useCallback((scale: number, px?: number, py?: number) => {
    const vp = viewportRef.current
    if (!vp) return
    setView(v => zoomAround(v, scale, px ?? vp.clientWidth / 2, py ?? vp.clientHeight / 2))
  }, [viewportRef])

  const zoomBy = useCallback((factor: number) => {
    const vp = viewportRef.current
    if (!vp) return
    setView(v => zoomAround(v, v.scale * factor, vp.clientWidth / 2, vp.clientHeight / 2))
  }, [viewportRef])

  // Wheel (non-passive, so the panel itself doesn't scroll). Trackpad pinch
  // arrives as a wheel event with ctrlKey set.
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const lines = e.deltaMode === 1 ? 16 : 1
      if (wheel === 'pan' && !e.ctrlKey && !e.metaKey) {
        const dx = (e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX) * lines
        const dy = (e.shiftKey && !e.deltaX ? 0 : e.deltaY) * lines
        setView(v => ({ ...v, x: v.x - dx, y: v.y - dy }))
        return
      }
      const rect = vp.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      // Pinch deltas are small and precise; mouse wheels step in large notches.
      const speed = e.ctrlKey ? 0.01 : 0.0015
      setView(v => zoomAround(v, v.scale * Math.exp(-e.deltaY * lines * speed), px, py))
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => { vp.removeEventListener('wheel', onWheel) }
  }, [viewportRef, wheel])

  // Pointers: one drags, two pinch. `moved` tells a click from a drag.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean } | null>(null)
  const pinch = useRef<{ dist: number; scale: number; mx: number; my: number; vx: number; vy: number } | null>(null)

  const beginPinch = () => {
    const vp = viewportRef.current
    if (!vp || pointers.current.size < 2) return
    const [a, b] = [...pointers.current.values()]
    const rect = vp.getBoundingClientRect()
    pinch.current = {
      dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
      mx: (a.x + b.x) / 2 - rect.left, my: (a.y + b.y) / 2 - rect.top,
      scale: view.scale, vx: view.x, vy: view.y,
    }
    if (gesture.current) gesture.current.moved = true
  }

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    if (pointers.current.size === 2) { beginPinch(); return }
    gesture.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    const p = pinch.current
    if (p && pointers.current.size >= 2) {
      const vp = viewportRef.current
      const [a, b] = [...pointers.current.values()]
      if (!vp) return
      const rect = vp.getBoundingClientRect()
      const scale = clampScale(p.scale * Math.hypot(a.x - b.x, a.y - b.y) / p.dist)
      const mx = (a.x + b.x) / 2 - rect.left
      const my = (a.y + b.y) / 2 - rect.top
      // The content point under the starting midpoint follows the fingers.
      const k = scale / p.scale
      setView({ scale, x: mx - (p.mx - p.vx) * k, y: my - (p.my - p.vy) * k })
      return
    }
    const d = gesture.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.moved) setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }

  /** Ends a pointer; returns true when this was a click (no drag, no pinch). */
  const onPointerUp = (e: React.PointerEvent): boolean => {
    pointers.current.delete(e.pointerId)
    if (pinch.current) {
      if (pointers.current.size < 2) pinch.current = null
      // One finger left on the glass carries on dragging from here.
      const [rest] = pointers.current.size ? [...pointers.current.values()] : [null]
      gesture.current = rest ? { x: rest.x, y: rest.y, vx: view.x, vy: view.y, moved: true } : null
      return false
    }
    const d = gesture.current
    gesture.current = null
    return !!d && !d.moved
  }

  return { view, fit, zoomTo, zoomBy, handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel: onPointerUp } }
}
