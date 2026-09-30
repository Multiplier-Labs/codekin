/**
 * Right sidebar panel showing the file changes of the current session.
 *
 * Top to bottom: header (one refresh for the diff and the PR), the view and
 * branch/base context, the PR row, then a pinned, resizable file list and
 * below it the diff of one file at a time, with previous/next and J/K to move
 * between files. Narrow panels (under 420px) stack and trim; on phones the
 * panel is a full-screen sheet and the list folds into a file switcher.
 */

import { useState, useCallback, useRef, useEffect, useMemo } from 'react'
import { IconX, IconRefresh, IconChevronDown, IconChevronRight, IconSearch, IconTrash } from '@tabler/icons-react'
import type { DiffFile, DiffView, WsClientMessage, WsServerMessage } from '../types'
import { isDiscardableView, useDiff } from '../hooks/useDiff'
import { usePrStatus } from '../hooks/usePrStatus'
import { useReviewComments } from '../hooks/useReviewComments'
import { ReviewCommentsTray } from './diff/ReviewCommentsTray'
import type { DiffCommenting } from './diff/DiffHunkView'
import { PrStatusCard } from './diff/PrStatusCard'
import { DiffToolbar } from './diff/DiffToolbar'
import { DiffFileTree } from './diff/DiffFileTree'
import { DiffFileCard } from './diff/DiffFileCard'
import { DiffEmpty, DiffError, DiffLoading } from './diff/DiffStates'
import { DiscardConfirm } from './diff/DiscardConfirm'
import { groupOrder } from './diff/diffFiles'
import { getPref, setPref } from '../lib/prefs'

const MIN_WIDTH = 280
const MAX_WIDTH = 1200
// Wide enough for the full layout; below NARROW_WIDTH it stacks and trims.
const DEFAULT_WIDTH = 505
/** Below this panel width the layout stacks and trims. */
const NARROW_WIDTH = 420
const MIN_LIST_HEIGHT = 96
const MAX_LIST_HEIGHT = 520
const DEFAULT_LIST_HEIGHT = 232

const ICON_BTN = 'density-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink'

type Confirm = null | { kind: 'all' } | { kind: 'file'; path: string }

interface DiffPanelProps {
  isOpen: boolean
  onClose: () => void
  send: (msg: WsClientMessage) => void
  /** Register callback so parent can forward diff_result/diff_error/pr_status messages. */
  onHandleMessage: (fn: (msg: WsServerMessage) => void) => void
  /** Register callback so parent can forward tool_done events. */
  onHandleToolDone: (fn: (toolName: string, summary?: string) => void) => void
  /** Register callback so parent can signal the end of an agent turn. */
  onHandleTurnDone: (fn: () => void) => void
  /** Session shown; results for other sessions are ignored. */
  sessionId: string | null
  /** View each session opens on ('branch' for isolated sessions). */
  defaultView: DiffView
  /** Phone/touch: full-screen sheet with a file switcher instead of the pinned list. */
  isMobile?: boolean
}

function matchesFilter(file: DiffFile, query: string): boolean {
  return file.path.toLowerCase().includes(query) || !!file.oldPath?.toLowerCase().includes(query)
}

export function DiffPanel({ isOpen, onClose, send, onHandleMessage, onHandleToolDone, onHandleTurnDone, sessionId, defaultView, isMobile = false }: DiffPanelProps) {
  const [width, setWidth] = useState(() => {
    const stored = getPref('diffPanelWidth')
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, stored)) : DEFAULT_WIDTH
  })
  const [listHeight, setListHeight] = useState(() => {
    const stored = getPref('diffListHeight')
    return stored ? Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, stored)) : DEFAULT_LIST_HEIGHT
  })

  const diff = useDiff({ send, isOpen, sessionId, defaultView })
  const pr = usePrStatus({ send, isOpen, sessionId })
  const { handleMessage: diffHandleMessage, handleTurnDone: diffTurnDone, refresh: refreshDiff, changeScope } = diff
  const { handleMessage: prHandleMessage, refresh: refreshPr } = pr
  const review = useReviewComments({ send, isOpen, sessionId })
  const { handleMessage: reviewHandleMessage } = review

  /** Active file per session; a missing or stale entry falls back to the first file. */
  const [activeBySession, setActiveBySession] = useState<Record<string, string>>({})
  const [listOpen, setListOpen] = useState(true)
  const [filter, setFilter] = useState('')
  const [confirm, setConfirm] = useState<Confirm>(null)
  const [narrow, setNarrow] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  /** Sessions whose list was already folded away for review drafts. */
  const autoCollapsed = useRef(new Set<string>())
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  // Register message forwarding callbacks with parent
  const handleMessage = useCallback((msg: WsServerMessage) => {
    diffHandleMessage(msg)
    prHandleMessage(msg)
    reviewHandleMessage(msg)
  }, [diffHandleMessage, prHandleMessage, reviewHandleMessage])
  useEffect(() => {
    onHandleMessage(handleMessage)
  }, [handleMessage, onHandleMessage])

  useEffect(() => {
    onHandleToolDone(diff.handleToolDone)
  }, [diff.handleToolDone, onHandleToolDone])

  const handleTurnDone = useCallback(() => {
    diffTurnDone()
    refreshPr()
  }, [diffTurnDone, refreshPr])
  useEffect(() => {
    onHandleTurnDone(handleTurnDone)
  }, [handleTurnDone, onHandleTurnDone])

  // A PR lookup can change the automatic review base (its base branch wins
  // over the worktree's). Re-diff when the base the server would now pick
  // differs from the one shown; the user's explicit choice is never touched.
  const prBase = (() => {
    const open = pr.status?.state === 'found' ? pr.status.pulls.filter(p => p.state === 'OPEN' && !p.isCrossRepository) : []
    return open.length === 1 ? open[0].baseRefName : null
  })()
  const shownBase = diff.review?.baseRef.replace(/^origin\//, '') ?? null
  const shownSource = diff.review?.baseSource
  useEffect(() => {
    if (!shownSource || shownSource === 'user') return
    if ((prBase && prBase !== shownBase) || (!prBase && shownSource === 'pr')) refreshDiff()
  }, [prBase, shownBase, shownSource, refreshDiff])

  // Persist sizes
  useEffect(() => {
    setPref('diffPanelWidth', width)
  }, [width])
  useEffect(() => {
    setPref('diffListHeight', listHeight)
  }, [listHeight])

  // Narrow layout follows the panel's own width, not the viewport's.
  useEffect(() => {
    const el = rootRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => { setNarrow(entry.contentRect.width < NARROW_WIDTH) })
    ro.observe(el)
    return () => { ro.disconnect() }
  }, [isOpen])

  // A pending confirmation never carries over to another session or view.
  useEffect(() => {
    setConfirm(null) // eslint-disable-line react-hooks/set-state-in-effect -- reset on session/view switch
    setSheetOpen(false)
  }, [sessionId, diff.scope])

  // Fold the list away the first time review drafts appear in a session, so
  // the diff and the comments tray get the room; the user can reopen it.
  const hasDrafts = review.comments.some(c => c.status === 'draft')
  useEffect(() => {
    if (!hasDrafts || !sessionId || autoCollapsed.current.has(sessionId)) return
    autoCollapsed.current.add(sessionId)
    setListOpen(false) // eslint-disable-line react-hooks/set-state-in-effect -- one-time fold when drafts appear
  }, [hasDrafts, sessionId])

  const ordered = useMemo(() => groupOrder(diff.files), [diff.files])
  const query = filter.trim().toLowerCase()
  const listed = query ? ordered.filter(f => matchesFilter(f, query)) : ordered
  const sessionKey = sessionId ?? ''
  const wanted = activeBySession[sessionKey] as string | undefined
  const foundIndex = ordered.findIndex(f => f.path === wanted)
  const activeIndex = foundIndex < 0 ? 0 : foundIndex
  const active = ordered.at(activeIndex) ?? null

  const selectFile = useCallback((path: string) => {
    setActiveBySession(m => ({ ...m, [sessionKey]: path }))
  }, [sessionKey])

  const step = (delta: number) => {
    const next = ordered.at(activeIndex + delta)
    if (next && activeIndex + delta >= 0) selectFile(next.path)
  }
  // The key handler reads the latest `step` without re-registering each render.
  const stepRef = useRef(step)
  useEffect(() => { stepRef.current = step })

  /** Switching view starts again at the first file; the filter is kept. */
  const changeView = useCallback((view: DiffView) => {
    setActiveBySession(m => ({ ...m, [sessionKey]: '' }))
    changeScope(view)
  }, [sessionKey, changeScope])

  const refreshAll = useCallback(() => {
    refreshDiff()
    refreshPr(true)
  }, [refreshDiff, refreshPr])

  // Resize drag handler
  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      // Dragging left edge means decreasing clientX = increasing width
      const delta = startX.current - ev.clientX
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta)))
    }
    const onMouseUp = () => {
      dragging.current = false
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.body.style.cursor = 'col-resize'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [width])

  // Divider between the file list and the diff: drags the list's height.
  const onListDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startY = e.clientY
    // Start from what is on screen: a short list is smaller than its stored height.
    const startHeight = listRef.current?.getBoundingClientRect().height ?? listHeight
    const onMouseMove = (ev: MouseEvent) => {
      setListHeight(Math.round(Math.max(MIN_LIST_HEIGHT, Math.min(MAX_LIST_HEIGHT, startHeight + ev.clientY - startY))))
    }
    const onMouseUp = () => {
      document.body.style.cursor = ''
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
    }
    document.body.style.cursor = 'row-resize'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [listHeight])

  // Keyboard: Escape backs out of the file sheet or a confirmation before it
  // closes the panel; J/K move between files unless the user is typing.
  useEffect(() => {
    if (!isOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (sheetOpen) setSheetOpen(false)
        else if (confirm) setConfirm(null)
        else onClose()
        return
      }
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return
      if (e.key !== 'j' && e.key !== 'k') return
      const target = e.target
      if (target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select'))) return
      e.preventDefault()
      stepRef.current(e.key === 'j' ? 1 : -1)
    }
    document.addEventListener('keydown', handler)
    return () => { document.removeEventListener('keydown', handler) }
  }, [isOpen, onClose, sheetOpen, confirm])

  if (!isOpen) return null

  const canDiscard = isDiscardableView(diff.scope)
  const compact = narrow || isMobile
  const viewComments = review.comments.filter(c => c.anchor.view === diff.scope)
  const commentsOn = (file: DiffFile) => viewComments.filter(c => c.anchor.path === file.path || c.anchor.path === file.oldPath)
  const filesWithComments = diff.files.filter(f => commentsOn(f).length > 0).length

  /** Line selection and inline comments for one file in the current view. */
  const commentingFor = (file: DiffFile): DiffCommenting | undefined => {
    if (diff.error || file.isBinary) return undefined
    return {
      comments: commentsOn(file),
      onAdd: (range, body) => {
        review.add({
          // Removed lines of a renamed file live under its old path in the base.
          path: range.side === 'old' && file.oldPath ? file.oldPath : file.path,
          ...range,
          view: diff.scope,
          baseCommit: diff.review?.mergeBase,
          headCommit: diff.review?.head,
          body,
        })
      },
      onUpdate: review.update,
      onDelete: review.remove,
    }
  }

  const confirmFiles = confirm?.kind === 'all'
    ? diff.files
    : confirm?.kind === 'file' ? diff.files.filter(f => f.path === confirm.path) : []
  const runDiscard = () => {
    if (confirm?.kind === 'all') diff.discard()
    else if (confirm?.kind === 'file' && confirmFiles[0]) diff.discard([confirm.path], { [confirm.path]: confirmFiles[0].status })
    setConfirm(null)
  }

  const spinning = diff.loading || pr.loading
  const hasFiles = diff.files.length > 0
  const fileCount = diff.summary.filesChanged || diff.files.length

  const filterInput = (
    <label className="mx-4 mb-2 flex h-8 shrink-0 items-center gap-2 rounded-control border border-edge bg-page px-2.5 focus-within:border-focus">
      <IconSearch size={15} className="shrink-0 text-ink-faint" />
      <input
        className="min-w-0 flex-1 bg-transparent text-meta text-ink placeholder:text-ink-faint focus:outline-none"
        placeholder="Filter files"
        aria-label="Filter files"
        value={filter}
        onChange={(e) => { setFilter(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Escape' && filter) { e.stopPropagation(); setFilter('') } }}
      />
    </label>
  )
  const noMatch = query && listed.length === 0 && (
    <p className="px-4 py-2 text-meta text-ink-faint">No files match “{filter.trim()}”.</p>
  )

  const listHeader = (
    <div className="flex shrink-0 items-center gap-2 py-1.5 pl-2.5 pr-2">
      <button
        className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-control px-1 text-left text-ink"
        onClick={() => { setListOpen(!listOpen) }}
        aria-expanded={listOpen}
        title={listOpen ? 'Hide the file list' : 'Show the file list'}
      >
        {listOpen ? <IconChevronDown size={16} className="shrink-0" /> : <IconChevronRight size={16} className="shrink-0" />}
        <span className="shrink-0 text-meta font-bold">{fileCount} file{fileCount === 1 ? '' : 's'}</span>
        {!!diff.summary.uncommittedFiles && (
          <span className="flex min-w-0 items-center gap-1.5 text-micro text-warning-5" title="Files with changes that are not committed yet">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-warning-5" />
            <span className="truncate">{diff.summary.uncommittedFiles} uncommitted</span>
          </span>
        )}
        {filesWithComments > 0 && (
          <span className="truncate text-micro text-ink-muted">· {filesWithComments} with comments</span>
        )}
      </button>
      <span className="shrink-0 whitespace-nowrap pr-2 text-meta">
        <span className="text-success-5">+{diff.summary.insertions}</span>{' '}
        <span className="text-error-5">&minus;{diff.summary.deletions}</span>
      </span>
      {canDiscard && (
        <button
          className="density-row flex h-8 shrink-0 items-center gap-1 rounded-control px-2 text-meta text-error-5 hover:bg-error-11"
          onClick={() => { setConfirm({ kind: 'all' }) }}
          title="Discard all changes in this view"
        >
          <IconTrash size={16} />
          {!compact && 'Discard all'}
        </button>
      )}
    </div>
  )

  const activeCard = active && (
    <DiffFileCard
      key={active.path}
      file={active}
      index={activeIndex}
      total={ordered.length}
      onPrev={() => { step(-1) }}
      onNext={() => { step(1) }}
      onDiscard={canDiscard ? () => { setConfirm({ kind: 'file', path: active.path }) } : undefined}
      commenting={commentingFor(active)}
      narrow={narrow}
      touch={isMobile}
      onOpenList={() => { setSheetOpen(true) }}
    />
  )

  let fileArea: React.ReactNode
  if (diff.error) {
    fileArea = <div className="min-h-0 flex-1 overflow-y-auto"><DiffError message={diff.error} onRetry={diff.refresh} /></div>
  } else if (!hasFiles) {
    fileArea = diff.loading
      ? <div className="min-h-0 flex-1 overflow-y-auto"><DiffLoading /></div>
      : <DiffEmpty view={diff.scope} onShowBranch={() => { changeView('branch') }} />
  } else if (isMobile) {
    fileArea = (
      <div className="relative flex min-h-0 flex-1 flex-col">
        {activeCard}
        {sheetOpen && (
          <div className="absolute inset-0 z-30 flex flex-col bg-surface" role="dialog" aria-label="Changed files">
            <div className="flex shrink-0 items-center gap-2 border-b border-edge py-1 pl-4 pr-1">
              <span className="flex-1 text-meta font-bold text-ink">{fileCount} file{fileCount === 1 ? '' : 's'}</span>
              <span className="whitespace-nowrap text-meta">
                <span className="text-success-5">+{diff.summary.insertions}</span>{' '}
                <span className="text-error-5">&minus;{diff.summary.deletions}</span>
              </span>
              {canDiscard && (
                <button
                  className="density-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-error-5 hover:bg-error-11"
                  onClick={() => { setSheetOpen(false); setConfirm({ kind: 'all' }) }}
                  title="Discard all changes in this view"
                  aria-label="Discard all changes in this view"
                >
                  <IconTrash size={20} />
                </button>
              )}
              <button className={ICON_BTN} onClick={() => { setSheetOpen(false) }} title="Close file list" aria-label="Close file list">
                <IconX size={20} />
              </button>
            </div>
            <div className="pt-2">{filterInput}</div>
            <div className="min-h-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
              {noMatch}
              <DiffFileTree files={listed} activeFile={active?.path ?? null} onSelectFile={(p) => { selectFile(p); setSheetOpen(false) }} narrow />
            </div>
          </div>
        )}
      </div>
    )
  } else {
    fileArea = (
      <>
        {listHeader}
        {listOpen && (
          <>
            {filterInput}
            <div ref={listRef} className="shrink-0 overflow-y-auto" style={{ maxHeight: listHeight }}>
              {noMatch}
              <DiffFileTree files={listed} activeFile={active?.path ?? null} onSelectFile={selectFile} narrow={narrow} />
            </div>
            <div
              className="group flex h-[9px] shrink-0 cursor-row-resize items-center justify-center border-t border-edge hover:bg-surface-raised"
              onMouseDown={onListDragStart}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize file list"
              title="Drag to resize the file list"
            >
              <span className="h-[3px] w-9 rounded-full bg-edge-strong" />
            </div>
          </>
        )}
        <div className="flex min-h-0 flex-1 flex-col border-t border-edge">{activeCard}</div>
      </>
    )
  }

  return (
    <div
      ref={rootRef}
      className={`changes-panel flex flex-col bg-surface overflow-hidden ${
        isMobile ? 'fixed inset-0 z-40 pt-[env(safe-area-inset-top)]' : 'relative h-full border-l border-edge transition-[width] duration-150'
      }`}
      style={isMobile ? undefined : { width, minWidth: MIN_WIDTH, maxWidth: MAX_WIDTH }}
    >
      {/* Resize handle */}
      {!isMobile && (
        <div
          className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary-6/40 z-20"
          onMouseDown={onDragStart}
        />
      )}

      {/* Panel header */}
      <div className="flex shrink-0 items-center gap-2.5 border-b border-edge py-2.5 pl-4 pr-2">
        {diff.summary.filesChanged > 0 && (
          <span className="h-2 w-2 shrink-0 rounded-full bg-success-5" />
        )}
        <h2 className="flex-1 text-title font-bold text-ink">Changes</h2>
        <button
          className={ICON_BTN}
          onClick={refreshAll}
          disabled={spinning}
          title="Refresh changes and pull request status"
          aria-label="Refresh"
        >
          <IconRefresh size={isMobile ? 22 : 18} className={spinning ? 'animate-spin' : ''} />
        </button>
        <button className={ICON_BTN} onClick={onClose} title="Close (Esc)" aria-label="Close">
          <IconX size={isMobile ? 22 : 18} />
        </button>
      </div>

      <DiffToolbar
        branch={diff.branch}
        scope={diff.scope}
        summary={diff.summary}
        review={diff.review}
        narrow={compact}
        onScopeChange={changeView}
        onReviewBaseChange={diff.changeReviewBase}
      />

      {confirm && confirmFiles.length > 0 && (
        <DiscardConfirm files={confirmFiles} single={confirm.kind === 'file'} onCancel={() => { setConfirm(null) }} onConfirm={runDiscard} />
      )}

      <PrStatusCard key={sessionId ?? 'none'} status={pr.status} narrow={compact} />

      {diff.summary.truncated && (
        <div className="shrink-0 border-b border-edge bg-warning-11 px-4 py-2 text-micro text-warning-5" title={diff.summary.truncationReason}>
          Diff truncated — showing partial results
        </div>
      )}
      {diff.incomplete.length > 0 && (
        <div className="shrink-0 border-b border-edge bg-warning-11 px-4 py-2 text-micro text-warning-5" role="status">
          {diff.incomplete.map(note => <p key={note}>{note}</p>)}
        </div>
      )}

      {fileArea}

      <ReviewCommentsTray
        comments={review.comments}
        view={diff.scope}
        sending={review.sending}
        error={review.error}
        hasFiles={diff.files.some(f => !f.isBinary && f.hunks.length > 0)}
        hint={isMobile ? 'touch' : narrow ? 'short' : 'full'}
        onSend={review.sendToAgent}
        onDelete={review.remove}
        onSelectFile={(path) => { selectFile(diff.files.find(f => f.path === path || f.oldPath === path)?.path ?? path) }}
        onDismissError={review.clearError}
      />
    </div>
  )
}
