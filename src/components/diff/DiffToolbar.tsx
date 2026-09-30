/**
 * Context block at the top of the Changes panel: which view is shown (a
 * segmented control, or one dropdown when the panel is narrow) and, for
 * branch views, the branch and what it is compared with.
 *
 * Branch views ("All task changes", "Committed") are read-only history, so
 * they show the comparison base; the other views show a one-line hint.
 * Refresh and discard live in the panel header and the file list.
 */

import { useEffect, useState } from 'react'
import { IconGitBranch, IconChevronDown, IconDots } from '@tabler/icons-react'
import type { DiffReview, DiffSummary, DiffView } from '../../types'

interface DiffToolbarProps {
  branch: string
  scope: DiffView
  summary: DiffSummary
  /** Present for branch views: what the diff is compared against. */
  review: DiffReview | null
  /** Narrow panel or phone: views in a dropdown, branch and base stacked. */
  narrow?: boolean
  onScopeChange: (scope: DiffView) => void
  /** Choose the review base; null returns to automatic. */
  onReviewBaseChange: (base: string | null) => void
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
const TAB_VIEWS: DiffView[] = ['branch', 'committed', 'all']
const MORE_VIEWS: DiffView[] = ['staged', 'unstaged']

/** Why an automatic base was chosen, shown next to it. */
const AUTOMATIC_REASON: Record<Exclude<DiffReview['baseSource'], 'user'>, string> = {
  pr: 'pull request base',
  worktree: 'branch start',
  default: 'default branch',
}

const MENU = 'absolute z-20 mt-1 min-w-[200px] overflow-hidden rounded-floating border border-edge-strong bg-surface-raised py-1 shadow-floating'
const MENU_ITEM = 'density-row flex w-full items-center gap-2 px-3 py-1.5 text-left text-meta hover:bg-edge'

/** A floating menu anchored below its trigger; closes on outside click or Escape (without closing the panel). */
function Popover({ onClose, align = 'left', children }: { onClose: () => void; align?: 'left' | 'right'; children: React.ReactNode }) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('keydown', handler, true)
    return () => { document.removeEventListener('keydown', handler, true) }
  }, [onClose])
  return (
    <>
      <div className="fixed inset-0 z-10" onClick={onClose} />
      <div className={`${MENU} ${align === 'right' ? 'right-0' : 'left-0'} top-full`} role="menu">{children}</div>
    </>
  )
}

export function DiffToolbar({ branch, scope, summary, review, narrow, onScopeChange, onReviewBaseChange }: DiffToolbarProps) {
  const [menu, setMenu] = useState<null | 'views' | 'more' | 'base'>(null)
  const close = () => { setMenu(null) }
  const pick = (view: DiffView) => { onScopeChange(view); setMenu(null) }

  const count = summary.filesChanged > 0 && <span className="text-micro font-normal text-ink-muted">{summary.filesChanged}</span>

  // Keep the current base selectable even if it is not among the candidates.
  const baseOptions = review
    ? [review.baseRef, ...review.candidates.filter(c => c !== review.baseRef && c !== branch)]
    : []
  const reason = review && review.baseSource !== 'user' ? AUTOMATIC_REASON[review.baseSource] : null

  const views = narrow ? (
    <div className="relative">
      <button
        className="density-row flex h-[34px] w-full items-center gap-2 rounded-control border border-edge bg-page px-3 text-meta text-ink"
        onClick={() => { setMenu(menu === 'views' ? null : 'views') }}
        title={SCOPE_HINTS[scope]}
        aria-haspopup="menu"
        aria-expanded={menu === 'views'}
      >
        <span className="font-bold">{SCOPE_LABELS[scope]}</span>
        {count}
        <span className="flex-1" />
        <IconChevronDown size={16} className="text-ink-muted" />
      </button>
      {menu === 'views' && (
        <Popover onClose={close}>
          {VIEW_ORDER.map((v, i) => (
            <div key={v}>
              {i === 3 && <div className="my-1 border-t border-edge" />}
              <button className={`${MENU_ITEM} ${v === scope ? 'font-bold text-primary-5' : 'text-ink'}`} title={SCOPE_HINTS[v]} onClick={() => { pick(v) }} role="menuitem">
                {SCOPE_LABELS[v]}
              </button>
            </div>
          ))}
        </Popover>
      )}
    </div>
  ) : (
    <div className="flex gap-0.5 rounded-lg bg-surface-raised p-[3px]" role="tablist" aria-label="Changes view">
      {TAB_VIEWS.map(v => {
        const active = v === scope
        return (
          <button
            key={v}
            role="tab"
            aria-selected={active}
            className={`flex h-8 flex-auto items-center justify-center gap-1.5 whitespace-nowrap rounded-control px-2 text-meta ${
              active ? 'bg-page font-bold text-ink shadow-[0_1px_2px_rgb(20_28_43/0.12)]' : 'text-ink-muted hover:text-ink'
            }`}
            title={SCOPE_HINTS[v]}
            onClick={() => { if (!active) onScopeChange(v) }}
          >
            {SCOPE_LABELS[v]}
            {active && count}
          </button>
        )
      })}
      <div className="relative flex">
        {MORE_VIEWS.includes(scope) ? (
          <button
            className="flex h-8 items-center gap-1.5 whitespace-nowrap rounded-control bg-page px-2 text-meta font-bold text-ink shadow-[0_1px_2px_rgb(20_28_43/0.12)]"
            title={SCOPE_HINTS[scope]}
            onClick={() => { setMenu(menu === 'more' ? null : 'more') }}
            aria-haspopup="menu"
          >
            {SCOPE_LABELS[scope]}
            {count}
            <IconDots size={16} className="text-ink-muted" />
          </button>
        ) : (
          <button
            className="flex h-8 w-8 items-center justify-center rounded-control text-ink-muted hover:text-ink"
            title="More views"
            aria-label="More views"
            onClick={() => { setMenu(menu === 'more' ? null : 'more') }}
            aria-haspopup="menu"
          >
            <IconDots size={18} />
          </button>
        )}
        {menu === 'more' && (
          <Popover onClose={close} align="right">
            {MORE_VIEWS.map(v => (
              <button key={v} className={`${MENU_ITEM} ${v === scope ? 'font-bold text-primary-5' : 'text-ink'}`} title={SCOPE_HINTS[v]} onClick={() => { pick(v) }} role="menuitem">
                {SCOPE_LABELS[v]}
              </button>
            ))}
          </Popover>
        )}
      </div>
    </div>
  )

  const baseButton = review && (
    <div className="relative min-w-0">
      <button
        className="density-row flex h-[30px] max-w-full items-center gap-2 rounded-control border border-edge bg-page pl-2.5 pr-2 text-ink hover:border-edge-strong"
        onClick={() => { setMenu(menu === 'base' ? null : 'base') }}
        title={`Compared with ${review.baseRef} (merge base ${review.mergeBase.slice(0, 8)})`}
        aria-haspopup="menu"
        aria-expanded={menu === 'base'}
        aria-label={`Compared with ${review.baseRef}`}
      >
        <span className="truncate whitespace-nowrap font-mono text-body">{review.baseRef}</span>
        {reason && !narrow && <span className="whitespace-nowrap text-micro text-ink-faint">{reason}</span>}
        <IconChevronDown size={14} className="shrink-0 text-ink-muted" />
      </button>
      {menu === 'base' && (
        <Popover onClose={close}>
          <button
            className={`${MENU_ITEM} ${review.baseSource !== 'user' ? 'font-bold text-primary-5' : 'text-ink'}`}
            onClick={() => { onReviewBaseChange(null); close() }}
            role="menuitem"
          >
            Automatic
            {reason && <span className="font-normal text-ink-faint">{review.baseRef} · {reason}</span>}
          </button>
          <div className="my-1 border-t border-edge" />
          {baseOptions.map(ref => (
            <button
              key={ref}
              className={`${MENU_ITEM} font-mono ${review.baseSource === 'user' && ref === review.baseRef ? 'font-bold text-primary-5' : 'text-ink'}`}
              onClick={() => { onReviewBaseChange(ref); close() }}
              role="menuitem"
            >
              {ref}
            </button>
          ))}
        </Popover>
      )}
    </div>
  )

  return (
    <div className="flex shrink-0 flex-col gap-3 border-b border-edge px-4 py-3">
      {views}
      {review ? (
        narrow ? (
          <div className="flex flex-col gap-1.5">
            <div className="flex min-w-0 items-center gap-2 text-ink">
              <IconGitBranch size={16} className="shrink-0 text-ink-muted" />
              <span className="truncate font-mono text-body" title={branch}>{branch}</span>
            </div>
            <div className="flex min-w-0 items-center gap-2">
              <span className="text-micro text-ink-faint">vs</span>
              {baseButton}
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3.5 gap-y-1.5">
            <span className="text-micro text-ink-faint">Branch</span>
            <div className="flex min-w-0 items-center gap-2 text-ink">
              <IconGitBranch size={16} className="shrink-0 text-ink-muted" />
              <span className="truncate font-mono text-body" title={branch}>{branch}</span>
            </div>
            <span className="text-micro text-ink-faint">Compared with</span>
            <div className="flex min-w-0">{baseButton}</div>
          </div>
        )
      ) : (
        <p className="text-micro text-ink-faint">{SCOPE_HINTS[scope]}</p>
      )}
    </div>
  )
}
