/**
 * Left sidebar — repo-centric navigation tree.
 *
 * Shows all repos that have active sessions as collapsible tree nodes.
 * The active repo is expanded and shows its sessions and a Workflows link.
 * Bottom section: app settings, theme toggle, logout, connection status.
 * Resizable via drag handle on the right edge; collapsible to icon-only strip.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  IconBook, IconSettings as IconSettingsGear,
  IconLogout, IconSun, IconMoon,
  IconChevronRight, IconChevronLeft, IconSparkles, IconX, IconRobotFace,
} from '@tabler/icons-react'
import type { Session, Module, Repo, DocsPickerProps, MobileProps } from '../types'
import type { RepoGroup } from '../hooks/useRepos'
import AppIcon from './AppIcon'
import { NewSessionButton } from './NewSessionButton'
import { RepoSection, type RepoNode } from './RepoSection'
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel'
import { ModuleBrowser } from './ModuleBrowser'
import { groupKey } from '../hooks/useSessionOrchestration'

const SIDEBAR_WIDTH_KEY = 'codekin-left-sidebar-width'
const DEFAULT_WIDTH = 224
const MIN_WIDTH = 160
const MAX_WIDTH = 480

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function repoDisplayName(workingDir: string): string {
  const parts = workingDir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workingDir
}

function buildRepoNodes(
  sessions: Session[],
  waitingSessions: Record<string, boolean>,
  tentativeQueues: Record<string, { text: string; files: File[] }[]>,
): RepoNode[] {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
    if (s.source === 'shepherd') continue
    const key = groupKey(s)
    const list = map.get(key) ?? []
    list.push(s)
    map.set(key, list)
  }
  return Array.from(map.entries()).sort((a, b) => {
    const nameA = a[0].replace(/\/+$/, '').split('/').pop() ?? a[0]
    const nameB = b[0].replace(/\/+$/, '').split('/').pop() ?? b[0]
    return nameA.localeCompare(nameB)
  }).map(([key, repoSessions]) => ({
    workingDir: key,
    displayName: repoDisplayName(key),
    sessions: repoSessions,
    hasWaiting: repoSessions.some(s => waitingSessions[s.id]),
    hasActive: repoSessions.some(s => s.isProcessing),
    hasTentative: repoSessions.some(s => (tentativeQueues[s.id]?.length ?? 0) > 0),
  }))
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

interface Props {
  /** All known sessions across all repos. */
  sessions: Session[]
  /** Currently selected session (highlighted in the tree). */
  activeSessionId: string | null
  /** Working directory of the currently selected session/repo. */
  activeWorkingDir: string | null
  /** Session IDs that have a pending prompt awaiting user response. */
  waitingSessions: Record<string, boolean>
  /** Per-session tentative message queues (held while another session is processing). */
  tentativeQueues: Record<string, { text: string; files: File[] }[]>
  /** Repo groups from the API, used for the repo selector dropdown. */
  groups: RepoGroup[]
  /** Global modules available across all repos (shown in module browser). */
  globalModules: Module[]
  /** The Repo object for the currently active working directory. */
  activeRepo: Repo | null
  /** Auth token for API requests (file uploads, repo fetches). */
  token: string
  /** Current color theme ('dark' | 'light'). */
  theme: string
  /** User-configured font size in pixels. */
  fontSize: number
  /** WebSocket connection state ('disconnected' | 'connecting' | 'connected'). */
  connState: string
  /** Current route view ('chat' | 'workflows'). */
  view: string
  /** Incremented to force re-fetch of archived sessions. */
  archiveRefreshKey: number
  /** Switch the active session to the given ID. */
  onSelectSession: (id: string) => void
  /** Delete a session by ID (with confirmation). */
  onDeleteSession: (id: string) => void
  /** Rename a session in the sidebar tree. */
  onRenameSession: (id: string, name: string) => void
  /** Create a new session in the active repo. */
  onNewSession: () => void
  /** Create a new session seeded with context from an archived session. */
  onNewSessionFromArchive: (workingDir: string, context: string) => void
  /** Open (or create) a session for a specific repo, optionally with a name. */
  onOpenSession: (repo: Repo, name?: string) => void
  /** Switch the active repo (expands its tree node). */
  onSelectRepo: (workingDir: string) => void
  /** Remove a repo from the sidebar (does not delete the git repo). */
  onDeleteRepo: (workingDir: string) => void
  /** Open the settings modal. */
  onSettingsOpen: () => void
  /** Toggle or set the color theme. */
  onUpdateTheme: (theme: string) => void
  /** Send a module's content to the active session as context. */
  onSendModule: (mod: Module) => void
  /** Navigate to the workflows view. */
  onNavigateToWorkflows: () => void
  /** Navigate to the Shepherd orchestrator view. */
  onNavigateToShepherd: () => void
  /** Open the docs browser for a repo's documentation files. */
  onBrowseDocs?: (workingDir: string) => void
  /** State and callbacks for the docs file picker overlay. */
  docsPicker?: DocsPickerProps
  /** Mobile-specific layout props (drawer mode). */
  mobile?: MobileProps
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

/** Repo-centric navigation sidebar with session tree, module browser, archive access, and app controls. Resizable and collapsible. */
export function LeftSidebar({
  sessions,
  activeSessionId,
  activeWorkingDir,
  waitingSessions,
  tentativeQueues,
  groups,
  globalModules,
  activeRepo,
  token,
  theme,
  fontSize,
  connState,
  view,
  archiveRefreshKey,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onNewSession,
  onNewSessionFromArchive,
  onOpenSession,
  onSelectRepo,
  onDeleteRepo,
  onSettingsOpen,
  onUpdateTheme,
  onSendModule,
  onNavigateToWorkflows,
  onNavigateToShepherd,
  onBrowseDocs,
  docsPicker = {},
  mobile = {},
}: Props) {
  const { isMobile = false, mobileOpen = false, onMobileClose } = mobile
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('codekin-left-sidebar-collapsed') === 'true')
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(stored))) : DEFAULT_WIDTH
  })
  const [modulesOpen, setModulesOpen] = useState(false)
  const [archiveViewSessionId, setArchiveViewSessionId] = useState<string | null>(null)
  const modulesRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  useEffect(() => {
    localStorage.setItem('codekin-left-sidebar-collapsed', String(collapsed))
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
  }, [width])

  // Close modules popover on outside click
  useEffect(() => {
    if (!modulesOpen) return
    function handleClick(e: MouseEvent) {
      if (modulesRef.current && !modulesRef.current.contains(e.target as Node)) {
        setModulesOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [modulesOpen])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      const delta = ev.clientX - startX.current
      setWidth(Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current + delta)))
    }
    const onMouseUp = () => {
      dragging.current = false
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
  }, [width])

  const repoNodes = buildRepoNodes(sessions, waitingSessions, tentativeQueues)
  const connDotColor = connState === 'connected' ? 'bg-success-7' : connState === 'connecting' ? 'bg-warning-6' : 'bg-error-7'

  // Derive Agent Joe icon style from its session state
  const joeSession = sessions.find(s => s.source === 'shepherd')
  const joeIconClass = joeSession
    ? (tentativeQueues[joeSession.id]?.length ?? 0) > 0
      ? '!text-accent-5 animate-pulse'
      : waitingSessions[joeSession.id]
      ? '!text-warning-5 animate-pulse'
      : joeSession.isProcessing
      ? '!text-success-6 animate-pulse'
      : joeSession.active
      ? '!text-neutral-5'
      : ''
    : ''
  const hasModules = globalModules.length > 0 || (activeRepo && activeRepo.modules.length > 0)

  // In mobile mode, auto-close the drawer when a session is selected
  const handleSelectSessionMobile = useCallback((id: string) => {
    onSelectSession(id)
    if (isMobile) onMobileClose?.()
  }, [onSelectSession, isMobile, onMobileClose])

  // --------------------------------------------------------------------------
  // Collapsed strip (desktop only — hidden on mobile)
  // --------------------------------------------------------------------------

  if (!isMobile && collapsed) {
    return (
      <div className="app-left-sidebar flex flex-col items-center w-12 flex-shrink-0 bg-neutral-12 py-3 gap-3 border-r border-neutral-8/30">
        <div className="app-logo-circle flex items-center justify-center rounded-full" style={{ width: 28, height: 28 }}>
          <AppIcon size={26} className="text-primary-7" />
        </div>
        <button
          onClick={() => setCollapsed(false)}
          className="rounded-lg p-1.5 text-neutral-3 hover:bg-neutral-6 hover:text-neutral-1"
          title="Expand sidebar"
        >
          <IconChevronRight size={14} stroke={2} />
        </button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            onClick={() => onUpdateTheme(theme === 'dark' ? 'light' : 'dark')}
            className="rounded-lg p-1.5 text-neutral-3 hover:bg-neutral-6 hover:text-neutral-1"
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <IconSun size={14} stroke={2} /> : <IconMoon size={14} stroke={2} />}
          </button>
          <div title={connState.charAt(0).toUpperCase() + connState.slice(1)}>
            <span className={`inline-block h-2 w-2 rounded-full ${connDotColor}`} />
          </div>
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // Full sidebar content (shared between desktop inline and mobile drawer)
  // --------------------------------------------------------------------------

  const sidebarContent = (
    <div
      className={`app-left-sidebar relative flex flex-col bg-neutral-12 min-h-0 h-full ${
        isMobile ? 'w-[280px] max-w-[85vw]' : 'flex-shrink-0 border-r border-neutral-8/30'
      }`}
      style={isMobile ? undefined : { width }}
    >
      {/* Drag handle on right edge — desktop only */}
      {!isMobile && (
        <div
          className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary-7/50 active:bg-primary-6/60 z-10"
          onMouseDown={onDragStart}
        />
      )}

      {/* Header: logo + title + collapse + new session */}
      <div className="group/header flex items-center gap-2 px-3 py-2.5 border-b border-neutral-8/30 flex-shrink-0">
        <div className="app-logo-circle flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 26, height: 26 }}>
          <AppIcon size={24} className="text-primary-7" />
        </div>
        <span className="flex-1 text-[17px] font-semibold text-neutral-2 truncate">Codekin</span>
        {isMobile ? (
          <button
            onClick={onMobileClose}
            className="rounded p-1 text-neutral-3 hover:text-neutral-2 hover:bg-neutral-6 transition-colors flex-shrink-0"
            title="Close menu"
          >
            <IconX size={18} stroke={2} />
          </button>
        ) : (
          <button
            onClick={() => setCollapsed(true)}
            className="rounded p-1 text-neutral-3 hover:text-neutral-2 hover:bg-neutral-6 transition-colors flex-shrink-0 opacity-0 group-hover/header:opacity-100"
            title="Collapse sidebar"
          >
            <IconChevronLeft size={16} stroke={2} />
          </button>
        )}
        <NewSessionButton groups={groups} token={token} onOpen={(repo) => { onOpenSession(repo); if (isMobile) onMobileClose?.() }} />
      </div>

      {/* Scrollable nav tree */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">

        {/* Menu items (Slack-style, above repo folders) */}
        <div className="px-2 py-1">
          <button
            onClick={() => { onNavigateToWorkflows(); if (isMobile) onMobileClose?.() }}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[15px] transition-colors ${
              view === 'workflows'
                ? 'bg-accent-9/30 text-accent-2'
                : 'text-neutral-3 hover:text-neutral-1 hover:bg-neutral-6'
            }`}
          >
            <IconSparkles size={16} stroke={2} className="flex-shrink-0" />
            <span className="flex-1 text-left">AI Workflows</span>
          </button>
          <button
            onClick={() => { onNavigateToShepherd(); if (isMobile) onMobileClose?.() }}
            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[15px] transition-colors ${
              view === 'shepherd'
                ? 'bg-accent-9/30 text-accent-2'
                : 'text-neutral-3 hover:text-neutral-1 hover:bg-neutral-6'
            }`}
          >
            <IconRobotFace size={16} stroke={2} className={`flex-shrink-0 ${joeIconClass}`} />
            <span className="flex-1 text-left">Agent Joe</span>
          </button>
          {hasModules && (
            <div ref={modulesRef} className="relative">
              <button
                onClick={() => setModulesOpen(!modulesOpen)}
                className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[15px] transition-colors ${
                  modulesOpen
                    ? 'bg-accent-9/30 text-accent-2'
                    : 'text-neutral-3 hover:text-neutral-1 hover:bg-neutral-6/50'
                }`}
              >
                <IconBook size={16} stroke={2} className="flex-shrink-0" />
                <span className="flex-1">Modules</span>
              </button>
              {modulesOpen && (
                <div className="absolute left-full top-0 ml-1 w-64 z-50 rounded-md border border-neutral-10 bg-neutral-12 px-3 pb-3 shadow-lg">
                  <ModuleBrowser
                    repo={activeRepo}
                    globalModules={globalModules}
                    onSendModule={(mod) => { onSendModule(mod); setModulesOpen(false) }}
                    disabled={!activeSessionId}
                  />
                </div>
              )}
            </div>
          )}
        </div>

        {/* Divider between menu items and repo folders */}
        <div className="mx-3 my-1 border-t border-neutral-8/40" />

        {/* Section label for active sessions */}
        {repoNodes.length > 0 && (
          <div className="px-4 pt-1.5 pb-0.5 text-[11px] font-medium uppercase tracking-wider text-neutral-6">
            Active sessions
          </div>
        )}

        {/* Repo nodes */}
        {repoNodes.map(node => (
          <RepoSection
            key={node.workingDir}
            node={node}
            isActive={node.workingDir === activeWorkingDir}
            activeSessionId={activeSessionId}
            waitingSessions={waitingSessions}
            tentativeQueues={tentativeQueues}
            token={token}
            archiveRefreshKey={archiveRefreshKey}
            onSelectSession={handleSelectSessionMobile}
            onDeleteSession={onDeleteSession}
            onRenameSession={onRenameSession}
            onNewSession={node.workingDir === activeWorkingDir ? onNewSession : undefined}
            onSelectRepo={(wd) => { onSelectRepo(wd); if (isMobile) onMobileClose?.() }}
            onDeleteRepo={onDeleteRepo}
            onViewArchivedSession={setArchiveViewSessionId}
            onBrowseDocs={onBrowseDocs}
            docsPickerOpen={docsPicker.open}
            docsPickerRepoDir={docsPicker.repoDir}
            docsPickerFiles={docsPicker.files}
            docsPickerLoading={docsPicker.loading}
            onDocsPickerSelect={docsPicker.onSelect}
            onDocsPickerClose={docsPicker.onClose}
            docsStarredDocs={docsPicker.starredDocs}
            isMobile={isMobile}
          />
        ))}

        {/* Empty state */}
        {repoNodes.length === 0 && (
          <div className="px-4 py-6 text-center text-[13px] text-neutral-5">
            No sessions yet.<br />Click + to start one.
          </div>
        )}

        {/* Archive viewer (triggered from repo sections) */}
        <ArchivedSessionsPanel
          token={token}
          visible={archiveViewSessionId !== null}
          fontSize={fontSize}
          workingDir={activeWorkingDir}
          refreshKey={archiveRefreshKey}
          onNewSessionFromArchive={onNewSessionFromArchive}
          initialViewId={archiveViewSessionId}
          onClose={() => setArchiveViewSessionId(null)}
        />
      </div>

      {/* Bottom toolbar */}
      <div className="flex flex-col border-t border-neutral-8/30 flex-shrink-0">
        <div className={`flex items-center gap-0.5 px-2 ${isMobile ? 'gap-1 py-3' : 'py-2'}`}>
          <div className="flex items-center justify-center px-1 py-1" title={connState.charAt(0).toUpperCase() + connState.slice(1)}>
            <span className={`inline-block h-2 w-2 rounded-full ${connDotColor}`} />
          </div>
          <button
            onClick={onSettingsOpen}
            className={`flex items-center gap-1 rounded text-[13px] text-neutral-3 hover:text-neutral-1 hover:bg-neutral-6 transition-colors ${isMobile ? 'px-2 py-2' : 'px-1.5 py-1'}`}
            title="Settings"
          >
            <IconSettingsGear size={isMobile ? 24 : 20} stroke={2} />
          </button>
          <div className="flex-1" />
          <button
            onClick={() => onUpdateTheme(theme === 'dark' ? 'light' : 'dark')}
            className={`rounded text-neutral-3 hover:bg-neutral-6 hover:text-neutral-1 transition-colors ${isMobile ? 'px-2 py-2' : 'px-1.5 py-1'}`}
            title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {theme === 'dark' ? <IconSun size={isMobile ? 24 : 20} stroke={2} /> : <IconMoon size={isMobile ? 24 : 20} stroke={2} />}
          </button>
          <button
            onClick={() => { window.location.href = '/authelia/logout' }}
            className={`rounded text-neutral-3 hover:bg-neutral-6 hover:text-neutral-1 transition-colors ${isMobile ? 'px-2 py-2' : 'px-1.5 py-1'}`}
            title="Logout"
          >
            <IconLogout size={isMobile ? 24 : 20} stroke={2} />
          </button>
        </div>
      </div>
    </div>
  )

  // --------------------------------------------------------------------------
  // Mobile: render as overlay drawer
  // --------------------------------------------------------------------------

  if (isMobile) {
    return (
      <div
        className={`fixed inset-0 z-40 transition-colors duration-200 ${mobileOpen ? 'bg-black/50' : 'bg-transparent pointer-events-none'}`}
        onClick={onMobileClose}
      >
        <div
          className={`h-full w-fit transition-transform duration-200 ease-out ${mobileOpen ? 'translate-x-0' : '-translate-x-full'}`}
          onClick={e => e.stopPropagation()}
        >
          {sidebarContent}
        </div>
      </div>
    )
  }

  // --------------------------------------------------------------------------
  // Desktop: render inline
  // --------------------------------------------------------------------------

  return sidebarContent
}

