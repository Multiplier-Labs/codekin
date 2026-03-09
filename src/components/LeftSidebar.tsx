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
  IconChevronRight, IconChevronLeft, IconSparkles,
} from '@tabler/icons-react'
import type { Session, Module, Repo } from '../types'
import type { RepoGroup } from '../hooks/useRepos'
import AppIcon from './AppIcon'
import { NewSessionButton } from './NewSessionButton'
import { RepoSection, type RepoNode } from './RepoSection'
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel'
import { ModuleBrowser } from './ModuleBrowser'

const SIDEBAR_WIDTH_KEY = 'codekin-left-sidebar-width'
const DEFAULT_WIDTH = 224
const MIN_WIDTH = 160
const MAX_WIDTH = 480

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

function groupKey(s: Session): string {
  return s.groupDir ?? s.workingDir
}

function repoDisplayName(workingDir: string): string {
  const parts = workingDir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workingDir
}

function buildRepoNodes(
  sessions: Session[],
  waitingSessions: Record<string, boolean>,
  tentativeQueues: Record<string, string[]>,
): RepoNode[] {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
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
  sessions: Session[]
  activeSessionId: string | null
  activeWorkingDir: string | null
  waitingSessions: Record<string, boolean>
  tentativeQueues: Record<string, string[]>
  groups: RepoGroup[]
  globalModules: Module[]
  activeRepo: Repo | null
  token: string
  theme: string
  fontSize: number
  connState: string
  view: string
  archiveRefreshKey: number
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, name: string) => void
  onNewSession: () => void
  onNewSessionFromArchive: (workingDir: string, context: string) => void
  onOpenSession: (repo: Repo, name?: string) => void
  onSelectRepo: (workingDir: string) => void
  onDeleteRepo: (workingDir: string) => void
  onSettingsOpen: () => void
  onUpdateTheme: (theme: string) => void
  onSendModule: (mod: Module) => void
  onNavigateToWorkflows: () => void
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
}: Props) {
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

  const hasModules = globalModules.length > 0 || (activeRepo && activeRepo.modules.length > 0)

  // --------------------------------------------------------------------------
  // Collapsed strip
  // --------------------------------------------------------------------------

  if (collapsed) {
    return (
      <div className="app-left-sidebar flex flex-col items-center w-12 flex-shrink-0 bg-neutral-11 py-3 gap-3 border-r border-neutral-8/30">
        <div className="app-logo-circle flex items-center justify-center rounded-full" style={{ width: 28, height: 28 }}>
          <AppIcon size={26} className="text-primary-7" />
        </div>
        <button
          onClick={() => setCollapsed(false)}
          className="rounded-lg p-1.5 text-neutral-4 hover:bg-neutral-6 hover:text-neutral-1"
          title="Expand sidebar"
        >
          <IconChevronRight size={14} stroke={2} />
        </button>
        <div className="mt-auto flex flex-col items-center gap-2">
          <button
            onClick={() => onUpdateTheme(theme === 'dark' ? 'light' : 'dark')}
            className="rounded-lg p-1.5 text-neutral-4 hover:bg-neutral-6 hover:text-neutral-1"
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
  // Full sidebar
  // --------------------------------------------------------------------------

  return (
    <div
      className="app-left-sidebar relative flex flex-col flex-shrink-0 bg-neutral-11 border-r border-neutral-8/30 min-h-0"
      style={{ width }}
    >
      {/* Drag handle on right edge */}
      <div
        className="absolute right-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary-7/50 active:bg-primary-6/60 z-10"
        onMouseDown={onDragStart}
      />

      {/* Header: logo + title + collapse + new session */}
      <div className="group/header flex items-center gap-2 px-3 py-2.5 border-b border-neutral-8/30 flex-shrink-0">
        <div className="app-logo-circle flex items-center justify-center rounded-full flex-shrink-0" style={{ width: 26, height: 26 }}>
          <AppIcon size={24} className="text-primary-7" />
        </div>
        <span className="flex-1 text-[17px] font-semibold text-neutral-2 truncate">Codekin</span>
        <button
          onClick={() => setCollapsed(true)}
          className="rounded p-1 text-neutral-5 hover:text-neutral-2 hover:bg-neutral-6 transition-colors flex-shrink-0 opacity-0 group-hover/header:opacity-100"
          title="Collapse sidebar"
        >
          <IconChevronLeft size={16} stroke={2} />
        </button>
        <NewSessionButton groups={groups} token={token} onOpen={onOpenSession} />
      </div>

      {/* Scrollable nav tree */}
      <div className="flex-1 overflow-y-auto py-1 min-h-0">

        {/* Menu items (Slack-style, above repo folders) */}
        <div className="px-2 py-1">
          <button
            onClick={onNavigateToWorkflows}
            className={`w-full flex items-center gap-2 px-2 py-1 rounded-md text-[15px] transition-colors ${
              view === 'workflows'
                ? 'text-accent-3 bg-accent-11/20'
                : 'text-neutral-4 hover:text-neutral-1 hover:bg-neutral-6'
            }`}
          >
            <IconSparkles size={16} stroke={2} className="flex-shrink-0" />
            <span className="flex-1 text-left">AI Workflows</span>
          </button>
          {hasModules && (
            <div ref={modulesRef} className="relative">
              <button
                onClick={() => setModulesOpen(!modulesOpen)}
                className={`w-full flex items-center gap-2 px-2 py-1 rounded-md text-[15px] transition-colors ${
                  modulesOpen
                    ? 'text-accent-3 bg-accent-11/20'
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
            onSelectSession={onSelectSession}
            onDeleteSession={onDeleteSession}
            onRenameSession={onRenameSession}
            onNewSession={node.workingDir === activeWorkingDir ? onNewSession : undefined}
            onSelectRepo={onSelectRepo}
            onDeleteRepo={onDeleteRepo}
            onViewArchivedSession={setArchiveViewSessionId}
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
      <div className="flex items-center gap-0.5 px-2 py-2 border-t border-neutral-8/30 flex-shrink-0">
        <div className="flex items-center justify-center px-1 py-1" title={connState.charAt(0).toUpperCase() + connState.slice(1)}>
          <span className={`inline-block h-2 w-2 rounded-full ${connDotColor}`} />
        </div>
        <button
          onClick={onSettingsOpen}
          className="flex items-center gap-1 rounded px-1.5 py-1 text-[13px] text-neutral-4 hover:text-neutral-1 hover:bg-neutral-6 transition-colors"
          title="Settings"
        >
          <IconSettingsGear size={20} stroke={2} />
        </button>
        <div className="flex-1" />
        <button
          onClick={() => onUpdateTheme(theme === 'dark' ? 'light' : 'dark')}
          className="rounded px-1.5 py-1 text-neutral-4 hover:bg-neutral-6 hover:text-neutral-1 transition-colors"
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {theme === 'dark' ? <IconSun size={20} stroke={2} /> : <IconMoon size={20} stroke={2} />}
        </button>
        <button
          onClick={() => { window.location.href = '/authelia/logout' }}
          className="rounded px-1.5 py-1 text-neutral-4 hover:bg-neutral-6 hover:text-neutral-1 transition-colors"
          title="Logout"
        >
          <IconLogout size={20} stroke={2} />
        </button>
      </div>
    </div>
  )
}

