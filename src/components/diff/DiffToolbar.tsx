/**
 * Sticky toolbar for the diff panel — branch indicator, scope dropdown,
 * discard-all button, summary line, and refresh button.
 */

import { useState } from 'react'
import { IconRefresh, IconGitBranch, IconTrash, IconChevronDown } from '@tabler/icons-react'
import type { DiffScope, DiffSummary } from '../../types'

interface DiffToolbarProps {
  branch: string
  scope: DiffScope
  summary: DiffSummary
  loading: boolean
  hasUntrackedFiles: boolean
  onScopeChange: (scope: DiffScope) => void
  onRefresh: () => void
  onDiscardAll: () => void
}

const SCOPE_LABELS: Record<DiffScope, string> = {
  all: 'Uncommitted changes',
  staged: 'Staged',
  unstaged: 'Unstaged',
}

export function DiffToolbar({
  branch, scope, summary, loading, hasUntrackedFiles,
  onScopeChange, onRefresh, onDiscardAll,
}: DiffToolbarProps) {
  const [scopeOpen, setScopeOpen] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)

  const handleDiscardAll = () => {
    if (!confirmDiscard) {
      setConfirmDiscard(true)
      setTimeout(() => setConfirmDiscard(false), 3000)
      return
    }
    onDiscardAll()
    setConfirmDiscard(false)
  }

  return (
    <div className="sticky top-0 z-10 bg-neutral-11 border-b border-neutral-9 px-3 py-2 flex flex-col gap-2">
      {/* Row 1: Branch + scope + actions */}
      <div className="flex items-center gap-2">
        {/* Branch */}
        <div className="flex items-center gap-1 text-xs text-neutral-4 shrink-0">
          <IconGitBranch size={13} />
          <span className="truncate max-w-[120px]" title={branch}>{branch}</span>
        </div>

        {/* Scope dropdown */}
        <div className="relative flex-1">
          <button
            className="flex items-center gap-1 text-xs text-neutral-2 bg-neutral-10 hover:bg-neutral-9 rounded px-2 py-1"
            onClick={() => setScopeOpen(!scopeOpen)}
          >
            <span>{SCOPE_LABELS[scope]}</span>
            {summary.filesChanged > 0 && (
              <span className="text-neutral-5">({summary.filesChanged})</span>
            )}
            <IconChevronDown size={12} />
          </button>
          {scopeOpen && (
            <>
              <div className="fixed inset-0 z-10" onClick={() => setScopeOpen(false)} />
              <div className="absolute top-full left-0 mt-1 bg-neutral-10 border border-neutral-8 rounded shadow-lg z-20 min-w-[160px]">
                {(['all', 'staged', 'unstaged'] as DiffScope[]).map(s => (
                  <button
                    key={s}
                    className={`block w-full text-left px-3 py-1.5 text-xs hover:bg-neutral-9 ${
                      s === scope ? 'text-primary-5' : 'text-neutral-2'
                    }`}
                    onClick={() => { onScopeChange(s); setScopeOpen(false) }}
                  >
                    {SCOPE_LABELS[s]}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Actions */}
        <button
          className={`p-1 rounded hover:bg-neutral-9 text-neutral-4 hover:text-neutral-2 ${loading ? 'animate-spin' : ''}`}
          onClick={onRefresh}
          title="Refresh diff"
          disabled={loading}
        >
          <IconRefresh size={14} />
        </button>
        <button
          className={`p-1 rounded text-xs ${
            summary.filesChanged === 0
              ? 'text-neutral-7 cursor-not-allowed'
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
      </div>

      {/* Row 2: Summary */}
      {summary.filesChanged > 0 && (
        <div className="flex items-center gap-2 text-xs text-neutral-4">
          <span className="flex items-center gap-1">
            {summary.truncated && (
              <span className="text-warning-5" title={summary.truncationReason}>truncated</span>
            )}
            <span>{summary.filesChanged} file{summary.filesChanged !== 1 ? 's' : ''} changed</span>
          </span>
          <span className="text-success-5">+{summary.insertions}</span>
          <span className="text-error-5">&minus;{summary.deletions}</span>
        </div>
      )}
    </div>
  )
}
