/**
 * Sticky toolbar for the diff panel — branch indicator, view dropdown,
 * review-base picker, discard-all button, summary line, and refresh button.
 *
 * Branch views ("All task changes", "Committed") are read-only history, so
 * they show the comparison base instead of a discard button.
 */

import { useState } from 'react'
import { IconRefresh, IconGitBranch, IconTrash, IconChevronDown, IconArrowRight } from '@tabler/icons-react'
import type { DiffReview, DiffSummary, DiffView } from '../../types'

interface DiffToolbarProps {
  branch: string
  scope: DiffView
  summary: DiffSummary
  /** Present for branch views: what the diff is compared against. */
  review: DiffReview | null
  loading: boolean
  hasUntrackedFiles: boolean
  onScopeChange: (scope: DiffView) => void
  /** Choose the review base; null returns to automatic. */
  onReviewBaseChange: (base: string | null) => void
  onRefresh: () => void
  /** Omitted for read-only views, which hides the discard-all button. */
  onDiscardAll?: () => void
}

const SCOPE_LABELS: Record<DiffView, string> = {
  branch: 'All task changes',
  committed: 'Committed',
  all: 'Uncommitted',
  staged: 'Staged',
  unstaged: 'Unstaged',
}

const SCOPE_HINTS: Record<DiffView, string> = {
  branch: 'Everything this branch changes since it left its base: commits, edits and new files',
  committed: 'Only what is committed on this branch since it left its base',
  all: 'Edits not yet committed, including new files',
  staged: 'Edits staged for the next commit',
  unstaged: 'Edits not yet staged, including new files',
}

const VIEW_ORDER: DiffView[] = ['branch', 'committed', 'all', 'staged', 'unstaged']

const AUTOMATIC = '__automatic__'

/** Why an automatic base was chosen, shown next to it. */
const AUTOMATIC_REASON: Record<Exclude<DiffReview['baseSource'], 'user'>, string> = {
  pr: 'pull request base',
  worktree: 'branch start',
  default: 'default branch',
}

export function DiffToolbar({
  branch, scope, summary, review, loading, hasUntrackedFiles,
  onScopeChange, onReviewBaseChange, onRefresh, onDiscardAll,
}: DiffToolbarProps) {
  const [scopeOpen, setScopeOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const handleDiscardAll = () => {
    if (!onDiscardAll) return
    if (!confirmDiscard) {
      setConfirmDiscard(true)
      setTimeout(() => setConfirmDiscard(false), 3000)
      return
    }
    onDiscardAll()
    setConfirmDiscard(false)
  }

  // Keep the current base selectable even if it is not among the candidates.
  const baseOptions = review
    ? [review.baseRef, ...review.candidates.filter(c => c !== review.baseRef && c !== branch)]
    : []

  return (
    <div className="sticky top-0 z-10 bg-surface-raised border-b border-edge px-3 py-2 flex flex-col gap-2">
      {/* Row 1: Branch + scope + actions */}
      <div className="flex items-center gap-2">
        {/* Branch */}
        <div className="flex items-center gap-1 text-xs text-ink-muted shrink-0">
          <IconGitBranch size={13} />
          <span className="truncate max-w-[120px]" title={branch}>{branch}</span>
        </div>

        {/* Scope dropdown */}
        <div className="relative flex-1">
          <button
            className="flex items-center gap-1 text-xs text-ink bg-surface-raised hover:bg-edge rounded-control px-2 py-1"
            onClick={() => setScopeOpen(!scopeOpen)}
            title={SCOPE_HINTS[scope]}
          >
            <span>{SCOPE_LABELS[scope]}</span>
            {summary.filesChanged > 0 && (
              <span className="text-ink-muted">({summary.filesChanged})</span>
            )}
            <IconChevronDown size={12} />
          </button>
          {scopeOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setScopeOpen(false)} />
              <div className="absolute top-full left-0 mt-1 bg-surface-raised border border-edge-strong rounded-floating shadow-floating z-20 min-w-[180px]">
                {VIEW_ORDER.map((s, i) => (
                  <div key={s}>
                    {i === 2 && <div className="my-1 border-t border-edge" />}
                    <button
                      className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-edge ${
                        s === scope ? 'text-primary-5' : 'text-ink'
                      }`}
                      title={SCOPE_HINTS[s]}
                      onClick={() => { onScopeChange(s); setScopeOpen(false) }}
                    >
                      {SCOPE_LABELS[s]}
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <button
          className={`p-1 rounded-control hover:bg-edge text-ink-muted hover:text-ink ${loading ? 'animate-spin' : ''}`}
          onClick={onRefresh}
          title="Refresh diff"
          disabled={loading}
        >
          <IconRefresh size={14} />
        </button>
        {onDiscardAll && (
          <button
            className={`p-1 rounded-control text-xs ${
              summary.filesChanged === 0
                ? 'text-ink-faint cursor-not-allowed'
                : confirmDiscard
                  ? 'text-error-4 bg-error-950/30 hover:bg-error-950/50'
                  : 'text-error-5 hover:bg-error-950/30'
            }`}
            onClick={handleDiscardAll}
            disabled={summary.filesChanged === 0}
            title={confirmDiscard
              ? (hasUntrackedFiles ? 'Click again — untracked files will be deleted!' : 'Click again to confirm discard all')
              : 'Discard all changes'
            }
          >
            <IconTrash size={14} />
          </button>
        )}
      </div>

      {/* Review base (branch views) */}
      {review && (
        <div className="flex items-center gap-1.5 text-xs text-ink-muted">
          <span className="truncate" title={branch}>{branch}</span>
          <IconArrowRight size={12} className="shrink-0" />
          <label className="sr-only" htmlFor="diff-review-base">Compare against</label>
          <select
            id="diff-review-base"
            className="min-w-0 max-w-[180px] truncate rounded-control border border-edge bg-surface px-1.5 py-0.5 text-xs text-ink focus:border-focus"
            value={review.baseSource === 'user' ? review.baseRef : AUTOMATIC}
            title={`Compared against ${review.baseRef} (merge base ${review.mergeBase.slice(0, 8)})`}
            onChange={(e) => { onReviewBaseChange(e.target.value === AUTOMATIC ? null : e.target.value) }}
          >
            <option value={AUTOMATIC}>{review.baseSource === 'user' ? 'Automatic' : `${review.baseRef} (${AUTOMATIC_REASON[review.baseSource]})`}</option>
            {baseOptions.map(ref => <option key={ref} value={ref}>{ref}</option>)}
          </select>
        </div>
      )}

      {/* Row 2: Summary */}
      {summary.filesChanged > 0 && (
        <div className="flex items-center gap-2 text-xs text-ink-muted">
          <span className="flex items-center gap-1">
            {summary.truncated && (
              <span className="text-warning-5" title={summary.truncationReason}>truncated</span>
            )}
            <span>{summary.filesChanged} file{summary.filesChanged !== 1 ? 's' : ''} changed</span>
            {!!summary.uncommittedFiles && (
              <span className="text-warning-5" title="Files with changes that are not committed yet">
                · {summary.uncommittedFiles} uncommitted
              </span>
            )}
          </span>
          <span className="text-success-5">+{summary.insertions}</span>
          <span className="text-error-5">&minus;{summary.deletions}</span>
        </div>
      )}
    </div>
  )
}
