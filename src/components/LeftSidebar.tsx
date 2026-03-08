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
  IconPlus, IconBook, IconSettings as IconSettingsGear,
  IconLogout, IconSun, IconMoon, IconShieldCheck, IconArchive,
  IconChevronDown, IconChevronRight, IconChevronLeft, IconRobot, IconSparkles, IconPencil,
} from '@tabler/icons-react'
import type { Session, Module, Repo } from '../types'
import type { RepoGroup } from '../hooks/useRepos'
import { listArchivedSessions, type ArchivedSessionInfo } from '../lib/ccApi'
import AppIcon from './AppIcon'
import { NewSessionButton } from './NewSessionButton'

import { ApprovalsPanel } from './ApprovalsPanel'
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel'
import { ModuleBrowser } from './ModuleBrowser'

const SIDEBAR_WIDTH_KEY = 'codekin-left-sidebar-width'
const DEFAULT_WIDTH = 224
const MIN_WIDTH = 160
const MAX_WIDTH = 480

const ARCHIVED_PREVIEW_LIMIT = 5

// --------------------------------------------------------------------------
// Helpers (mirrors SessionBar / SessionListPanel logic)
// --------------------------------------------------------------------------

function groupKey(s: Session): string {
  return s.groupDir ?? s.workingDir
}

function repoDisplayName(workingDir: string): string {
  const parts = workingDir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workingDir
}

function sessionDisplayName(session: Session): string {
  const name = session.name || session.id.slice(0, 8)
  if (name.startsWith('hub:')) return 'new session'
  return name
}

function archivedDisplayName(session: ArchivedSessionInfo): string {
  const name = session.name || session.id.slice(0, 8)
  if (name.startsWith('hub:')) return 'unnamed session'
  return name
}

function compactAge(created: string): string {
  const seconds = Math.floor((Date.now() - new Date(created).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

function parseUtcDate(dateStr: string): Date {
  if (!dateStr.includes('T') && !dateStr.includes('Z') && !dateStr.includes('+')) {
    return new Date(dateStr.replace(' ', 'T') + 'Z')
  }
  return new Date(dateStr)
}

function archivedCompactAge(dateStr: string): string {
  const seconds = Math.floor((Date.now() - parseUtcDate(dateStr).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

interface RepoNode {
  workingDir: string
  displayName: string
  sessions: Session[]
  hasWaiting: boolean
  hasActive: boolean
  hasTentative: boolean
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
  return Array.from(map.entries()).map(([key, repoSessions]) => ({
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

// --------------------------------------------------------------------------
// RepoSection — one collapsible repo tree node
// --------------------------------------------------------------------------

interface RepoSectionProps {
  node: RepoNode
  isActive: boolean
  activeSessionId: string | null
  waitingSessions: Record<string, boolean>
  tentativeQueues: Record<string, string[]>
  token: string
  archiveRefreshKey: number
  onSelectSession: (id: string) => void
  onDeleteSession: (id: string) => void
  onRenameSession: (id: string, name: string) => void
  onNewSession?: () => void
  onSelectRepo: (workingDir: string) => void
  onDeleteRepo: (workingDir: string) => void
  onViewArchivedSession: (id: string) => void
}

function RepoSection({
  node,
  isActive,
  activeSessionId,
  waitingSessions,
  tentativeQueues,
  token,
  archiveRefreshKey,
  onSelectSession,
  onDeleteSession,
  onRenameSession,
  onNewSession,
  onSelectRepo,
  onDeleteRepo,
  onViewArchivedSession,
}: RepoSectionProps) {
  const [expanded, setExpanded] = useState(isActive)
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiveExpanded, setArchiveExpanded] = useState(false)
  const [archivedSessions, setArchivedSessions] = useState<ArchivedSessionInfo[]>([])
  const [editingSessionId, setEditingSessionId] = useState<string | null>(null)
  const [editValue, setEditValue] = useState('')

  // Auto-expand when this repo becomes active
  useEffect(() => {
    if (isActive) setExpanded(true) // eslint-disable-line react-hooks/set-state-in-effect -- sync expansion with external active-repo state
  }, [isActive])

  // Fetch archived sessions when archive section is opened
  useEffect(() => {
    if (!archiveOpen || !token) return
    listArchivedSessions(token, node.workingDir).then(setArchivedSessions).catch(() => {})
  }, [archiveOpen, token, node.workingDir, archiveRefreshKey])

  const statusDot = node.hasTentative
    ? 'bg-accent-6 animate-pulse'
    : node.hasWaiting
    ? 'bg-warning-5 animate-pulse'
    : node.hasActive
    ? 'bg-success-6 animate-pulse'
    : 'bg-neutral-6'

  const visibleArchived = archiveExpanded ? archivedSessions : archivedSessions.slice(0, ARCHIVED_PREVIEW_LIMIT)
  const hasMore = archivedSessions.length > ARCHIVED_PREVIEW_LIMIT

  const startEditing = (s: Session) => {
    setEditingSessionId(s.id)
    setEditValue(sessionDisplayName(s))
  }

  const commitRename = () => {
    if (editingSessionId && editValue.trim()) {
      onRenameSession(editingSessionId, editValue.trim())
    }
    setEditingSessionId(null)
  }

  return (
    <div className="group/repo">
      {/* Repo header row — Slack-style section header */}
      <div className="group flex items-center gap-1.5 px-2 py-1">
        <button
          onClick={() => { setExpanded(!expanded); if (!isActive) onSelectRepo(node.workingDir) }}
          className="flex flex-1 items-center gap-2 min-w-0 rounded px-2 py-0.5 text-left transition-colors text-neutral-4 hover:text-neutral-2"
        >
          {expanded
            ? <IconChevronDown size={14} stroke={2.5} className="flex-shrink-0 text-neutral-5 opacity-0 group-hover/repo:opacity-100 transition-opacity" />
            : <IconChevronRight size={14} stroke={2.5} className="flex-shrink-0 text-neutral-5 opacity-0 group-hover/repo:opacity-100 transition-opacity" />
          }
          <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${statusDot}`} />
          <span className="truncate text-[15px] font-semibold tracking-wide">{node.displayName}</span>
        </button>
        <button
          onClick={() => setApprovalsOpen(!approvalsOpen)}
          className={`flex-shrink-0 rounded p-0.5 transition-colors opacity-0 group-hover:opacity-100 ${
            approvalsOpen ? 'text-primary-5 opacity-100!' : 'text-neutral-5 hover:text-neutral-2'
          }`}
          title="Repo approvals"
        >
          <IconShieldCheck size={16} stroke={2} />
        </button>
        <button
          onClick={() => setArchiveOpen(!archiveOpen)}
          className={`flex-shrink-0 rounded p-0.5 transition-colors opacity-0 group-hover:opacity-100 ${
            archiveOpen ? 'text-primary-5 opacity-100!' : 'text-neutral-5 hover:text-neutral-2'
          }`}
          title="Archived sessions"
        >
          <IconArchive size={16} stroke={2} />
        </button>
        <span
          onClick={e => { e.stopPropagation(); onDeleteRepo(node.workingDir) }}
          className="cursor-pointer text-[15px] text-transparent hover:text-error-5 group-hover:text-neutral-6 flex-shrink-0 px-0.5"
        >
          ×
        </span>
      </div>

      {/* Expanded: session list */}
      {expanded && (
        <div className="px-2 pb-1">
          {node.sessions.map(s => {
            const isActiveSession = s.id === activeSessionId
            const isTentative = (tentativeQueues[s.id]?.length ?? 0) > 0
            const dotColor = isTentative
              ? 'bg-accent-6 animate-pulse'
              : waitingSessions[s.id]
              ? 'bg-warning-5 animate-pulse'
              : s.isProcessing ? 'bg-success-6 animate-pulse' : s.active ? 'bg-neutral-5' : 'bg-neutral-7'
            const isEditing = editingSessionId === s.id

            return (
              <div
                key={s.id}
                onClick={() => { if (!isEditing) onSelectSession(s.id) }}
                className={`group w-full flex items-center gap-2 pl-10 pr-2 py-1 text-left text-[15px] transition-colors rounded-md cursor-pointer ${
                  isActiveSession
                    ? 'bg-accent-9/30 text-accent-2'
                    : 'text-neutral-3 hover:bg-neutral-6/50 hover:text-neutral-1'
                }`}
              >
                {s.source === 'workflow'
                  ? <IconSparkles size={12} className={`flex-shrink-0 ${dotColor.replace(/bg-/g, 'text-')}`} />
                  : s.source === 'webhook'
                  ? <IconRobot size={12} className={`flex-shrink-0 ${dotColor.replace(/bg-/g, 'text-')}`} />
                  : <span className="inline-flex items-center justify-center w-[12px] flex-shrink-0"><span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} /></span>
                }
                {isEditing ? (
                  <input
                    autoFocus
                    value={editValue}
                    onChange={e => setEditValue(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={e => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditingSessionId(null)
                    }}
                    onClick={e => e.stopPropagation()}
                    className="flex-1 min-w-0 bg-neutral-10 border border-neutral-7 rounded px-1 py-0 text-[15px] text-neutral-1 outline-none focus:border-primary-6"
                  />
                ) : (
                  <span className="flex-1 truncate">{sessionDisplayName(s)}</span>
                )}
                {!isEditing && (
                  <>
                    <span className="text-[13px] text-neutral-6 tabular-nums flex-shrink-0">{compactAge(s.created)}</span>
                    <span
                      onClick={e => { e.stopPropagation(); startEditing(s) }}
                      className="cursor-pointer flex-shrink-0 text-transparent group-hover:text-neutral-6 hover:text-neutral-2! transition-colors"
                      title="Rename session"
                    >
                      <IconPencil size={13} stroke={2} />
                    </span>
                    <span
                      onClick={e => { e.stopPropagation(); onDeleteSession(s.id) }}
                      className="cursor-pointer text-[15px] text-transparent hover:text-error-5 group-hover:text-neutral-6 flex-shrink-0"
                    >
                      ×
                    </span>
                  </>
                )}
              </div>
            )
          })}

          {/* New session for this repo (visible on hover) */}
          {onNewSession && (
            <div className="pl-10 opacity-0 group-hover/repo:opacity-100">
              <button
                onClick={onNewSession}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[13px] text-neutral-5 hover:text-neutral-2 hover:bg-neutral-6/50 transition-colors"
              >
                <IconPlus size={12} stroke={2} className="flex-shrink-0" />
                <span>New session</span>
              </button>
            </div>
          )}

          {/* Inline approvals */}
          {approvalsOpen && (
            <div className="mt-1 border-t border-neutral-8/30">
              <ApprovalsPanel
                token={token}
                workingDir={node.workingDir}
                visible={approvalsOpen}
              />
            </div>
          )}

          {/* Inline archived sessions */}
          {archiveOpen && (
            <div className="mt-1 border-t border-neutral-8/30 pt-1">
              {archivedSessions.length === 0 ? (
                <div className="pl-12 pr-2 py-1 text-[13px] text-neutral-5">No archived sessions</div>
              ) : (
                <>
                  {visibleArchived.map(s => (
                    <button
                      key={s.id}
                      onClick={() => onViewArchivedSession(s.id)}
                      className="group w-full flex items-center gap-2 pl-12 pr-2 py-0.5 text-left text-[15px] text-neutral-4 hover:bg-neutral-6/50 hover:text-neutral-2 transition-colors"
                    >
                      <IconArchive size={12} className="flex-shrink-0 opacity-40" />
                      <span className="flex-1 truncate">{archivedDisplayName(s)}</span>
                      <span className="shrink-0 text-[13px] text-neutral-6 tabular-nums">{archivedCompactAge(s.archivedAt)}</span>
                    </button>
                  ))}
                  {hasMore && !archiveExpanded && (
                    <button
                      onClick={() => setArchiveExpanded(true)}
                      className="w-full pl-12 pr-2 py-0.5 text-left text-[13px] text-neutral-5 hover:text-neutral-2 transition-colors"
                    >
                      Show all {archivedSessions.length} archived...
                    </button>
                  )}
                  {archiveExpanded && hasMore && (
                    <button
                      onClick={() => setArchiveExpanded(false)}
                      className="w-full pl-12 pr-2 py-0.5 text-left text-[13px] text-neutral-5 hover:text-neutral-2 transition-colors"
                    >
                      Show less
                    </button>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
