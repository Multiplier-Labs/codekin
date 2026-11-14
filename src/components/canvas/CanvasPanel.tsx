/**
 * The Canvas panel (docs/CANVAS-SPEC.md §4): a header with the item picker
 * and the shown revision, over the item itself. Beside the chat it takes the
 * rest of the window; below the side-by-side width it replaces the chat, with
 * a way back and, on wider-than-phone windows, the agent's latest line.
 */

import { IconChevronLeft, IconHierarchy2, IconMessage, IconTable, IconX } from '@tabler/icons-react'
import type { CanvasApi } from '../../hooks/useCanvas'
import { relativeTime, sourceLabel } from '../../lib/canvas'
import { CanvasItemPicker } from './CanvasItemPicker'
import { CanvasItemView } from './CanvasItemView'

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
}

const SUGGESTIONS = [
  { Icon: IconHierarchy2, className: 'text-warning-5', text: 'Show the architecture of this repo as a diagram' },
  { Icon: IconTable, className: 'text-secondary-5', text: 'Put the failing tests in a table' },
]

export function CanvasPanel({ canvas, replacesChat, isMobile, onBackToChat, lastAgentLine, onSuggest, onPointerDown }: Props) {
  const { items, selected, view } = canvas
  const revisionMeta = selected && view.state !== 'empty'
    ? `${selected.pinnedRevision !== undefined ? `Pinned at rev ${view.revision}` : `rev ${view.revision}`} · ${relativeTime(selected.revisions.find(r => r.n === view.revision)?.createdAt ?? selected.updatedAt)}`
    : null

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
      aria-label="Canvas"
      className="canvas-panel flex min-h-0 min-w-0 flex-1 flex-col bg-page"
      onPointerDown={onPointerDown}
    >
      {isMobile ? (
        <>
          <header className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface px-2">
            {back}
            <div className="flex min-w-0 flex-1 justify-center">
              {selected ? <CanvasItemPicker items={items} selected={selected} onSelect={canvas.select} compact /> : <span className="text-meta text-ink-muted">Canvas</span>}
            </div>
            <span className="w-16 shrink-0" />
          </header>
          {revisionMeta && selected && (
            <div className="shrink-0 border-b border-edge px-4 py-1.5 text-meta text-ink-muted">{sourceLabel(selected)} · {revisionMeta}</div>
          )}
        </>
      ) : (
        <header className="flex h-12 shrink-0 items-center gap-3 border-b border-edge bg-surface px-3">
          {back}
          {back && <span className="h-5 w-px shrink-0 bg-edge" />}
          <span className="shrink-0 text-micro font-bold uppercase tracking-wide text-ink-muted">Canvas</span>
          {selected
            ? <CanvasItemPicker items={items} selected={selected} onSelect={canvas.select} />
            : <span className="text-meta text-ink-muted">No items</span>}
          {revisionMeta && selected && <span className="min-w-0 truncate text-meta text-ink-muted">{sourceLabel(selected)} · {revisionMeta}</span>}
          <span className="flex-1" />
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

      <div className="chat-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
        {view.state === 'empty'
          ? <CanvasEmpty onSuggest={onSuggest} />
          : <CanvasItemView key={`${view.item.id}@${view.revision}`} view={view} onAsk={onSuggest} onOpenFile={canvas.openFile} />}
      </div>

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
