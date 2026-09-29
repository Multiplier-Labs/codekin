/**
 * Read-only pull request card at the top of the Changes panel: PR link,
 * base ← head, draft/open/merged state, CI checks and review decision.
 *
 * Checks describe the PR's remote head, so the card says when local work is
 * not what was checked (commits not pushed, edits not committed, head not
 * fetched). Unknown states — no GitHub remote, gh missing or signed out, rate
 * limited, lookup errors, stale results — are shown as such, never as passing.
 * There are deliberately no merge or review controls here.
 */

import { useState } from 'react'
import {
  IconGitPullRequest, IconExternalLink, IconRefresh, IconCircleCheck, IconCircleX, IconClock, IconAlertTriangle,
} from '@tabler/icons-react'
import type { PrStatus, PullRequestInfo } from '../../types'

interface Props {
  status: PrStatus | null
  loading: boolean
  onRefresh: () => void
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 1000))
  if (!Number.isFinite(seconds)) return ''
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

const STATE_STYLE: Record<string, string> = {
  open: 'bg-success-9/20 text-success-4',
  draft: 'bg-surface-raised text-ink-muted',
  merged: 'bg-primary-9/20 text-primary-4',
  closed: 'bg-error-9/20 text-error-4',
}

function stateLabel(pull: PullRequestInfo): 'open' | 'draft' | 'merged' | 'closed' {
  if (pull.state === 'MERGED') return 'merged'
  if (pull.state === 'CLOSED') return 'closed'
  return pull.isDraft ? 'draft' : 'open'
}

const REVIEW_LABELS: Record<string, string> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes requested',
  REVIEW_REQUIRED: 'review required',
}

/** Why local work may differ from what GitHub checked. */
function localNotes(pull: PullRequestInfo, dirty: boolean): string[] {
  const notes: string[] = []
  if (pull.ahead === null) notes.push('The PR head is not fetched here, so local work cannot be compared with it.')
  else if (pull.ahead > 0) notes.push(`${pull.ahead} local commit${pull.ahead === 1 ? '' : 's'} not pushed — checks do not cover ${pull.ahead === 1 ? 'it' : 'them'}.`)
  if (pull.behind) notes.push(`The PR has ${pull.behind} commit${pull.behind === 1 ? '' : 's'} not in this checkout.`)
  if (dirty) notes.push('Uncommitted local edits are not checked.')
  if (pull.isCrossRepository) notes.push(`From fork ${pull.headOwner ?? 'repository'}: its base is in another repository, so choose the review base manually.`)
  return notes
}

export function PrStatusCard({ status, loading, onRefresh }: Props) {
  const [selected, setSelected] = useState(0)

  if (!status) return null

  const refreshButton = (
    <button
      onClick={onRefresh}
      disabled={loading}
      title="Refresh pull request status"
      className={`shrink-0 rounded-control p-1 text-ink-muted hover:bg-surface-raised hover:text-ink ${loading ? 'animate-spin' : ''}`}
    >
      <IconRefresh size={13} />
    </button>
  )

  if (status.state !== 'found') {
    const unknown = status.state !== 'none'
    return (
      <div className="flex items-center gap-2 border-b border-edge px-3 py-1.5 text-meta text-ink-faint">
        {unknown ? <IconAlertTriangle size={13} className="shrink-0 text-warning-5" /> : <IconGitPullRequest size={13} className="shrink-0" />}
        <span className={`min-w-0 flex-1 ${unknown ? 'text-warning-5' : ''}`}>
          {unknown ? `Pull request status unknown: ${status.message ?? status.state}` : (status.message ?? 'No pull request for this branch.')}
        </span>
        {refreshButton}
      </div>
    )
  }

  const pull = status.pulls[Math.min(selected, status.pulls.length - 1)]
  const label = stateLabel(pull)
  const { checks } = pull
  const notes = localNotes(pull, status.dirty)

  return (
    <div className="flex flex-col gap-1 border-b border-edge bg-surface px-3 py-2 text-meta">
      <div className="flex items-center gap-2">
        <IconGitPullRequest size={14} className="shrink-0 text-ink-muted" />
        {status.pulls.length > 1 ? (
          <select
            aria-label="Pull request"
            value={selected}
            onChange={(e) => { setSelected(Number(e.target.value)) }}
            className="min-w-0 flex-1 truncate rounded-control border border-edge bg-surface px-1 py-0.5 text-meta text-ink focus:border-focus"
          >
            {status.pulls.map((p, i) => <option key={p.number} value={i}>#{p.number} {p.title} ({stateLabel(p)})</option>)}
          </select>
        ) : (
          <span className="min-w-0 flex-1 truncate text-ink" title={pull.title}>#{pull.number} {pull.title}</span>
        )}
        <span className={`shrink-0 rounded-control px-1.5 text-micro ${STATE_STYLE[label]}`}>{label}</span>
        {refreshButton}
        <a
          href={pull.url}
          target="_blank"
          rel="noreferrer"
          title="Open on GitHub"
          className="shrink-0 rounded-control p-1 text-ink-muted hover:bg-surface-raised hover:text-ink"
        >
          <IconExternalLink size={13} />
        </a>
      </div>

      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-5 text-ink-muted">
        <span className="font-mono">{pull.baseRefName} ← {pull.headRefName}</span>
        {checks.total === 0 ? (
          <span>no checks</span>
        ) : (
          <span className="flex items-center gap-1.5" title={`${checks.total} checks on the PR head`}>
            {checks.passed > 0 && <span className="flex items-center gap-0.5 text-success-5"><IconCircleCheck size={12} />{checks.passed}</span>}
            {checks.failed > 0 && <span className="flex items-center gap-0.5 text-error-5"><IconCircleX size={12} />{checks.failed}</span>}
            {checks.pending > 0 && <span className="flex items-center gap-0.5 text-warning-5"><IconClock size={12} />{checks.pending}</span>}
            {checks.skipped > 0 && <span className="text-ink-faint">{checks.skipped} skipped</span>}
          </span>
        )}
        {pull.reviewDecision && REVIEW_LABELS[pull.reviewDecision] && <span>{REVIEW_LABELS[pull.reviewDecision]}</span>}
        <span className="text-ink-faint">checked {relativeTime(status.fetchedAt)}</span>
      </div>

      {checks.failing.length > 0 && (
        <p className="pl-5 text-error-5">Failing: {checks.failing.join(', ')}</p>
      )}
      {status.staleReason && <p className="pl-5 text-warning-5">{status.staleReason}</p>}
      {notes.map(note => <p key={note} className="pl-5 text-warning-5">{note}</p>)}
    </div>
  )
}
