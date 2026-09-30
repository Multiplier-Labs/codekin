/**
 * Read-only pull request row in the Changes panel: PR number and title,
 * draft/open/merged state, CI checks and review decision. The branch is not
 * repeated here; the panel's context block shows it. The panel header's
 * refresh button refreshes this too.
 *
 * Checks describe the PR's remote head, so the card says when local work is
 * not what was checked (commits not pushed, edits not committed, head not
 * fetched). Unknown states — no GitHub remote, gh missing or signed out, rate
 * limited, lookup errors, stale results — are shown as such, never as passing.
 * There are deliberately no merge or review controls here.
 */

import { useState } from 'react'
import {
  IconGitPullRequest, IconExternalLink, IconCircleCheck, IconCircleX, IconClock, IconAlertTriangle,
} from '@tabler/icons-react'
import type { PrStatus, PullRequestInfo } from '../../types'

interface Props {
  status: PrStatus | null
  /** Narrow panel: number, badge, checks and link on one line, the title below. */
  narrow?: boolean
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
  merged: 'bg-primary-11 text-primary-4',
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

function Checks({ checks, compact }: { checks: PullRequestInfo['checks']; compact?: boolean }) {
  if (checks.total === 0) return <span className="text-ink-faint">no checks</span>
  const allPassed = checks.failed === 0 && checks.pending === 0
  return (
    <span className="flex items-center gap-2" title={`${checks.total} checks on the PR head`}>
      {checks.passed > 0 && (
        <span className="flex items-center gap-1 text-success-5">
          <IconCircleCheck size={14} className="shrink-0" />
          {compact ? checks.passed : allPassed ? `${checks.passed} check${checks.passed === 1 ? '' : 's'} passed` : `${checks.passed} passed`}
        </span>
      )}
      {checks.failed > 0 && <span className="flex items-center gap-1 text-error-5"><IconCircleX size={14} className="shrink-0" />{compact ? checks.failed : `${checks.failed} failed`}</span>}
      {checks.pending > 0 && <span className="flex items-center gap-1 text-warning-5"><IconClock size={14} className="shrink-0" />{compact ? checks.pending : `${checks.pending} pending`}</span>}
      {checks.skipped > 0 && !compact && <span className="text-ink-faint">{checks.skipped} skipped</span>}
    </span>
  )
}

export function PrStatusCard({ status, narrow }: Props) {
  const [selected, setSelected] = useState(0)

  if (!status) return null

  if (status.state !== 'found') {
    const unknown = status.state !== 'none'
    return (
      <div className="flex shrink-0 items-center gap-2.5 border-b border-edge py-2.5 pl-4 pr-2 text-meta text-ink-faint">
        {unknown ? <IconAlertTriangle size={17} className="shrink-0 text-warning-5" /> : <IconGitPullRequest size={17} className="shrink-0" />}
        <span className={`min-w-0 flex-1 ${unknown ? 'text-warning-5' : ''}`}>
          {unknown ? `Pull request status unknown: ${status.message ?? status.state}` : (status.message ?? 'No pull request for this branch.')}
        </span>
      </div>
    )
  }

  const pull = status.pulls[Math.min(selected, status.pulls.length - 1)]
  const label = stateLabel(pull)
  const { checks } = pull
  const notes = localNotes(pull, status.dirty)

  const title = status.pulls.length > 1 ? (
    <select
      aria-label="Pull request"
      value={selected}
      onChange={(e) => { setSelected(Number(e.target.value)) }}
      className="min-w-0 flex-1 truncate rounded-control border border-edge bg-page px-2 py-0.5 text-meta text-ink focus:border-focus"
    >
      {status.pulls.map((p, i) => <option key={p.number} value={i}>#{p.number} {p.title} ({stateLabel(p)})</option>)}
    </select>
  ) : (
    <span className="min-w-0 flex-1 truncate text-ink" title={pull.title}>
      {!narrow && <span className="text-ink-muted">#{pull.number} </span>}
      {pull.title}
    </span>
  )
  const badge = <span className={`shrink-0 rounded-control px-2 py-px text-micro capitalize ${STATE_STYLE[label]}`}>{label}</span>
  const link = (
    <a
      href={pull.url}
      target="_blank"
      rel="noreferrer"
      title="Open on GitHub"
      aria-label="Open on GitHub"
      className="density-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink"
    >
      <IconExternalLink size={18} />
    </a>
  )
  const reviewLabel = pull.reviewDecision ? REVIEW_LABELS[pull.reviewDecision] : undefined

  return (
    <div className="flex shrink-0 flex-col gap-1 border-b border-edge py-2.5 pl-4 pr-2 text-meta">
      {narrow ? (
        <>
          <div className="flex items-center gap-2">
            <IconGitPullRequest size={17} className="shrink-0 text-ink-muted" />
            <span className="text-ink-muted">#{pull.number}</span>
            {badge}
            <span className="min-w-0 flex-1 text-micro"><Checks checks={checks} compact /></span>
            {link}
          </div>
          {status.pulls.length > 1 ? <div className="flex">{title}</div> : <div className="truncate text-ink" title={pull.title}>{pull.title}</div>}
        </>
      ) : (
        <>
          <div className="flex items-center gap-2">
            <IconGitPullRequest size={17} className="shrink-0 text-ink-muted" />
            {title}
            {badge}
            {link}
          </div>
          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[25px] text-micro text-ink-muted">
            <Checks checks={checks} />
            {reviewLabel && <><span className="text-ink-faint">·</span><span>{reviewLabel}</span></>}
            <span className="text-ink-faint">·</span>
            <span className="text-ink-faint">checked {relativeTime(status.fetchedAt)}</span>
          </div>
        </>
      )}

      {checks.failing.length > 0 && (
        <p className={`${narrow ? '' : 'pl-[25px]'} text-micro text-error-5`}>Failing: {checks.failing.join(', ')}</p>
      )}
      {status.staleReason && <p className={`${narrow ? '' : 'pl-[25px]'} text-micro text-warning-5`}>{status.staleReason}</p>}
      {notes.map(note => <p key={note} className={`${narrow ? '' : 'pl-[25px]'} text-micro text-warning-5`}>{note}</p>)}
    </div>
  )
}
