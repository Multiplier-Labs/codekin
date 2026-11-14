/**
 * Canvas header controls for the selected item (design handoff C2): the
 * revision picker ("rev 3 of 4 · by agent · 6 min ago"), pin, view source,
 * copy and a ⋯ menu with compare and delete. Below 520 px of Canvas width,
 * view source and copy fold into the ⋯ menu.
 */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { IconCheck, IconChevronDown, IconCode, IconCopy, IconDots, IconGitCompare, IconPin, IconPinFilled, IconTrash } from '@tabler/icons-react'
import type { CanvasItem } from '../../types'
import { relativeTime, sourceLabel } from '../../lib/canvas'

const ICON_BTN = 'density-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink'
const MENU = 'absolute top-full z-30 mt-1 rounded-floating border border-edge-strong bg-surface-raised p-1 shadow-floating'
const MENU_ROW = 'density-row flex w-full items-center gap-2.5 rounded-control px-2.5 text-left text-meta text-ink hover:bg-surface'

function usePopover() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false) } }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  return { open, setOpen, ref }
}

/** "rev 3 of 4 · by agent · 6 min ago", opening the list of revisions. */
export function RevisionPicker({ item, revision, onShow }: { item: CanvasItem; revision: number; onShow: (n: number | null) => void }) {
  const { open, setOpen, ref } = usePopover()
  const current = item.revisions.find(r => r.n === revision)
  const label = `rev ${revision} of ${item.latest} · ${item.source.type === 'agent' ? 'by agent' : sourceLabel(item)} · ${relativeTime(current?.createdAt ?? item.updatedAt)}`
  if (item.revisions.length < 2) return <span className="min-w-0 truncate text-meta text-ink-muted">{label}</span>
  return (
    <div ref={ref} className="relative min-w-0">
      <button type="button" onClick={() => { setOpen(o => !o) }} aria-haspopup="menu" aria-expanded={open}
        className="flex min-w-0 items-center gap-1 rounded-control px-1.5 py-1 text-meta text-ink-muted hover:bg-surface-raised hover:text-ink">
        <span className="truncate">{label}</span>
        <IconChevronDown size={14} className="shrink-0" />
      </button>
      {open && (
        <div role="menu" aria-label="Revisions" className={`${MENU} left-0 max-h-[60vh] w-64 overflow-y-auto`}>
          {item.revisions.slice().reverse().map(r => (
            <button key={r.n} type="button" role="menuitemradio" aria-checked={r.n === revision}
              onClick={() => { onShow(r.n === (item.pinnedRevision ?? item.latest) ? null : r.n); setOpen(false) }}
              className={MENU_ROW}>
              <span className="w-12 shrink-0 font-bold tabular-nums">rev {r.n}</span>
              <span className="min-w-0 flex-1 truncate text-ink-muted">
                {relativeTime(r.createdAt)}{r.n === item.latest ? ' · latest' : ''}{r.n === item.pinnedRevision ? ' · pinned' : ''}
              </span>
              {r.n === revision && <IconCheck size={15} className="shrink-0 text-primary-5" aria-hidden />}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

interface ActionsProps {
  item: CanvasItem
  revision: number
  /** Narrow Canvas: fold view source and copy into the ⋯ menu. */
  narrow: boolean
  sourceMode: boolean
  onToggleSource: () => void
  /** Text of the shown revision, for Copy; undefined for images or while loading. */
  copyText?: string
  onPin: (revision: number | null) => void
  onCompare: (() => void) | undefined
  onDelete: () => void
}

export function CanvasHeaderActions({ item, revision, narrow, sourceMode, onToggleSource, copyText, onPin, onCompare, onDelete }: ActionsProps) {
  const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState(false)
  const pinned = item.pinnedRevision !== undefined
  const canSource = item.kind !== 'image'

  const copy = () => {
    if (copyText === undefined) return
    void navigator.clipboard.writeText(copyText).then(() => { setCopied(true); setTimeout(() => { setCopied(false) }, 1500) })
  }
  const row = (icon: ReactNode, label: string, onClick: () => void) => (
    <button type="button" role="menuitem" onClick={() => { onClick(); setMenuOpen(false) }} className={MENU_ROW}>
      {icon}{label}
    </button>
  )

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <button type="button" onClick={() => { onPin(pinned ? null : revision) }} aria-pressed={pinned}
        className={`${ICON_BTN} ${pinned ? 'text-accent-5 hover:text-accent-5' : ''}`}
        title={pinned ? `Pinned at rev ${item.pinnedRevision}: new revisions wait. Click to unpin.` : `Pin at rev ${revision} so new revisions wait`}
        aria-label={pinned ? 'Unpin' : 'Pin'}>
        {pinned ? <IconPinFilled size={17} /> : <IconPin size={17} />}
      </button>
      {!narrow && canSource && (
        <button type="button" onClick={onToggleSource} aria-pressed={sourceMode} className={`${ICON_BTN} ${sourceMode ? 'bg-primary-11 text-ink' : ''}`}
          title={sourceMode ? 'Show rendered' : 'View source'} aria-label={sourceMode ? 'Show rendered' : 'View source'}>
          <IconCode size={17} />
        </button>
      )}
      {!narrow && copyText !== undefined && (
        <button type="button" onClick={copy} className={ICON_BTN} title={copied ? 'Copied' : 'Copy'} aria-label="Copy">
          {copied ? <IconCheck size={17} className="text-success-5" /> : <IconCopy size={17} />}
        </button>
      )}
      <div ref={menuRef} className="relative">
        <button type="button" onClick={() => { setMenuOpen(o => !o); setConfirmDelete(false) }} aria-haspopup="menu" aria-expanded={menuOpen}
          className={ICON_BTN} title="More" aria-label="More actions">
          <IconDots size={17} />
        </button>
        {menuOpen && (
          <div role="menu" aria-label="Item actions" className={`${MENU} right-0 w-60`}>
            {narrow && canSource && row(<IconCode size={16} />, sourceMode ? 'Show rendered' : 'View source', onToggleSource)}
            {narrow && copyText !== undefined && row(<IconCopy size={16} />, 'Copy', copy)}
            {onCompare && row(<IconGitCompare size={16} />, revision < item.latest ? `Compare rev ${revision} with rev ${item.latest}` : `Compare with rev ${revision - 1}`, onCompare)}
            {confirmDelete ? (
              <div className="px-2.5 py-2 text-meta">
                <p className="text-ink">Delete “{item.title}” and its {item.revisions.length} revision{item.revisions.length === 1 ? '' : 's'}?</p>
                <div className="mt-2 flex gap-2">
                  <button type="button" onClick={() => { onDelete(); setMenuOpen(false) }} className="rounded-control bg-error-5 px-2.5 py-1 font-medium text-ink-inverse hover:opacity-90">Delete</button>
                  <button type="button" onClick={() => { setConfirmDelete(false) }} className="rounded-control px-2.5 py-1 text-ink-muted hover:text-ink">Cancel</button>
                </div>
              </div>
            ) : (
              <button type="button" role="menuitem" onClick={() => { setConfirmDelete(true) }} className={`${MENU_ROW} text-error-5 hover:bg-error-11`}>
                <IconTrash size={16} />Delete…
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
