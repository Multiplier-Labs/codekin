/**
 * RepoDrawer — one home for the three repo-scoped collections (task 08, C).
 *
 * The drawer owns all the chrome: the repo header, the tab strip, the optional
 * filter row, and the single scroll region. `DocsFilePicker`,
 * `ArchivedSessionsList` and `ApprovalsPanel` are content renderers inside it —
 * nothing scrolls independently, and nothing expands inside the sidebar tree
 * any more.
 *
 * Width is set by the host and is user-resizable, so the narrow layout is
 * driven by `@container` width rather than a viewport breakpoint: below 380px
 * the tab labels drop to icons with tooltips.
 *
 * Non-goal: the diff/Changes view never becomes a tab here. It keeps its own
 * panel, header and resize handle.
 */

import { useState, useMemo, useCallback, useEffect } from 'react'
import { IconX, IconFileText, IconArchive, IconShieldCheck, IconSearch } from '@tabler/icons-react'
import { DocsFilePicker } from './DocsFilePicker'
import { ArchivedSessionsList, ArchivedSessionViewer } from './ArchivedSessionsPanel'
import { ApprovalsPanel } from './ApprovalsPanel'

export type RepoDrawerTab = 'docs' | 'archive' | 'approvals'

export interface RepoDrawerProps {
  token: string
  /** Repo the drawer is scoped to; null closes it. */
  workingDir: string | null
  /** Display name for the header (e.g. "codekin"). */
  repoName: string
  open: boolean
  onClose: () => void
  /** Docs tab */
  docsFiles: { path: string; pinned: boolean }[]
  docsLoading: boolean
  starredDocs: string[]
  onSelectDoc: (filePath: string) => void
  onToggleStarDoc?: (filePath: string) => void
  /** Archive tab */
  archiveRefreshKey: number
  /**
   * Notification that a row opened the transcript. The drawer hosts the
   * fullscreen viewer itself, so this is for bookkeeping/deep-link state only —
   * do not mount a second `ArchivedSessionViewer` from it.
   */
  onViewArchivedSession: (id: string) => void
  onNewSessionFromArchive: (workingDir: string, context: string) => void
  /** Font size for any archived-transcript preview. */
  fontSize: number
  /**
   * Deep-link a tab (the sidebar's `⋯` items). Selecting it also makes it the
   * repo's remembered tab. Omit to always reopen on the remembered tab.
   */
  initialTab?: RepoDrawerTab
}

const TAB_STORAGE_PREFIX = 'codekin.repoDrawerTab:'

const TABS: { id: RepoDrawerTab; label: string; icon: typeof IconFileText }[] = [
  { id: 'docs', label: 'Docs', icon: IconFileText },
  { id: 'archive', label: 'Archive', icon: IconArchive },
  { id: 'approvals', label: 'Approvals', icon: IconShieldCheck },
]

function isTab(value: string | null): value is RepoDrawerTab {
  return value === 'docs' || value === 'archive' || value === 'approvals'
}

/** Tab choice is remembered per repo, so each repo reopens where you left it. */
function readStoredTab(workingDir: string | null): RepoDrawerTab {
  if (!workingDir) return 'docs'
  try {
    const stored = localStorage.getItem(TAB_STORAGE_PREFIX + workingDir)
    return isTab(stored) ? stored : 'docs'
  } catch {
    return 'docs'
  }
}

const EMPTY_FILTERS: Record<RepoDrawerTab, string> = { docs: '', archive: '', approvals: '' }

export function RepoDrawer({
  token,
  workingDir,
  repoName,
  open,
  onClose,
  docsFiles,
  docsLoading,
  starredDocs,
  onSelectDoc,
  onToggleStarDoc,
  archiveRefreshKey,
  onViewArchivedSession,
  onNewSessionFromArchive,
  fontSize,
  initialTab,
}: RepoDrawerProps) {
  // Selection lives in state only for repos touched this session; everything
  // else falls back to what localStorage remembers. No effect, no flash.
  const [selected, setSelected] = useState<Record<string, RepoDrawerTab>>({})
  const [viewingId, setViewingId] = useState<string | null>(null)
  // Filter text is per tab, and scoped to the repo it was typed in — switching
  // repos starts clean without an effect.
  const [filters, setFilters] = useState<{ dir: string | null; values: Record<RepoDrawerTab, string> }>(
    { dir: null, values: EMPTY_FILTERS },
  )

  const storedTab = useMemo(() => readStoredTab(workingDir), [workingDir])
  const tab = (workingDir ? selected[workingDir] : undefined) ?? storedTab

  const selectTab = useCallback((next: RepoDrawerTab) => {
    if (!workingDir) return
    setSelected(prev => ({ ...prev, [workingDir]: next }))
    try {
      localStorage.setItem(TAB_STORAGE_PREFIX + workingDir, next)
    } catch {
      /* private mode — the tab just won't be remembered */
    }
  }, [workingDir])

  const setFilter = useCallback((value: string) => {
    setFilters(prev => ({
      dir: workingDir,
      values: { ...(prev.dir === workingDir ? prev.values : EMPTY_FILTERS), [tab]: value },
    }))
  }, [tab, workingDir])

  // A deep link wins over the remembered tab, and becomes the new memory.
  useEffect(() => {
    if (!open || !workingDir || !initialTab) return
    selectTab(initialTab) // eslint-disable-line react-hooks/set-state-in-effect -- deep link from the sidebar
  }, [open, workingDir, initialTab, selectTab])

  // Escape closes the drawer, unless the fullscreen transcript is up — that
  // owns Escape while it is open.
  useEffect(() => {
    if (!open || viewingId) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey) }
  }, [open, viewingId, onClose])

  const handleView = useCallback((id: string) => {
    setViewingId(id)
    onViewArchivedSession(id)
  }, [onViewArchivedSession])

  const handleNewSessionFromArchive = useCallback((dir: string, context: string) => {
    setViewingId(null)
    onNewSessionFromArchive(dir, context)
  }, [onNewSessionFromArchive])

  if (!open || !workingDir) return null

  const filter = filters.dir === workingDir ? filters.values[tab] : ''
  const showFilter = tab === 'docs' ? docsFiles.length > 5 : true

  return (
    <div className="@container flex h-full min-h-0 flex-col border-l border-edge bg-surface">
      {/* Header */}
      <div className="density-row flex flex-shrink-0 items-center gap-2 border-b border-edge px-2">
        <span className="min-w-0 flex-1 truncate text-body font-semibold text-ink" title={workingDir}>
          {repoName}
        </span>
        <button
          onClick={onClose}
          title="Close panel"
          aria-label="Close panel"
          className="tap-target flex-shrink-0 rounded-control p-1 text-ink-faint transition-colors hover:bg-surface-raised hover:text-ink"
        >
          <IconX size={14} stroke={2} />
        </button>
      </div>

      {/* Tabs */}
      <div role="tablist" aria-label="Repo panel" className="flex flex-shrink-0 items-center gap-0.5 border-b border-edge px-1 py-1">
        {TABS.map(({ id, label, icon: Icon }) => {
          const active = id === tab
          return (
            <button
              key={id}
              role="tab"
              id={`repo-drawer-tab-${id}`}
              aria-selected={active}
              aria-controls={`repo-drawer-panel-${id}`}
              onClick={() => { selectTab(id) }}
              title={label}
              className={`density-row flex flex-1 items-center justify-center gap-1.5 rounded-control px-2 text-meta transition-colors ${
                active
                  ? 'bg-surface-raised text-ink'
                  : 'text-ink-muted hover:bg-surface-raised hover:text-ink'
              }`}
            >
              <Icon size={14} stroke={2} className="flex-shrink-0" />
              {/* Labels drop out on a narrow panel, not a narrow viewport */}
              <span className="hidden @[380px]:inline">{label}</span>
            </button>
          )
        })}
      </div>

      {/* Filter row */}
      {showFilter && (
        <div className="flex flex-shrink-0 items-center gap-1.5 border-b border-edge px-2 py-1.5">
          <IconSearch size={13} stroke={2} className="flex-shrink-0 text-ink-faint" />
          <input
            type="text"
            value={filter}
            onChange={e => { setFilter(e.target.value) }}
            placeholder={tab === 'docs' ? 'Filter docs…' : tab === 'archive' ? 'Filter sessions…' : 'Filter approvals…'}
            aria-label="Filter"
            className="min-w-0 flex-1 bg-transparent text-body text-ink placeholder-ink-faint focus:outline-none"
          />
          {filter && (
            <button
              onClick={() => { setFilter('') }}
              title="Clear filter"
              aria-label="Clear filter"
              className="tap-target flex-shrink-0 rounded-control p-0.5 text-ink-faint transition-colors hover:text-ink"
            >
              <IconX size={12} stroke={2} />
            </button>
          )}
        </div>
      )}

      {/* The drawer's one scroll region */}
      <div
        role="tabpanel"
        id={`repo-drawer-panel-${tab}`}
        aria-labelledby={`repo-drawer-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        {tab === 'docs' && (
          <DocsFilePicker
            files={docsFiles}
            loading={docsLoading}
            starredDocs={starredDocs}
            onSelect={onSelectDoc}
            onToggleStar={onToggleStarDoc}
            filter={filter}
          />
        )}
        {tab === 'archive' && (
          <ArchivedSessionsList
            token={token}
            workingDir={workingDir}
            refreshKey={archiveRefreshKey}
            filter={filter}
            onView={handleView}
            onNewSessionFromArchive={handleNewSessionFromArchive}
          />
        )}
        {tab === 'approvals' && (
          <ApprovalsPanel
            token={token}
            workingDir={workingDir}
            filter={filter}
          />
        )}
      </div>

      {/* Fullscreen archived transcript — hosted here, not by the sidebar. */}
      <ArchivedSessionViewer
        token={token}
        sessionId={viewingId}
        fontSize={fontSize}
        onClose={() => { setViewingId(null) }}
        onNewSessionFromArchive={handleNewSessionFromArchive}
      />
    </div>
  )
}
