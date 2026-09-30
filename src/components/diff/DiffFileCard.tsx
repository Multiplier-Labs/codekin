/**
 * The active file in the Changes panel: a bar with the file's name, counts,
 * previous/next navigation and actions, over a scrolling body with its hunks.
 * Only one file is shown at a time; the parent keys this by path, so the
 * body starts at the top whenever the file changes.
 *
 * On touch, the bar becomes a file switcher: tapping the name opens the
 * file list, and the arrows are full-size touch targets.
 */

import { useState } from 'react'
import { IconChevronDown, IconChevronUp, IconCopy, IconTrash, IconFile, IconMessage2, IconSelector } from '@tabler/icons-react'
import type { DiffFile } from '../../types'
import { DiffHunkView, type DiffCommenting } from './DiffHunkView'
import { Counts, StatusChip } from './diffFileMeta'
import { displayName, splitPath } from './diffFiles'

// Diffs exceeding this many total changed lines start collapsed to keep initial
// render fast and avoid overwhelming the user with a wall of changes.
const LARGE_DIFF_THRESHOLD = 300

const ICON_BASE = 'density-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control disabled:opacity-35 disabled:pointer-events-none'
const ICON_BTN = `${ICON_BASE} text-ink-muted hover:bg-edge hover:text-ink`

interface DiffFileCardProps {
  file: DiffFile
  /** Position of this file in the list (0-based) and the list's length. */
  index: number
  total: number
  onPrev: () => void
  onNext: () => void
  /** Omitted in read-only (branch history) views, which hides the discard button. */
  onDiscard?: () => void
  /** Line selection and inline review comments for this file. */
  commenting?: DiffCommenting
  /** Narrow panel: no counter or copy button, one gutter. */
  narrow?: boolean
  /** Phone: the bar is a file switcher that opens the list. */
  touch?: boolean
  onOpenList?: () => void
}

export function DiffFileCard({ file, index, total, onPrev, onNext, onDiscard, commenting, narrow, touch, onOpenList }: DiffFileCardProps) {
  const totalChanges = file.additions + file.deletions
  const isLarge = totalChanges > LARGE_DIFF_THRESHOLD
  const [expanded, setExpanded] = useState(!isLarge)

  const { dir } = splitPath(file.path)
  const oldDir = file.status === 'renamed' && file.oldPath ? splitPath(file.oldPath).dir : dir
  const folder = oldDir !== dir ? `${oldDir || './'} → ${dir || './'}` : dir
  const commentCount = commenting?.comments.length ?? 0
  const atFirst = index <= 0
  const atLast = index >= total - 1

  const prev = (
    <button className={ICON_BTN} onClick={onPrev} disabled={atFirst} title="Previous file (K)" aria-label="Previous file">
      <IconChevronUp size={touch ? 22 : 18} />
    </button>
  )
  const next = (
    <button className={ICON_BTN} onClick={onNext} disabled={atLast} title="Next file (J)" aria-label="Next file">
      <IconChevronDown size={touch ? 22 : 18} />
    </button>
  )
  const commentBadge = commentCount > 0 && (
    <span className="flex shrink-0 items-center gap-1 text-micro text-ink-muted" title={`${commentCount} comment${commentCount === 1 ? '' : 's'} on this file`}>
      <IconMessage2 size={15} />
      {commentCount}
    </span>
  )
  const discardButton = onDiscard && (
    <button className={`${ICON_BASE} text-error-5 hover:bg-error-11`} onClick={onDiscard} title="Discard this file's changes" aria-label="Discard this file's changes">
      <IconTrash size={16} />
    </button>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {touch ? (
        <div className="flex h-14 shrink-0 items-center gap-2 border-b border-edge bg-surface-raised pl-4 pr-1">
          <StatusChip status={file.status} large />
          <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onOpenList} title={file.path}>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-mono text-title font-bold text-ink">{displayName(file)}</span>
              <span className="block truncate text-meta text-ink-muted">
                {index + 1} of {total} files <Counts file={file} />
              </span>
            </span>
            <IconSelector size={18} className="shrink-0 text-ink-muted" />
          </button>
          {commentBadge}
          {prev}
          {next}
          {discardButton}
        </div>
      ) : (
        <div className="flex shrink-0 items-center gap-2.5 border-b border-edge bg-surface-raised py-2 pl-4 pr-2">
          <StatusChip status={file.status} />
          <div className="min-w-0 flex-1">
            {folder && !narrow && (
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-micro text-ink-faint" title={folder}>{folder}</span>
                {file.uncommitted && <UncommittedPill />}
              </div>
            )}
            <div className="truncate font-mono text-body font-bold text-ink" title={file.path}>{displayName(file)}</div>
          </div>
          {commentBadge}
          <Counts file={file} className="text-meta" />
          {prev}
          {!narrow && <span className="min-w-11 shrink-0 text-center text-micro text-ink-muted">{index + 1} / {total}</span>}
          {next}
          {!narrow && (
            <button className={ICON_BTN} onClick={() => { void navigator.clipboard.writeText(file.path) }} title="Copy path" aria-label="Copy path">
              <IconCopy size={16} />
            </button>
          )}
          {discardButton}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {file.isBinary ? (
          <div className="flex items-center gap-2 px-4 py-3 text-meta italic text-ink-muted">
            <IconFile size={16} />
            Binary file
          </div>
        ) : file.hunks.length === 0 ? (
          <div className="px-4 py-3 text-meta italic text-ink-muted">No changes</div>
        ) : !expanded ? (
          <button className="w-full px-4 py-3 text-left text-meta italic text-ink-muted hover:text-ink" onClick={() => { setExpanded(true) }}>
            Large diff ({totalChanges} lines) — click to expand
          </button>
        ) : (
          <DiffHunkView hunks={file.hunks} commenting={commenting} narrow={narrow || touch} />
        )}
      </div>
    </div>
  )
}

function UncommittedPill() {
  return (
    <span className="shrink-0 rounded bg-warning-10 px-1.5 text-micro text-warning-4" title="This file has changes that are not committed yet">
      uncommitted
    </span>
  )
}
