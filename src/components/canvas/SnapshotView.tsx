/**
 * A preview snapshot (docs/CANVAS-SPEC.md §8, "Snapshots"): the screenshot
 * Codekin took in a browser on the machine, with where it was taken and the
 * console errors and warnings seen while the page loaded. Each snapshot of
 * a preview is a revision of one item, so Compare shows two side by side.
 */

import { useState } from 'react'
import { IconAlertTriangle, IconChevronDown, IconChevronRight, IconInfoCircle, IconSend } from '@tabler/icons-react'
import type { CanvasItem, SnapshotMeta } from '../../types'
import type { CanvasSelectionKind } from '../../lib/canvasContext'
import { consoleContext } from '../../lib/previewProtocol'
import { ZoomableImage } from './ZoomableImage'

interface Props {
  item: CanvasItem
  revision: number
  src: string
  meta: SnapshotMeta
  onAttach: (what: CanvasSelectionKind, excerpt: string, label: string, ask: boolean) => void
}

const VIEWPORT_LABEL: Record<SnapshotMeta['viewport'], string> = { full: '1280 px', tablet: 'Tablet, 820 px', phone: 'Phone, 390 px' }
/** Shown at the page's own CSS width (phone snapshots are taken at 2x). */
const VIEWPORT_WIDTH: Record<SnapshotMeta['viewport'], number> = { full: 1280, tablet: 820, phone: 390 }

export function SnapshotView({ item, revision, src, meta, onAttach }: Props) {
  const errors = meta.console.filter(e => e.level === 'error').length
  const warnings = meta.console.length - errors
  const [open, setOpen] = useState(errors > 0)
  const takenAt = item.revisions.find(r => r.n === revision)?.createdAt
  const when = takenAt ? new Date(takenAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-edge bg-surface px-3 py-1.5 text-meta text-ink-muted">
        <span className="min-w-0 truncate font-mono text-ink" title={`localhost:${meta.port}${meta.path}`}>localhost:{meta.port}{meta.path}</span>
        {meta.title && <span className="min-w-0 truncate">{meta.title}</span>}
        <span className="shrink-0">{VIEWPORT_LABEL[meta.viewport]}</span>
        {when && <span className="shrink-0">{when}</span>}
        <span className="flex-1" />
        <button type="button" onClick={() => { setOpen(o => !o) }} aria-expanded={open}
          className={`flex shrink-0 items-center gap-1 rounded-control px-1.5 py-0.5 hover:bg-surface-raised ${errors ? 'text-error-5' : warnings ? 'text-warning-5' : ''}`}>
          {open ? <IconChevronDown size={14} aria-hidden /> : <IconChevronRight size={14} aria-hidden />}
          <IconAlertTriangle size={14} aria-hidden />
          {meta.console.length ? `${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}` : 'No console errors'}
        </button>
      </div>
      {meta.restricted && (
        <div className="flex shrink-0 items-start gap-2 border-b border-edge bg-surface px-3 py-1.5 text-meta text-ink-muted" role="note">
          <IconInfoCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            Chrome's sandbox isn't available on that computer, so the page could load only from it
            {meta.blocked ? `: ${meta.blocked} request${meta.blocked === 1 ? '' : 's'} elsewhere (fonts, CDNs, APIs) were blocked` : ''}.
          </span>
        </div>
      )}
      {open && meta.console.length > 0 && (
        <div className="flex max-h-[38%] shrink-0 flex-col border-b border-edge bg-surface">
          <div className="flex shrink-0 justify-end px-2 pt-1">
            <button type="button" onClick={() => { const c = consoleContext(meta.console, meta.port); onAttach('console', c.excerpt, c.label, true) }}
              className="flex items-center gap-1 rounded-control px-2 py-1 text-meta text-primary-5 hover:bg-surface-raised">
              <IconSend size={14} /> Send {errors ? 'errors' : 'warnings'} to agent
            </button>
          </div>
          <ul className="min-h-0 flex-1 overflow-auto px-3 pb-2 font-mono text-micro">
            {meta.console.map((e, i) => (
              <li key={i} className={`border-b border-edge py-1 whitespace-pre-wrap break-words ${e.level === 'error' ? 'text-error-5' : 'text-warning-5'}`}>
                {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      <ZoomableImage src={src} alt={item.title} width={VIEWPORT_WIDTH[meta.viewport]} />
    </div>
  )
}
