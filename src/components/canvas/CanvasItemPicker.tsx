/**
 * The item picker in the Canvas header: the open item's title and position,
 * opening a list of the session's items. (The grouped, filterable switcher
 * for many items comes with slice 3.)
 */

import { useEffect, useRef, useState } from 'react'
import { IconChevronDown, IconPinFilled } from '@tabler/icons-react'
import type { CanvasItem } from '../../types'
import { relativeTime, sourceLabel } from '../../lib/canvas'
import { KindIcon } from './kindIcon'

interface Props {
  items: CanvasItem[]
  selected: CanvasItem
  onSelect: (itemId: string) => void
  /** Phone: centred title, no border. */
  compact?: boolean
}

export function CanvasItemPicker({ items, selected, onSelect, compact }: Props) {
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const index = items.findIndex(i => i.id === selected.id)
  const single = items.length < 2

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])

  const title = (
    <>
      {!compact && <KindIcon kind={selected.kind} />}
      <span className="truncate font-bold text-ink">{selected.title}</span>
      {!single && <span className="shrink-0 tabular-nums text-ink-muted">{compact ? `${index + 1}/${items.length}` : `${index + 1} of ${items.length}`}</span>}
    </>
  )

  if (single) {
    return <div className="flex min-w-0 items-center gap-2 text-meta">{title}</div>
  }

  return (
    <div ref={rootRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => { setOpen(o => !o) }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch item (⌥⌘[ / ⌥⌘])"
        className={`flex min-w-0 max-w-full items-center gap-2 rounded-control px-2.5 py-1 text-meta transition-colors ${
          compact ? 'hover:bg-surface-raised' : `border bg-page hover:border-edge-strong ${open ? 'border-focus' : 'border-edge'}`
        }`}
      >
        {title}
        <IconChevronDown size={14} className="shrink-0 text-ink-muted" />
      </button>
      {open && (
        <ul
          role="listbox"
          aria-label="Canvas items"
          className="absolute left-0 top-full z-30 mt-1 max-h-[70vh] w-[min(460px,90vw)] overflow-y-auto rounded-floating border border-edge-strong bg-surface-raised p-1 shadow-floating"
        >
          {items.map(item => (
            <li key={item.id} role="option" aria-selected={item.id === selected.id}>
              <button
                type="button"
                onClick={() => { onSelect(item.id); setOpen(false) }}
                className={`density-row flex w-full items-center gap-2 rounded-control px-2.5 text-left text-meta ${
                  item.id === selected.id ? 'bg-primary-11 text-ink' : 'text-ink hover:bg-surface'
                }`}
              >
                <KindIcon kind={item.kind} />
                <span className="min-w-0 flex-1 truncate font-medium">{item.title}</span>
                {item.pinnedRevision !== undefined && <IconPinFilled size={13} className="shrink-0 text-accent-5" aria-label="Pinned" />}
                <span className="shrink-0 text-ink-faint">{sourceLabel(item)} · {relativeTime(item.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
