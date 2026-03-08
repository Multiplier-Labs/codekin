/**
 * Persistent right sidebar for the session terminal view.
 *
 * Hosts the sessions list, task panel, repo approvals settings,
 * and archived sessions browser.
 * Can be collapsed/expanded via a toggle button, and resized by dragging.
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { IconChevronRight, IconChevronLeft, IconShieldCheck, IconArchive } from '@tabler/icons-react'
import type { Session } from '../types'
import { ApprovalsPanel } from './ApprovalsPanel'
import { ArchivedSessionsPanel } from './ArchivedSessionsPanel'
import { SessionListPanel } from './SessionListPanel'

const SIDEBAR_WIDTH_KEY = 'codekin-sidebar-width'
const DEFAULT_WIDTH = 260
const MIN_WIDTH = 180
const MAX_WIDTH = 600

interface Props {
  sessions: Session[]
  activeSessionId: string | null
  waitingSessions: Record<string, boolean>
  tentativeQueues?: Record<string, string[]>
  token: string
  workingDir: string | null
  fontSize: number
  archiveRefreshKey?: number
  onSelectSession: (sessionId: string) => void
  onDeleteSession: (sessionId: string) => void
  onNewSession: () => void
  onNewSessionFromArchive?: (workingDir: string, context: string) => void
}

export function RightSidebar({
  sessions,
  activeSessionId,
  waitingSessions,
  tentativeQueues,
  token,
  workingDir,
  fontSize,
  archiveRefreshKey,
  onSelectSession,
  onDeleteSession,
  onNewSession,
  onNewSessionFromArchive,
}: Props) {
  const [collapsed, setCollapsed] = useState(() => {
    const stored = localStorage.getItem('codekin-sidebar-collapsed')
    return stored === 'true'
  })
  const [approvalsOpen, setApprovalsOpen] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [width, setWidth] = useState(() => {
    const stored = localStorage.getItem(SIDEBAR_WIDTH_KEY)
    return stored ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Number(stored))) : DEFAULT_WIDTH
  })
  const dragging = useRef(false)
  const startX = useRef(0)
  const startWidth = useRef(0)

  useEffect(() => {
    localStorage.setItem('codekin-sidebar-collapsed', String(collapsed))
  }, [collapsed])

  useEffect(() => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(width))
  }, [width])

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    dragging.current = true
    startX.current = e.clientX
    startWidth.current = width

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current) return
      // Dragging left edge leftward = increasing width, so subtract delta
      const delta = ev.clientX - startX.current
      const newWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, startWidth.current - delta))
      setWidth(newWidth)
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

  const toggleCollapsed = useCallback(() => {
    setCollapsed(prev => !prev)
  }, [])

  if (collapsed) {
    return (
      <div className="app-right-sidebar flex flex-col items-center w-10 flex-shrink-0 bg-neutral-8/40 border-l border-neutral-8/40 py-2 gap-2">
        {/* Vertical label */}
        <span
          className="text-[12px] text-neutral-5 tracking-widest"
          style={{ writingMode: 'vertical-rl' }}
        >
          SIDEBAR
        </span>
        <button
          onClick={toggleCollapsed}
          className="mt-auto rounded p-1 text-neutral-4 hover:text-neutral-2 hover:bg-neutral-8 transition-colors"
          title="Expand sidebar"
        >
          <IconChevronLeft size={16} stroke={2} />
        </button>
      </div>
    )
  }

  return (
    <div
      className="app-right-sidebar relative flex flex-col flex-shrink-0 bg-neutral-8/40 border-l border-neutral-8/40 min-h-0"
      style={{ width }}
    >
      {/* Drag handle on the left edge */}
      <div
        className="absolute left-0 top-0 bottom-0 w-1 cursor-col-resize hover:bg-primary-7/50 active:bg-primary-6/60 z-10"
        onMouseDown={onDragStart}
      />
      {/* Sessions */}
      <SessionListPanel
        sessions={sessions}
        activeSessionId={activeSessionId}
        waitingSessions={waitingSessions}
        tentativeQueues={tentativeQueues}
        onSelect={onSelectSession}
        onDelete={onDeleteSession}
        onNew={onNewSession}
      />

      <div className="h-1.5" />

      {/* Approvals */}
      <ApprovalsPanel
        token={token}
        workingDir={workingDir}
        visible={approvalsOpen}
      />

      {/* Archived sessions */}
      <ArchivedSessionsPanel
        token={token}
        visible={archiveOpen}
        fontSize={fontSize}
        workingDir={workingDir}
        refreshKey={archiveRefreshKey}
        onNewSessionFromArchive={onNewSessionFromArchive}
      />

      {/* Bottom toolbar */}
      <div className="mt-auto flex items-center justify-between px-2 py-1.5 border-t border-neutral-8/50 flex-shrink-0">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setApprovalsOpen(!approvalsOpen)}
            className={`flex items-center gap-1 rounded px-1.5 py-1 text-[13px] transition-colors ${
              approvalsOpen
                ? 'text-primary-5 bg-primary-10/30'
                : 'text-neutral-3 hover:text-neutral-1 hover:bg-neutral-8'
            }`}
            title="Repo approvals"
          >
            <IconShieldCheck size={14} stroke={2} />
            <span>Settings</span>
          </button>
          <button
            onClick={() => setArchiveOpen(!archiveOpen)}
            className={`flex items-center gap-1 rounded px-1.5 py-1 text-[13px] transition-colors ${
              archiveOpen
                ? 'text-primary-5 bg-primary-10/30'
                : 'text-neutral-3 hover:text-neutral-1 hover:bg-neutral-8'
            }`}
            title="Archived sessions"
          >
            <IconArchive size={14} stroke={2} />
            <span>Archive</span>
          </button>
        </div>
        <button
          onClick={toggleCollapsed}
          className="rounded p-1 text-neutral-3 hover:text-neutral-1 hover:bg-neutral-8 transition-colors"
          title="Collapse sidebar"
        >
          <IconChevronRight size={16} stroke={2} />
        </button>
      </div>
    </div>
  )
}
