/**
 * Footer of the Changes panel collecting review comments: drafts from every
 * view and file, one explicit "Send to agent" action, and the sent history.
 *
 * Drafts whose code changed since they were written ("stale") are not sent
 * unless the reviewer opts in, in which case they go with the original code
 * they were written on — they are never re-attached to other lines.
 */

import { useState } from 'react'
import { IconMessage2, IconSend, IconX, IconChevronDown, IconChevronRight } from '@tabler/icons-react'
import type { DiffView, ReviewComment } from '../../types'

interface Props {
  comments: ReviewComment[]
  /** View currently shown; comments from other views are labelled. */
  view: DiffView
  sending: boolean
  error: string | null
  /** Whether the current view has lines to comment on (for the hint). */
  hasFiles: boolean
  /** Footer hint wording: full (with the J/K keys), short (narrow panel) or touch. */
  hint?: 'full' | 'short' | 'touch'
  onSend: (ids: string[], includeStale: boolean) => void
  onDelete: (id: string) => void
  onSelectFile: (path: string) => void
  onDismissError: () => void
}

const VIEW_LABELS: Record<DiffView, string> = {
  branch: 'task changes', committed: 'committed', all: 'uncommitted', staged: 'staged', unstaged: 'unstaged',
}

function where(c: ReviewComment): string {
  const a = c.anchor
  const lines = a.startLine === a.endLine ? `${a.startLine}` : `${a.startLine}–${a.endLine}`
  return `${a.path}:${a.side === 'old' ? 'removed ' : ''}${lines}`
}

function Row({ comment, view, onDelete, onSelectFile }: {
  comment: ReviewComment
  view: DiffView
  onDelete: (id: string) => void
  onSelectFile: (path: string) => void
}) {
  return (
    <li className="group flex items-start gap-2 rounded-control px-1 py-1 hover:bg-surface-raised">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 text-micro text-ink-faint">
          <button onClick={() => { onSelectFile(comment.anchor.path) }} className="truncate font-mono hover:text-ink" title="Show this file">
            {where(comment)}
          </button>
          {comment.anchor.view !== view && <span>· {VIEW_LABELS[comment.anchor.view]}</span>}
          {comment.stale && <span className="shrink-0 rounded bg-warning-10 px-1.5 text-warning-4">code changed</span>}
        </div>
        <p className="truncate text-meta text-ink" title={comment.body}>{comment.body}</p>
      </div>
      <button
        onClick={() => { onDelete(comment.id) }}
        title="Delete comment"
        className="shrink-0 rounded-control p-0.5 text-ink-faint opacity-0 hover:text-error-5 group-hover:opacity-100 focus:opacity-100"
      >
        <IconX size={14} />
      </button>
    </li>
  )
}

export function ReviewCommentsTray({ comments, view, sending, error, hasFiles, hint = 'full', onSend, onDelete, onSelectFile, onDismissError }: Props) {
  const [includeStale, setIncludeStale] = useState(false)
  const [showSent, setShowSent] = useState(false)
  const [collapsed, setCollapsed] = useState(false)

  const drafts = comments.filter(c => c.status === 'draft')
  const sent = comments.filter(c => c.status === 'sent')
  const stale = drafts.filter(c => c.stale)
  const toSend = includeStale ? drafts : drafts.filter(c => !c.stale)

  if (comments.length === 0 && !error) {
    if (!hasFiles) return null
    return (
      <div className={`flex shrink-0 items-center gap-3 border-t border-edge px-4 py-2 text-micro text-ink-faint ${hint === 'touch' ? 'pb-[max(0.5rem,env(safe-area-inset-bottom))]' : ''}`}>
        <p className="min-w-0 flex-1">
          {hint === 'touch' ? 'Tap a line number to comment.' : hint === 'short' ? 'Click a line number to comment.' : 'Click a line number to comment; shift-click to select a range.'}
        </p>
        {hint === 'full' && (
          <span className="flex shrink-0 gap-1" title="J / K: next / previous file">
            <kbd className="rounded border border-edge bg-page px-[5px] font-mono text-micro text-ink-muted">J</kbd>
            <kbd className="rounded border border-edge bg-page px-[5px] font-mono text-micro text-ink-muted">K</kbd>
          </span>
        )}
      </div>
    )
  }

  return (
    <div className={`flex max-h-[45%] shrink-0 flex-col border-t border-edge bg-surface text-meta ${hint === 'touch' ? 'pb-[env(safe-area-inset-bottom)]' : ''}`}>
      <div className="flex items-center gap-2 py-2 pl-4 pr-2">
        <button onClick={() => { setCollapsed(!collapsed) }} className="flex min-w-0 flex-1 items-center gap-1.5 text-ink" title={collapsed ? 'Show comments' : 'Hide comments'}>
          {collapsed ? <IconChevronRight size={16} /> : <IconChevronDown size={16} />}
          <IconMessage2 size={16} className="text-ink-muted" />
          <span className="truncate font-bold">
            {drafts.length} draft{drafts.length === 1 ? '' : 's'}
            {stale.length > 0 && <span className="font-normal text-warning-5"> · {stale.length} changed</span>}
          </span>
        </button>
        <button
          onClick={() => { onSend(toSend.map(c => c.id), includeStale) }}
          disabled={toSend.length === 0 || sending}
          title="Send these comments to the agent as one message"
          className="density-row flex h-8 shrink-0 items-center gap-1.5 rounded-control bg-primary-fill px-3 font-bold text-on-primary-fill hover:opacity-90 disabled:opacity-50"
        >
          <IconSend size={16} />
          {sending ? 'Sending…' : `Send ${toSend.length} to agent`}
        </button>
      </div>

      {error && (
        <div className="flex items-start gap-2 px-4 pb-1 text-error-5" role="alert">
          <span className="flex-1">{error}</span>
          <button onClick={onDismissError} title="Dismiss" className="shrink-0"><IconX size={12} /></button>
        </div>
      )}

      {!collapsed && (
        <div className="overflow-y-auto px-3 pb-2">
          {stale.length > 0 && (
            <label className="mb-1 flex items-start gap-1.5 px-1 text-warning-5">
              <input type="checkbox" checked={includeStale} onChange={(e) => { setIncludeStale(e.target.checked) }} className="mt-0.5" />
              <span>
                {stale.length} comment{stale.length === 1 ? ' points' : 's point'} at code that changed. Include {stale.length === 1 ? 'it' : 'them'} with the original code, or delete and re-select.
              </span>
            </label>
          )}
          <ul>
            {drafts.map(c => <Row key={c.id} comment={c} view={view} onDelete={onDelete} onSelectFile={onSelectFile} />)}
          </ul>
          {sent.length > 0 && (
            <>
              <button onClick={() => { setShowSent(!showSent) }} className="mt-1 flex items-center gap-1 px-1 text-micro text-ink-faint hover:text-ink">
                {showSent ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
                {sent.length} sent
              </button>
              {showSent && (
                <ul className="opacity-70">
                  {sent.map(c => <Row key={c.id} comment={c} view={view} onDelete={onDelete} onSelectFile={onSelectFile} />)}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
