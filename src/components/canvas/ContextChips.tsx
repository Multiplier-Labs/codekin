/**
 * Canvas context chips (design handoff C4): one style in the composer and on
 * sent messages. In the composer, more than two fold into a summary chip
 * that expands upward into a list; a sent chip reopens its item at the
 * revision it came from.
 */

import { useState } from 'react'
import { IconChevronUp, IconHierarchy2, IconQuote, IconTable, IconX } from '@tabler/icons-react'
import type { CanvasAttachment, CanvasSelectionKind, SentContext } from '../../lib/canvasContext'

const CHIP = 'flex min-w-0 max-w-full items-center gap-1.5 rounded-control border border-edge bg-page px-2 py-0.5 text-meta text-ink'

function WhatIcon({ what }: { what: CanvasSelectionKind }) {
  const Icon = what === 'rows' ? IconTable : what === 'node' ? IconHierarchy2 : IconQuote
  const tone = what === 'rows' ? 'text-secondary-5' : what === 'node' ? 'text-warning-5' : 'text-primary-5'
  return <Icon size={14} stroke={1.75} className={`shrink-0 ${tone}`} aria-hidden />
}

const WHAT_NAME: Record<CanvasSelectionKind, string> = { text: 'quote', rows: 'rows', node: 'node' }

export function ComposerContextChips({ attachments, onRemove }: { attachments: CanvasAttachment[]; onRemove: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  if (attachments.length === 0) return null

  if (attachments.length <= 2) {
    return (
      <div className="flex flex-wrap gap-1.5" aria-label="Canvas context">
        {attachments.map(a => (
          <span key={a.id} className={CHIP} title={`${a.itemTitle}, rev ${a.revision}`}>
            <WhatIcon what={a.what} />
            <span className="truncate">{a.label}</span>
            <span className="shrink-0 text-ink-faint">· {a.itemTitle}</span>
            <button type="button" onClick={() => { onRemove(a.id) }} className="shrink-0 rounded-control p-0.5 text-ink-muted hover:text-ink" aria-label={`Remove ${a.label}`}>
              <IconX size={12} stroke={2} />
            </button>
          </span>
        ))}
      </div>
    )
  }

  const kinds = [...new Set(attachments.map(a => WHAT_NAME[a.what]))].join(', ')
  return (
    <div className="relative" aria-label="Canvas context">
      {open && (
        <ul className="absolute bottom-full left-0 z-20 mb-1 w-[min(420px,85vw)] rounded-floating border border-edge-strong bg-surface-raised p-1 shadow-floating">
          {attachments.map(a => (
            <li key={a.id} className="density-row flex items-center gap-2 rounded-control px-2 text-meta">
              <WhatIcon what={a.what} />
              <span className="min-w-0 flex-1 truncate text-ink">{a.label}</span>
              <span className="shrink-0 truncate text-ink-faint">{a.itemTitle} · rev {a.revision}</span>
              <button type="button" onClick={() => { onRemove(a.id) }} className="shrink-0 rounded-control p-0.5 text-ink-muted hover:text-ink" aria-label={`Remove ${a.label}`}>
                <IconX size={12} stroke={2} />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button type="button" onClick={() => { setOpen(o => !o) }} aria-expanded={open} className={CHIP}>
        {[...new Set(attachments.map(a => a.what))].map(w => <WhatIcon key={w} what={w} />)}
        <span className="font-bold">{attachments.length} attached</span>
        <span className="truncate text-ink-muted">{kinds}</span>
        <IconChevronUp size={13} className={`shrink-0 text-ink-muted transition-transform ${open ? '' : 'rotate-180'}`} aria-hidden />
      </button>
    </div>
  )
}

export function SentContextChips({ context, onOpen }: { context: SentContext[]; onOpen?: (c: SentContext) => void }) {
  return (
    <div className="mt-1.5 flex flex-wrap justify-end gap-1.5">
      {context.map((c, i) => (
        <button
          key={i}
          type="button"
          disabled={!onOpen}
          onClick={() => { onOpen?.(c) }}
          className={`${CHIP} enabled:hover:border-edge-strong disabled:cursor-default`}
          title={`${c.itemTitle}, rev ${c.revision}${onOpen ? ' — open in Canvas' : ''}`}
        >
          <WhatIcon what={c.what} />
          <span className="truncate">{c.itemTitle} · {c.label}</span>
        </button>
      ))}
    </div>
  )
}
