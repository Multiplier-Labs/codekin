/**
 * The Canvas panel (docs/CANVAS-SPEC.md §4): a header with the item picker
 * and the shown revision, over the item itself. Beside the chat it takes the
 * rest of the window; below the side-by-side width it replaces the chat, with
 * a way back and, on wider-than-phone windows, the agent's latest line.
 */

import { useEffect, useRef, useState } from 'react'
import { IconChevronLeft, IconCopy, IconGitCompare, IconHierarchy2, IconMessage, IconMessageQuestion, IconTable, IconX } from '@tabler/icons-react'
import type { CanvasApi } from '../../hooks/useCanvas'
import { CanvasItemPicker } from './CanvasItemPicker'
import { CanvasItemView } from './CanvasItemView'
import { CanvasHeaderActions, RevisionPicker } from './CanvasHeaderActions'
import { CompareView } from './CompareView'
import { RevisionBar } from './RevisionBar'
import { makeAttachment, textLabel, type CanvasAttachment, type CanvasSelectionKind } from '../../lib/canvasContext'

/** Below this Canvas width, view source and copy fold into the ⋯ menu. */
const NARROW = 520
/** From this Canvas width, Markdown items show a table of contents. */
const TOC_FROM = 860

interface Props {
  canvas: CanvasApi
  /** Canvas replaces the chat (narrow window or phone) instead of sitting beside it. */
  replacesChat: boolean
  isMobile: boolean
  onBackToChat: () => void
  /** The agent's latest line, shown under a chat-replacing Canvas on wider windows. */
  lastAgentLine?: string
  /** Put a prompt in the composer for the user to edit and send. */
  onSuggest: (text: string) => void
  /** Pointer down anywhere in Canvas (closes a Changes slide-over). */
  onPointerDown?: () => void
  /** Attach a selection to the next message; `ask` also brings the composer up. */
  onAttach?: (attachment: CanvasAttachment, ask: boolean) => void
}

const SUGGESTIONS = [
  { Icon: IconHierarchy2, className: 'text-warning-5', text: 'Show the architecture of this repo as a diagram' },
  { Icon: IconTable, className: 'text-secondary-5', text: 'Put the failing tests in a table' },
]

export function CanvasPanel({ canvas, replacesChat, isMobile, onBackToChat, lastAgentLine, onSuggest, onPointerDown, onAttach }: Props) {
  const { items, selected, view, compare } = canvas
  const mainRef = useRef<HTMLElement>(null)
  const [width, setWidth] = useState(1000)
  const [sourceMode, setSourceMode] = useState(false)
  const viewKey = view.state === 'empty' ? '' : `${view.item.id}@${view.revision}`

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => { setWidth(entry.contentRect.width) })
    observer.observe(el)
    return () => { observer.disconnect() }
  }, [])

  // A different item or revision starts rendered, at the top, not reading.
  useEffect(() => {
    setSourceMode(false) // eslint-disable-line react-hooks/set-state-in-effect -- reset per revision
    canvas.setReading(false)
  }, [viewKey, canvas.setReading]) // eslint-disable-line react-hooks/exhaustive-deps -- setReading is stable

  // Reading: scrolled into the item, or text selected in it.
  const scrolled = useRef(false)
  const scrollRef = useRef<HTMLDivElement>(null)
  const itemId = selected?.id
  // Another item starts at the top.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 })
    scrolled.current = false
  }, [itemId])
  useEffect(() => {
    const onSelection = () => {
      const sel = document.getSelection()
      const inside = !!sel && !sel.isCollapsed && !!mainRef.current?.contains(sel.anchorNode)
      canvas.setReading(scrolled.current || inside)
    }
    document.addEventListener('selectionchange', onSelection)
    return () => { document.removeEventListener('selectionchange', onSelection) }
  }, [canvas.setReading]) // eslint-disable-line react-hooks/exhaustive-deps -- setReading is stable

  // Selected text in the item: a floating toolbar to ask about it or add it to the prompt.
  const [selection, setSelection] = useState<{ text: string; x: number; y: number } | null>(null)
  useEffect(() => {
    const onSelection = () => {
      const sel = document.getSelection()
      const body = scrollRef.current
      if (!sel || sel.isCollapsed || !body || !sel.anchorNode || !body.contains(sel.anchorNode) || !onAttach) { setSelection(null); return }
      // Tables and diagrams have their own selection.
      if ((sel.anchorNode.parentElement ?? null)?.closest('table, svg, [data-diagram-popover]')) { setSelection(null); return }
      const text = sel.toString().trim()
      if (text.length < 2) { setSelection(null); return }
      const rect = sel.getRangeAt(0).getBoundingClientRect()
      const host = mainRef.current!.getBoundingClientRect()
      setSelection({ text, x: rect.left + rect.width / 2 - host.left, y: rect.top - host.top })
    }
    document.addEventListener('selectionchange', onSelection)
    return () => { document.removeEventListener('selectionchange', onSelection) }
  }, [onAttach])

  const attach = (what: CanvasSelectionKind, excerpt: string, label: string, ask: boolean) => {
    if (!onAttach || view.state === 'empty') return
    onAttach(makeAttachment({ itemId: view.item.id, itemTitle: view.item.title, revision: view.revision, what, excerpt, label }), ask)
  }
  const attachSelection = (ask: boolean) => {
    if (!selection) return
    attach('text', selection.text, textLabel(selection.text), ask)
    document.getSelection()?.removeAllRanges()
    setSelection(null)
  }

  const narrow = width < NARROW
  const revisionPicker = selected && view.state !== 'empty'
    ? <RevisionPicker item={selected} revision={view.revision} onShow={canvas.showRevision} />
    : null
  const actions = selected && view.state !== 'empty' && (
    <CanvasHeaderActions
      item={selected}
      revision={view.revision}
      narrow={narrow}
      sourceMode={sourceMode}
      onToggleSource={() => { setSourceMode(m => !m) }}
      copyText={view.state === 'ready' && selected.kind !== 'image' ? view.content.content : undefined}
      onPin={canvas.pin}
      onCompare={view.revision < selected.latest
        ? () => { canvas.setCompare({ from: view.revision, to: selected.latest }) }
        : view.revision > 1 && selected.revisions.some(r => r.n === view.revision - 1)
          ? () => { canvas.setCompare({ from: view.revision - 1, to: view.revision }) }
          : undefined}
      onDelete={() => { canvas.remove(selected.id) }}
    />
  )

  const back = replacesChat && (
    <button
      type="button"
      onClick={onBackToChat}
      className="flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-body font-medium text-primary-5 hover:bg-surface-raised"
    >
      <IconChevronLeft size={18} />
      Chat
    </button>
  )
  const close = !isMobile && (
    <button
      type="button"
      onClick={() => { canvas.setOpen(false) }}
      className="density-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink"
      title="Close Canvas (⌘\)"
      aria-label="Close Canvas"
    >
      <IconX size={18} />
    </button>
  )

  return (
    <main
      ref={mainRef}
      aria-label="Canvas"
      className="canvas-panel relative flex min-h-0 min-w-0 flex-1 flex-col bg-page"
      onPointerDown={onPointerDown}
    >
      {isMobile ? (
        <>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2">
            {back}
            <div className="flex min-w-0 flex-1 justify-center">
              {selected ? <CanvasItemPicker items={items} selected={selected} onSelect={canvas.select} compact /> : <span className="text-meta text-ink-muted">Canvas</span>}
            </div>
            <span className="flex w-16 shrink-0 justify-end">{actions}</span>
          </header>
          {revisionPicker && <div className="shrink-0 border-b border-edge px-2 py-0.5">{revisionPicker}</div>}
        </>
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-edge bg-surface px-3">
          {back}
          {back && <span className="h-5 w-px shrink-0 bg-edge" />}
          <span className="shrink-0 text-micro font-bold uppercase tracking-wide text-ink-muted">Canvas</span>
          {selected
            ? <CanvasItemPicker items={items} selected={selected} onSelect={canvas.select} />
            : <span className="text-meta text-ink-muted">No items</span>}
          {revisionPicker}
          <span className="flex-1" />
          {actions}
          {close}
        </header>
      )}

      {canvas.notice && (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-error-11 px-4 py-2 text-meta text-error-5" role="alert">
          <span className="min-w-0 flex-1">{canvas.notice}</span>
          <button type="button" onClick={canvas.dismissNotice} className="shrink-0 rounded-control p-1 hover:bg-error-10" aria-label="Dismiss">
            <IconX size={14} />
          </button>
        </div>
      )}

      {selected && view.state !== 'empty' && (compare ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 py-1.5 text-meta text-ink-muted" role="status">
          <IconGitCompare size={15} className="shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 truncate">Comparing rev {compare.from} with rev {compare.to}{sourceMode ? ' (source)' : ''}</span>
          <button type="button" onClick={() => { canvas.setCompare(null) }} className="shrink-0 font-medium text-primary-5 underline-offset-2 hover:underline">Done</button>
        </div>
      ) : (
        <RevisionBar
          item={selected}
          revision={view.revision}
          onShowLatest={() => { canvas.showRevision(selected.latest === (selected.pinnedRevision ?? selected.latest) ? null : selected.latest) }}
          onCompare={() => { canvas.setCompare({ from: view.revision, to: selected.latest }) }}
        />
      ))}

      <div
        ref={scrollRef}
        className="chat-scroll flex min-h-0 flex-1 flex-col overflow-y-auto"
        onScroll={(e) => {
          const now = e.currentTarget.scrollTop > 40
          if (now !== scrolled.current) { scrolled.current = now; canvas.setReading(now) }
        }}
      >
        {view.state === 'empty'
          ? <CanvasEmpty onSuggest={onSuggest} />
          : compare && selected
            ? <CompareView item={selected} from={compare.from} to={compare.to} a={canvas.revisionContent(compare.from)} b={canvas.revisionContent(compare.to)} source={sourceMode} />
            : sourceMode && view.state === 'ready'
              ? <pre className="px-8 py-6 font-mono text-meta text-ink whitespace-pre-wrap break-words">{view.content.content}</pre>
              : <CanvasItemView key={viewKey} view={view} onAttach={attach} onOpenFile={canvas.openFile} toc={width >= TOC_FROM} />}
      </div>

      {selection && !compare && (isMobile ? (
        <div className="absolute inset-x-3 bottom-3 z-30 flex gap-2 rounded-floating border border-edge-strong bg-surface-raised p-2 shadow-floating" role="toolbar" aria-label="Selection">
          <button type="button" onMouseDown={e => { e.preventDefault() }} onClick={() => { attachSelection(true) }}
            className="flex h-12 flex-1 items-center justify-center gap-2 rounded-control bg-primary-fill text-body font-medium text-on-primary-fill">
            <IconMessageQuestion size={18} aria-hidden /> Ask about this
          </button>
          <button type="button" onMouseDown={e => { e.preventDefault() }} onClick={() => { attachSelection(false) }}
            className="h-12 rounded-control border border-edge-strong bg-page px-4 text-body text-ink">Add</button>
          <button type="button" onMouseDown={e => { e.preventDefault() }} onClick={() => { document.getSelection()?.removeAllRanges(); setSelection(null) }}
            className="flex h-12 w-12 items-center justify-center text-ink-muted" aria-label="Dismiss"><IconX size={18} /></button>
        </div>
      ) : (
        <div
          className="absolute z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-floating border border-edge-strong bg-surface-raised p-1 shadow-floating"
          style={{ left: Math.min(Math.max(150, selection.x), width - 150), top: selection.y < 52 ? selection.y + 28 : selection.y - 44 }}
          role="toolbar"
          aria-label="Selection"
        >
          <button type="button" onMouseDown={e => { e.preventDefault() }} onClick={() => { attachSelection(true) }}
            className="flex h-[30px] items-center gap-1.5 rounded-control bg-primary-fill px-2.5 text-meta font-medium text-on-primary-fill hover:opacity-90">
            <IconMessageQuestion size={15} aria-hidden /> Ask about this
          </button>
          <button type="button" onMouseDown={e => { e.preventDefault() }} onClick={() => { attachSelection(false) }}
            className="h-[30px] rounded-control px-2.5 text-meta text-ink hover:bg-surface">Add to prompt</button>
          <button type="button" onMouseDown={e => { e.preventDefault() }} onClick={() => { void navigator.clipboard.writeText(selection.text) }}
            className="flex h-[30px] w-[30px] items-center justify-center rounded-control text-ink-muted hover:bg-surface hover:text-ink" aria-label="Copy" title="Copy">
            <IconCopy size={15} />
          </button>
        </div>
      ))}

      {replacesChat && !isMobile && lastAgentLine && (
        <div className="flex shrink-0 items-center gap-2.5 border-t border-edge bg-surface px-4 py-2.5 text-meta text-ink-muted">
          <IconMessage size={16} className="shrink-0" />
          <span className="min-w-0 flex-1 truncate">Agent: {lastAgentLine}</span>
          <button type="button" onClick={onBackToChat} className="shrink-0 font-medium text-primary-5 underline-offset-2 hover:underline">
            Open chat
          </button>
        </div>
      )}
    </main>
  )
}

function CanvasEmpty({ onSuggest }: { onSuggest: (text: string) => void }) {
  return (
    <div className="m-auto w-full max-w-[620px] px-8 py-10">
      <h2 className="text-head font-bold text-ink">Nothing in Canvas yet</h2>
      <p className="mt-1 text-body text-ink-muted">Reports, tables and diagrams open here, beside the chat.</p>
      <h3 className="mt-6 mb-2 text-micro font-bold uppercase tracking-wide text-ink-muted">Ask the agent</h3>
      <div className="flex flex-col gap-2">
        {SUGGESTIONS.map(({ Icon, className, text }) => (
          <button
            key={text}
            type="button"
            onClick={() => { onSuggest(text) }}
            className="flex items-center gap-3 rounded-control border border-edge bg-page px-4 py-2.5 text-left text-body text-ink transition-colors hover:border-edge-strong hover:bg-surface"
          >
            <Icon size={18} stroke={1.75} className={`shrink-0 ${className}`} />
            “{text}”
          </button>
        ))}
      </div>
      <p className="mt-2 text-meta text-ink-faint">Puts the prompt in the composer for you to edit and send.</p>
      <h3 className="mt-6 mb-2 text-micro font-bold uppercase tracking-wide text-ink-muted">Or open one yourself</h3>
      <p className="text-body text-ink-muted">
        Use <span className="font-medium text-ink">Open in Canvas</span> on a Markdown file, table, diagram or image in Changes or Docs.
      </p>
    </div>
  )
}
