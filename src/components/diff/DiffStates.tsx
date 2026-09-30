/**
 * What the Changes panel's file area shows when there is no file to show:
 * loading skeleton, empty view and the error box.
 */

import { IconAlertCircle, IconFileCode } from '@tabler/icons-react'
import type { DiffView } from '../../types'

const SKELETON_WIDTHS = [62, 48, 71, 40, 55, 66]

export function DiffLoading() {
  return (
    <div className="flex flex-col gap-3 px-4 py-3" aria-busy="true">
      {SKELETON_WIDTHS.map((w, i) => (
        <div key={i} className="flex items-center gap-2.5 pl-2.5">
          <span className="h-[18px] w-[18px] shrink-0 rounded bg-surface-raised" />
          <span className="h-3 rounded bg-surface-raised" style={{ width: `${w}%` }} />
        </div>
      ))}
      <p className="pt-1 text-micro text-ink-faint">Reading changes…</p>
    </div>
  )
}

const EMPTY_COPY: Record<DiffView, { title: string; line: string }> = {
  branch: { title: 'No changes detected', line: 'This branch changes nothing since it left its base.' },
  committed: { title: 'No changes detected', line: 'Nothing is committed on this branch since it left its base.' },
  all: { title: 'No uncommitted changes', line: 'Everything on this branch is committed.' },
  staged: { title: 'No changes detected', line: 'Nothing is staged for the next commit.' },
  unstaged: { title: 'No changes detected', line: 'There are no unstaged edits.' },
}

export function DiffEmpty({ view, onShowBranch }: { view: DiffView; onShowBranch: () => void }) {
  const copy = EMPTY_COPY[view]
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <IconFileCode size={36} className="text-ink-faint" />
      <p className="text-body font-bold text-ink">{copy.title}</p>
      <p className="text-meta text-ink-muted">{copy.line}</p>
      {view === 'all' && (
        <button className="density-row mt-2 h-8 rounded-control border border-edge bg-page px-3 text-meta text-ink hover:bg-surface-raised" onClick={onShowBranch}>
          Show all task changes
        </button>
      )}
    </div>
  )
}

/** A short next step for the error git (or the server) reported. */
function errorHint(message: string): string {
  if (/not a git repository/i.test(message)) return "This session's folder is not a git repository, so there is nothing to compare."
  if (/unknown revision|bad revision|ambiguous argument|not a valid object name|no merge base|invalid upstream/i.test(message)) {
    return 'The base branch may not be fetched here. Fetch it or choose another base, then retry.'
  }
  if (/larger than .* MB/i.test(message)) return 'Try a narrower view, such as Uncommitted, or review this change outside Codekin.'
  if (/timed? ?out|ETIMEDOUT|SIGTERM/i.test(message)) return 'Git took too long to answer. Retry in a moment.'
  if (/session not found|not in a session/i.test(message)) return 'This session is not running on the server. Reopen it, then retry.'
  if (/can only be discarded|invalid path|escapes working directory/i.test(message)) return 'Nothing was discarded.'
  return 'Retry, or check the repository from a terminal.'
}

export function DiffError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="m-4 flex gap-2.5 rounded-lg border border-error-9 bg-error-11 py-3 pl-3.5 pr-3" role="alert">
      <IconAlertCircle size={18} className="mt-0.5 shrink-0 text-error-5" />
      <div className="flex min-w-0 flex-1 flex-col items-start gap-1.5">
        <p className="text-meta font-bold text-error-4">Couldn't load changes</p>
        <p className="break-words font-mono text-meta text-error-2 [overflow-wrap:anywhere]">{message}</p>
        <p className="text-micro text-ink-muted">{errorHint(message)}</p>
        <button className="density-row mt-1 h-[30px] rounded-control border border-error-8 bg-error-12 px-3 text-meta text-error-4 hover:bg-error-11" onClick={onRetry}>
          Retry
        </button>
      </div>
    </div>
  )
}
