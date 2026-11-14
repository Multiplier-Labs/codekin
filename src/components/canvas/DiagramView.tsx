/**
 * Diagram items (design handoff frame C): Mermaid rendered in strict mode,
 * with drag to pan, scroll to zoom, zoom controls, and fit-to-view. Nodes
 * described in the item's metadata can be clicked to see the file they stand
 * for, ask the agent about them, or open the file in Canvas.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconAlertTriangle, IconLoader2, IconMaximize, IconMinus, IconPlus } from '@tabler/icons-react'
import type { CanvasItemMeta } from '../../types'
import { mermaidNodeId, mountSvg, renderMermaid } from '../../lib/mermaidRender'
import { canvasKindForPath } from '../../lib/canvas'

type NodeInfo = NonNullable<CanvasItemMeta['nodes']>[string]

interface Props {
  source: string
  meta?: CanvasItemMeta
  /** Attach a node to the next message (ask: also bring the composer up). */
  onAttachNode: (label: string, excerpt: string, ask: boolean) => void
  /** Show a file in Canvas (only offered for files Canvas can show). */
  onOpenFile: (path: string) => void
}

const MIN = 0.2
const MAX = 4

function currentScheme(): 'light' | 'dark' {
  return document.documentElement.dataset.scheme === 'dark' ? 'dark' : 'light'
}

export function DiagramView({ source, meta, onAttachNode, onOpenFile }: Props) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const hostRef = useRef<HTMLDivElement>(null)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }>({ status: 'loading' })
  const [scheme, setScheme] = useState(currentScheme)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [popover, setPopover] = useState<{ id: string; label: string; info: NodeInfo; x: number; y: number } | null>(null)
  const size = useRef({ w: 0, h: 0 })

  // Re-render when the theme flips between light and dark.
  useEffect(() => {
    const observer = new MutationObserver(() => { setScheme(currentScheme()) })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] })
    return () => { observer.disconnect() }
  }, [])

  const fit = useCallback(() => {
    const vp = viewportRef.current
    const { w, h } = size.current
    if (!vp || !w || !h) return
    const pad = 48
    const scale = Math.min(1, (vp.clientWidth - pad) / w, (vp.clientHeight - pad) / h)
    setView({ scale, x: (vp.clientWidth - w * scale) / 2, y: Math.max(pad / 2, (vp.clientHeight - h * scale) / 2) })
  }, [])

  useEffect(() => {
    let cancelled = false
    let cleanup: (() => void) | undefined
    setState({ status: 'loading' }) // eslint-disable-line react-hooks/set-state-in-effect -- a new source starts loading
    setPopover(null)
    renderMermaid(source, scheme).then(svg => {
      if (cancelled || !hostRef.current) return
      cleanup = mountSvg(hostRef.current, svg)
      const el = hostRef.current.querySelector('svg')
      if (el) {
        // Lay the SVG out at its natural size; the wrapper scales it.
        const vb = el.viewBox.baseVal
        size.current = { w: vb.width || el.getBoundingClientRect().width, h: vb.height || el.getBoundingClientRect().height }
        el.style.maxWidth = 'none'
        el.setAttribute('width', String(size.current.w))
        el.setAttribute('height', String(size.current.h))
        for (const node of Array.from(el.querySelectorAll('g.node'))) {
          const id = mermaidNodeId(node)
          if (id && meta?.nodes?.[id]) (node as SVGGElement).style.cursor = 'pointer'
        }
      }
      setState({ status: 'ready' })
      fit()
    }).catch((err: unknown) => {
      if (!cancelled) setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    })
    return () => { cancelled = true; cleanup?.() }
  }, [source, scheme, meta, fit])

  // Scroll to zoom around the pointer (non-passive, so the panel doesn't scroll).
  useEffect(() => {
    const vp = viewportRef.current
    if (!vp) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const rect = vp.getBoundingClientRect()
      const px = e.clientX - rect.left
      const py = e.clientY - rect.top
      setView(v => {
        const scale = Math.min(MAX, Math.max(MIN, v.scale * Math.exp(-e.deltaY * 0.0015)))
        const k = scale / v.scale
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    }
    vp.addEventListener('wheel', onWheel, { passive: false })
    return () => { vp.removeEventListener('wheel', onWheel) }
  }, [])

  // The node under the pointer is taken at pointerdown: once the viewport
  // captures the pointer, pointerup targets the viewport, not the node.
  const drag = useRef<{ x: number; y: number; vx: number; vy: number; moved: boolean; node: Element | null } | null>(null)
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as Element).closest('[data-diagram-popover], [data-diagram-controls]')) return
    drag.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false, node: (e.target as Element).closest('g.node') }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true
    if (d.moved) setView(v => ({ ...v, x: d.vx + dx, y: d.vy + dy }))
  }
  const onPointerUp = () => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved) return
    // A click, not a drag: open the clicked node's details, or close them.
    const node = d.node
    const id = node ? mermaidNodeId(node) : null
    const info = id ? meta?.nodes?.[id] : undefined
    if (!node || !id || !info) { setPopover(null); return }
    const vp = viewportRef.current!.getBoundingClientRect()
    const box = node.getBoundingClientRect()
    // Below the node, kept inside the view (the popover is at most 420 px wide).
    const width = Math.min(420, vp.width * 0.8)
    const x = Math.min(Math.max(8, box.left - vp.left), vp.width - width - 8)
    const below = box.bottom - vp.top + 8
    const y = below + 200 > vp.height ? Math.max(8, box.top - vp.top - 208) : below
    setPopover({ id, label: node.textContent.trim() || id, info, x, y })
  }

  const zoomBy = (factor: number) => {
    const vp = viewportRef.current
    if (!vp) return
    const cx = vp.clientWidth / 2
    const cy = vp.clientHeight / 2
    setView(v => {
      const scale = Math.min(MAX, Math.max(MIN, v.scale * factor))
      const k = scale / v.scale
      return { scale, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k }
    })
  }

  if (state.status === 'error') {
    return (
      <div className="mx-auto mt-10 w-full max-w-[680px] px-8">
        <div className="flex items-start gap-2.5 rounded-control border border-error-8 bg-error-11 px-4 py-3 text-body text-error-5" role="alert">
          <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
          <div><div className="font-bold">This diagram couldn't be rendered</div><div className="whitespace-pre-wrap font-mono text-meta">{state.message}</div></div>
        </div>
        <pre className="mt-4 whitespace-pre-wrap break-words rounded-control border border-edge bg-surface px-4 py-3 font-mono text-meta text-ink">{source}</pre>
      </div>
    )
  }

  /** What the agent receives for a node: its label, file and description. */
  const nodeExcerpt = (p: NonNullable<typeof popover>) => [
    `Diagram node "${p.label}" (id ${p.id})`,
    p.info.file ? `File: ${p.info.file}${p.info.line ? `:${p.info.line}` : ''}` : '',
    p.info.description ?? '',
  ].filter(Boolean).join('\n')

  return (
    <div
      ref={viewportRef}
      className="relative min-h-0 flex-1 cursor-grab touch-none overflow-hidden select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        ref={hostRef}
        className="absolute left-0 top-0 origin-top-left"
        style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}
      />
      {state.status === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-meta text-ink-muted" role="status">
          <IconLoader2 size={18} className="animate-spin" /> Rendering diagram…
        </div>
      )}
      {popover && (
        <div
          data-diagram-popover
          className="absolute z-20 w-[min(420px,80%)] rounded-floating border border-edge-strong bg-surface-raised p-4 shadow-floating"
          style={{ left: popover.x, top: popover.y }}
          role="dialog"
          aria-label={popover.label}
        >
          <div className="text-body font-bold text-ink">{popover.label}</div>
          {popover.info.file && <div className="mt-1 break-all font-mono text-meta text-primary-5">{popover.info.file}{popover.info.line ? `:${popover.info.line}` : ''}</div>}
          {popover.info.description && <p className="mt-2 text-body text-ink-muted">{popover.info.description}</p>}
          <div className="mt-3 flex gap-2">
            <button
              type="button"
              onClick={() => { onAttachNode(popover.label, nodeExcerpt(popover), true); setPopover(null) }}
              className="rounded-control bg-primary-fill px-3 py-1.5 text-meta font-medium text-on-primary-fill hover:opacity-90"
            >
              Ask about this
            </button>
            <button
              type="button"
              onClick={() => { onAttachNode(popover.label, nodeExcerpt(popover), false); setPopover(null) }}
              className="rounded-control border border-edge-strong bg-page px-3 py-1.5 text-meta text-ink hover:border-focus"
            >
              Add to prompt
            </button>
            {popover.info.file && canvasKindForPath(popover.info.file) && (
              <button
                type="button"
                onClick={() => { onOpenFile(popover.info.file!); setPopover(null) }}
                className="rounded-control border border-edge-strong bg-page px-3 py-1.5 text-meta text-ink hover:border-focus"
              >
                Open file
              </button>
            )}
          </div>
        </div>
      )}
      <div className="absolute bottom-3 left-4 text-meta text-ink-faint">Drag to pan · scroll to zoom{meta?.nodes ? ' · click a box for its file' : ''}</div>
      <div data-diagram-controls className="absolute bottom-3 right-3 flex items-center gap-1 rounded-control border border-edge bg-surface p-1">
        <button type="button" onClick={() => { zoomBy(1 / 1.25) }} className="inline-flex h-7 w-7 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink" aria-label="Zoom out"><IconMinus size={15} /></button>
        <span className="w-12 text-center text-meta tabular-nums text-ink">{Math.round(view.scale * 100)}%</span>
        <button type="button" onClick={() => { zoomBy(1.25) }} className="inline-flex h-7 w-7 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink" aria-label="Zoom in"><IconPlus size={15} /></button>
        <button type="button" onClick={fit} className="inline-flex h-7 w-7 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink" aria-label="Fit to view" title="Fit to view"><IconMaximize size={15} /></button>
      </div>
    </div>
  )
}
