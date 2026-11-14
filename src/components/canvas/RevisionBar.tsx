/**
 * The one-line bar under the Canvas header when the view is behind the
 * latest revision (design handoff C2 / C15·2): pinned at an older revision,
 * holding while the user reads, or browsing an older one. Never a toast.
 */

import { IconHistory, IconPin } from '@tabler/icons-react'
import type { CanvasItem } from '../../types'
import { relativeTime } from '../../lib/canvas'

interface Props {
  item: CanvasItem
  /** The revision being shown. */
  revision: number
  onShowLatest: () => void
  onCompare: () => void
}

export function RevisionBar({ item, revision, onShowLatest, onCompare }: Props) {
  if (revision >= item.latest) return null
  const latest = item.revisions.find(r => r.n === item.latest)
  const pinned = item.pinnedRevision === revision
  const link = 'font-medium text-primary-5 underline-offset-2 hover:underline'
  return (
    <div className="flex shrink-0 items-center gap-2 border-b border-edge bg-surface px-4 py-1.5 text-meta text-ink-muted" role="status">
      {pinned ? <IconPin size={15} className="shrink-0 text-accent-5" aria-hidden /> : <IconHistory size={15} className="shrink-0" aria-hidden />}
      <span className="min-w-0 truncate">
        {pinned ? `Pinned at rev ${revision}.` : `Showing rev ${revision}.`}{' '}
        <span className="font-bold text-ink">Rev {item.latest}</span> {pinned ? 'added' : 'is ready'}{latest ? ` ${relativeTime(latest.createdAt)}` : ''}.
      </span>
      <button type="button" onClick={onShowLatest} className={`shrink-0 ${link}`}>{pinned ? `View rev ${item.latest}` : `Show rev ${item.latest}`}</button>
      <button type="button" onClick={onCompare} className={`shrink-0 ${link}`}>Compare</button>
    </div>
  )
}
