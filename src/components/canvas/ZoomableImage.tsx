/**
 * An image in Canvas that can be zoomed and panned: drag to pan, the wheel
 * scrolls, pinch or Ctrl/Cmd+wheel zooms around the pointer, double-click
 * toggles between fitted and 100%. It opens fitted to the panel's width.
 */

import { useEffect, useRef, useState } from 'react'
import { usePanZoom } from './usePanZoom'
import { ZoomControls } from './ZoomControls'

interface Props {
  src: string
  alt: string
  /** The width the image means to be seen at, in CSS px (snapshots: the page's width). Defaults to its pixel width. */
  width?: number
}

export function ZoomableImage({ src, alt, width }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const { view, fit, zoomTo, zoomBy, handlers } = usePanZoom(viewportRef, { wheel: 'pan', fitMode: 'width', pad: 32 })
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  // Until the person zooms or pans, keep the image fitted as the panel resizes.
  const touched = useRef(false)

  const onLoad = (e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget
    if (!img.naturalWidth) return
    const w = width ?? img.naturalWidth
    const h = img.naturalHeight * (w / img.naturalWidth)
    setSize({ w, h })
    touched.current = false
    fit(w, h)
  }

  useEffect(() => {
    const vp = viewportRef.current
    if (!vp || !size || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => { if (!touched.current) fit() })
    observer.observe(vp)
    return () => { observer.disconnect() }
  }, [size, fit])

  const refit = () => { touched.current = false; fit() }

  const onDoubleClick = (e: React.MouseEvent) => {
    if ((e.target as Element).closest('[data-zoom-controls]')) return
    const vp = viewportRef.current
    if (!vp) return
    if (Math.abs(view.scale - 1) < 0.01) { refit(); return }
    const rect = vp.getBoundingClientRect()
    touched.current = true
    zoomTo(1, e.clientX - rect.left, e.clientY - rect.top)
  }

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
      onPointerDown={e => {
        if ((e.target as Element).closest('[data-zoom-controls]')) return
        touched.current = true
        handlers.onPointerDown(e)
      }}
      onPointerMove={handlers.onPointerMove}
      onPointerUp={handlers.onPointerUp}
      onPointerCancel={handlers.onPointerCancel}
      onWheelCapture={() => { touched.current = true }}
      onDoubleClick={onDoubleClick}
    >
      <img
        src={src}
        alt={alt}
        draggable={false}
        onLoad={onLoad}
        width={size?.w ?? width}
        height={size?.h}
        className="absolute left-0 top-0 max-w-none origin-top-left rounded-control border border-edge bg-surface"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, visibility: size ? 'visible' : 'hidden' }}
      />
      {size && (
        <>
          <div className="pointer-events-none absolute bottom-3 left-4 text-meta text-ink-faint">Drag to pan · pinch or Ctrl+scroll to zoom · double-click for 100%</div>
          <ZoomControls
            scale={view.scale}
            onZoomBy={f => { touched.current = true; zoomBy(f) }}
            onFit={refit}
            onActualSize={() => { touched.current = true; zoomTo(1) }}
          />
        </>
      )}
    </div>
  )
}
