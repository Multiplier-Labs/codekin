/**
 * The item switcher in the Canvas header (design handoff C1). One item is a
 * plain title; 2–5 open a flat list; 6 or more are grouped (Pinned, Agent,
 * You, then one group per MCP server) with a filter. Type to filter, ↑↓ to
 * move, ↩ to open, Esc to close.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { IconCheck, IconChevronDown, IconSearch } from '@tabler/icons-react'
import type { CanvasItem } from '../../types'
import { relativeTime } from '../../lib/canvas'
import { groupItems } from '../../lib/canvasItems'
import { KindIcon } from './kindIcon'

interface Props {
  items: CanvasItem[]
  selected: CanvasItem
  onSelect: (itemId: string) => void
  /** Phone: centred title, no border. */
  compact?: boolean
}

const GROUPED_FROM = 6

function pinnedBehind(item: CanvasItem): boolean {
  return item.pinnedRevision !== undefined && item.latest > item.pinnedRevision
}

function detail(item: CanvasItem): string {
  if (pinnedBehind(item)) return `rev ${item.pinnedRevision}, rev ${item.latest} waiting`
  if (item.source.type === 'file') return `opened ${relativeTime(item.createdAt)}`
  return `rev ${item.latest} · ${relativeTime(item.updatedAt)}`
}

export function CanvasItemPicker({ items, selected, onSelect, compact }: Props) {
  const [open, setOpen] = useState(false)
  const [filter, setFilter] = useState('')
  const [active, setActive] = useState(0)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const index = items.findIndex(i => i.id === selected.id)
  const single = items.length < 2
  const grouped = items.length >= GROUPED_FROM

  const sections = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const matching = needle ? items.filter(i => i.title.toLowerCase().includes(needle)) : items
    return grouped ? groupItems(matching) : [{ label: '', items: matching.slice().reverse() }]
  }, [items, filter, grouped])
  const flat = useMemo(() => sections.flatMap(s => s.items), [sections])

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!rootRef.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [open])

  // Keep the active row in view while moving with the keyboard.
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  const openList = () => {
    setFilter('')
    const order = grouped ? groupItems(items).flatMap(g => g.items) : items.slice().reverse()
    setActive(Math.max(0, order.findIndex(i => i.id === selected.id)))
    setOpen(true)
  }
  const choose = (item: CanvasItem | undefined) => {
    if (!item) return
    onSelect(item.id)
    setOpen(false)
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false) }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(a => Math.min(flat.length - 1, a + 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(a => Math.max(0, a - 1)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(flat[active]) }
  }

  const title = (
    <>
      {!compact && <KindIcon kind={selected.kind} />}
      <span className="truncate font-bold text-ink">{selected.title}</span>
      {items.some(pinnedBehind) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-5" aria-label="A pinned item has a newer revision" />}
      {!single && <span className="shrink-0 tabular-nums text-ink-muted">{compact ? `${index + 1}/${items.length}` : `${index + 1} of ${items.length}`}</span>}
    </>
  )

  if (single) return <div className="flex min-w-0 items-center gap-2 text-meta">{title}</div>

  let row = -1
  return (
    <div ref={rootRef} className="relative min-w-0" onKeyDown={open ? onKeyDown : undefined}>
      <button
        type="button"
        onClick={() => { if (open) setOpen(false); else openList() }}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Switch item (⌥⌘[ / ⌥⌘])"
        className={`flex min-w-0 max-w-full items-center gap-2 rounded-control px-2.5 py-1 text-meta transition-colors ${
          compact ? 'hover:bg-surface-raised' : `border bg-page hover:border-edge-strong ${open ? 'border-focus' : 'border-edge'}`
        }`}
      >
        {title}
        <IconChevronDown size={14} className={`shrink-0 text-ink-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-30 mt-1 flex max-h-[70vh] w-[min(460px,90vw)] flex-col rounded-floating border border-edge-strong bg-surface-raised shadow-floating">
          {grouped && (
            <label className="m-2 flex items-center gap-2 rounded-control border border-edge bg-page px-2.5 py-1.5 focus-within:border-focus">
              <IconSearch size={15} className="shrink-0 text-ink-muted" aria-hidden />
              <input
                autoFocus
                value={filter}
                onChange={e => { setFilter(e.target.value); setActive(0) }}
                placeholder={`Filter ${items.length} items`}
                aria-label="Filter items"
                className="min-w-0 flex-1 bg-transparent text-meta text-ink outline-none placeholder:text-ink-faint"
              />
            </label>
          )}
          <ul ref={listRef} role="listbox" aria-label="Canvas items" tabIndex={grouped ? -1 : 0} autoFocus={!grouped} className="min-h-0 flex-1 overflow-y-auto p-1 outline-none">
            {sections.map(section => (
              <li key={section.label || 'all'} role="presentation">
                {section.label && <div className="px-2.5 pb-1 pt-2 text-micro font-bold uppercase tracking-wide text-ink-muted">{section.label}</div>}
                <ul role="presentation">
                  {section.items.map(item => {
                    row++
                    const rowIndex = row
                    const isActive = rowIndex === active
                    return (
                      <li key={item.id} role="option" aria-selected={item.id === selected.id} data-active={isActive}>
                        <button
                          type="button"
                          onClick={() => { choose(item) }}
                          onMouseMove={() => { if (!isActive) setActive(rowIndex) }}
                          className={`density-row flex w-full items-center gap-2.5 rounded-control px-2.5 text-left text-meta ${isActive ? 'bg-primary-11' : ''}`}
                        >
                          <KindIcon kind={item.kind} />
                          <span className={`min-w-0 flex-1 truncate text-ink ${item.source.type === 'file' ? 'font-mono' : ''} ${item.id === selected.id ? 'font-bold' : ''}`}>{item.title}</span>
                          {pinnedBehind(item) && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-5" aria-hidden />}
                          <span className="shrink-0 text-ink-faint">{detail(item)}</span>
                          {item.id === selected.id && <IconCheck size={15} className="shrink-0 text-primary-5" aria-label="Showing" />}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              </li>
            ))}
            {flat.length === 0 && <li className="px-3 py-2 text-meta text-ink-muted">No items match.</li>}
          </ul>
          <div className="flex shrink-0 items-center gap-3 border-t border-edge px-3 py-2 text-micro text-ink-faint">
            <span>↑↓ move</span><span>↩ open</span><span>⌥⌘[ ] previous / next</span>
          </div>
        </div>
      )}
    </div>
  )
}
