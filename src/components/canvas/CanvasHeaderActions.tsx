/**
 * Canvas header controls for the selected item (design handoff C2): the
 * revision picker ("rev 3 of 4 · by agent · 6 min ago"), pin, view source,
 * copy, download and a ⋯ menu with compare and delete. Below 520 px of Canvas
 * width, view source, copy and download fold into the ⋯ menu.
 */

import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { IconAlertTriangle, IconCheck, IconChevronDown, IconCode, IconCopy, IconDots, IconDownload, IconGitCompare, IconPin, IconPinFilled, IconTrash } from '@tabler/icons-react'
import type { CanvasItem } from '../../types'
import { relativeTime, sourceLabel } from '../../lib/canvas'
import type { ExportFormat } from '../../lib/canvasExport'
import { saveFile } from '../../lib/download'
import { isDesktopWebView } from '../../lib/desktopLinks'

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
  /** Ways to download the shown revision, the stored format first; empty when there is nothing to save. */
  downloads?: ExportFormat[]
  onPin: (revision: number | null) => void
  onCompare: (() => void) | undefined
  onDelete: () => void
}

/** Download one format, then show a check (or why it failed) on the button for a moment. */
function useDownload() {
  const [status, setStatus] = useState<{ ok: true } | { ok: false; message: string } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => { clearTimeout(timer.current) }, [])
  const run = (format: ExportFormat) => {
    const settle = (next: NonNullable<typeof status>) => {
      setStatus(next)
      clearTimeout(timer.current)
      timer.current = setTimeout(() => { setStatus(null) }, next.ok ? 1500 : 4000)
    }
    format.build().then(
      file => { saveFile(file.data, file.filename, file.mediaType); settle({ ok: true }) },
      (err: unknown) => { settle({ ok: false, message: err instanceof Error ? err.message : String(err) }) },
    )
  }
  return { status, run }
}

const DOWNLOADED = isDesktopWebView() ? 'Saved to your Downloads folder' : 'Downloaded'

export function CanvasHeaderActions({ item, revision, narrow, sourceMode, onToggleSource, copyText, downloads = [], onPin, onCompare, onDelete }: ActionsProps) {
  const { open: menuOpen, setOpen: setMenuOpen, ref: menuRef } = usePopover()
  const { open: saveOpen, setOpen: setSaveOpen, ref: saveRef } = usePopover()
  const download = useDownload()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [copied, setCopied] = useState(false)
  const pinned = item.pinnedRevision !== undefined
  // A live preview has no source to show, and pinning it would mean nothing.
  const live = item.kind === 'preview'
  const canSource = item.kind !== 'image' && !live

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
      {!live && <button type="button" onClick={() => { onPin(pinned ? null : revision) }} aria-pressed={pinned}
        className={`${ICON_BTN} ${pinned ? 'text-accent-5 hover:text-accent-5' : ''}`}
        title={pinned ? `Pinned at rev ${item.pinnedRevision}: new revisions wait. Click to unpin.` : `Pin at rev ${revision} so new revisions wait`}
        aria-label={pinned ? 'Unpin' : 'Pin'}>
        {pinned ? <IconPinFilled size={17} /> : <IconPin size={17} />}
      </button>}
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
      {!narrow && downloads.length > 0 && (
        <div ref={saveRef} className="relative">
          <button type="button"
            onClick={() => { if (downloads.length === 1) download.run(downloads[0]); else setSaveOpen(o => !o) }}
            {...(downloads.length > 1 ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': saveOpen } : {})}
            className={ICON_BTN} aria-label="Download"
            title={download.status ? (download.status.ok ? DOWNLOADED : `Couldn't download: ${download.status.message}`)
              : downloads.length === 1 ? `Download (.${downloads[0].ext})` : 'Download'}>
            {download.status?.ok ? <IconCheck size={17} className="text-success-5" />
              : download.status ? <IconAlertTriangle size={17} className="text-error-5" />
                : <IconDownload size={17} />}
          </button>
          {saveOpen && (
            <div role="menu" aria-label="Download as" className={`${MENU} right-0 w-56`}>
              <div className="px-2.5 pb-1 pt-1.5 text-micro font-bold uppercase tracking-wide text-ink-muted">Download as</div>
              {downloads.map(f => (
                <button key={f.id} type="button" role="menuitem" onClick={() => { download.run(f); setSaveOpen(false) }} className={MENU_ROW}>
                  <span className="min-w-0 flex-1 truncate">{f.label}</span>
                  <span className="shrink-0 font-mono text-micro text-ink-faint">.{f.ext}</span>
                </button>
              ))}
            </div>
          )}
        </div>
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
            {narrow && downloads.map(f => (
              <Fragment key={`download-${f.id}`}>{row(<IconDownload size={16} />, downloads.length === 1 ? `Download (.${f.ext})` : `Download as ${f.label}`, () => { download.run(f) })}</Fragment>
            ))}
            {narrow && download.status && !download.status.ok && (
              <p className="px-2.5 py-1.5 text-meta text-error-5" role="alert">Couldn't download: {download.status.message}</p>
            )}
            {onCompare && row(<IconGitCompare size={16} />, revision < item.latest ? `Compare rev ${revision} with rev ${item.latest}` : `Compare with rev ${revision - 1}`, onCompare)}
            {confirmDelete ? (
              <div className="px-2.5 py-2 text-meta">
                <p className="text-ink">{live
                  ? `Remove the preview “${item.title}”? A server Codekin started for it stops.`
                  : `Delete “${item.title}” and its ${item.revisions.length} revision${item.revisions.length === 1 ? '' : 's'}?`}</p>
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
