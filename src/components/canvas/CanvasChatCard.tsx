/**
 * The one-row chat card for a Canvas item created or revised in this session
 * (design handoff C3). It opens the item, is outlined while that item is
 * showing in Canvas, says when a pinned item has moved on, and turns into a
 * quiet "deleted" row once the item is gone.
 */

import { IconChevronRight, IconPin, IconTrash } from '@tabler/icons-react'
import type { CanvasItem, ChatMessage } from '../../types'
import { KindIcon } from './kindIcon'

export interface CanvasCardContext {
  /** The session's items; null until the list has loaded (no "deleted" state before then). */
  items: CanvasItem[] | null
  /** The item showing in an open Canvas, if any. */
  openItemId: string | null
  onOpen: (itemId: string) => void
}

type CardMsg = Extract<ChatMessage, { type: 'canvas_card' }>

export function CanvasChatCard({ msg, ctx }: { msg: CardMsg; ctx: CanvasCardContext }) {
  const item = ctx.items?.find(i => i.id === msg.itemId)
  const base = 'flex min-h-[var(--row-h,36px)] w-full max-w-[560px] items-center gap-2.5 rounded-control border px-3 py-1.5 text-left text-meta'

  if (ctx.items && !item) {
    return (
      <div className={`${base} border-dashed border-edge text-ink-faint`}>
        <IconTrash size={16} stroke={1.75} className="shrink-0" aria-hidden />
        <span className="truncate">{msg.title} · deleted</span>
      </div>
    )
  }

  const isOpen = ctx.openItemId === msg.itemId
  const title = item?.title ?? msg.title
  const pinnedBehind = item?.pinnedRevision !== undefined && item.latest > item.pinnedRevision
  const detail = isOpen
    ? 'open'
    : pinnedBehind
      ? `rev ${item.latest} · you're on rev ${item.pinnedRevision}`
      : msg.action === 'created' ? 'new' : `updated · rev ${msg.revision}`

  return (
    <button
      type="button"
      onClick={() => { ctx.onOpen(msg.itemId) }}
      aria-label={`${isOpen ? 'Showing' : 'Open'} ${title} in Canvas`}
      className={`${base} transition-colors ${
        isOpen ? 'border-primary-5 bg-primary-11 text-ink' : 'border-edge bg-surface text-ink hover:border-edge-strong'
      }`}
    >
      <KindIcon kind={msg.kind} />
      <span className="min-w-0 truncate font-bold">{title}</span>
      <span className="min-w-0 flex-1 truncate text-ink-muted">{detail}</span>
      {pinnedBehind
        ? <IconPin size={15} className="shrink-0 text-accent-5" aria-label="Pinned" />
        : !isOpen && <IconChevronRight size={15} className="shrink-0 text-ink-muted" aria-hidden />}
    </button>
  )
}
