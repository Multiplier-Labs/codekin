/**
 * RepoSection — one collapsible repo tree node in the left sidebar.
 *
 * Shows sessions for a single repo with inline editing, archive preview,
 * and approvals panel. Extracted from LeftSidebar to reduce file size.
 */

import { useState, useEffect } from 'react'
import {
  IconPlus, IconShieldCheck, IconArchive, IconFileText,
  IconChevronDown, IconChevronRight, IconRobot, IconSparkles, IconPencil,
} from '@tabler/icons-react'
import type { Session } from '../types'
import { listArchivedSessions, type ArchivedSessionInfo } from '../lib/ccApi'
import { ApprovalsPanel } from './ApprovalsPanel'
import { DocsFilePicker } from './DocsFilePicker'

const ARCHIVED_PREVIEW_LIMIT = 5

// --------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------

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

// --------------------------------------------------------------------------
// Types
// --------------------------------------------------------------------------

export interface RepoNode {
  workingDir: string
  displayName: string
  sessions: Session[]
  hasWaiting: boolean
  hasActive: boolean
  hasTentative: boolean
}

export interface RepoSectionProps {
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
  onBrowseDocs?: (workingDir: string) => void
  docsPickerOpen?: boolean
  docsPickerRepoDir?: string | null
  docsPickerFiles?: { path: string; pinned: boolean }[]
  docsPickerLoading?: boolean
  onDocsPickerSelect?: (filePath: string) => void
  onDocsPickerClose?: () => void
  docsStarredDocs?: string[]
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export function RepoSection({
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
  onBrowseDocs,
  docsPickerOpen,
  docsPickerRepoDir,
  docsPickerFiles,
  docsPickerLoading,
  onDocsPickerSelect,
  onDocsPickerClose,
  docsStarredDocs,
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
          className="flex flex-1 items-center gap-2 min-w-0 rounded px-2 py-0.5 text-left transition-colors text-neutral-3 hover:text-neutral-2"
        >
          {expanded
            ? <IconChevronDown size={14} stroke={2.5} className="flex-shrink-0 text-neutral-5 opacity-0 group-hover/repo:opacity-100 transition-opacity" />
            : <IconChevronRight size={14} stroke={2.5} className="flex-shrink-0 text-neutral-5 opacity-0 group-hover/repo:opacity-100 transition-opacity" />
          }
          <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${statusDot}`} />
          <span className="truncate text-[15px] font-semibold tracking-wide">{node.displayName}</span>
          {!expanded && node.sessions.length > 1 && (
            <span className="text-[12px] text-neutral-6 flex-shrink-0">({node.sessions.length})</span>
          )}
        </button>
        {onBrowseDocs && (
          <button
            onClick={(e) => { e.stopPropagation(); onBrowseDocs(node.workingDir) }}
            className={`flex-shrink-0 rounded p-0.5 transition-colors opacity-0 group-hover:opacity-100 ${
              docsPickerOpen && docsPickerRepoDir === node.workingDir ? 'text-primary-5 opacity-100!' : 'text-neutral-5 hover:text-neutral-2'
            }`}
            title="Browse docs"
          >
            <IconFileText size={14} stroke={2} />
          </button>
        )}
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
                className={`group w-full flex items-baseline gap-2 pl-10 pr-2 py-1 text-left text-[15px] transition-colors rounded-md cursor-pointer ${
                  isActiveSession
                    ? 'bg-accent-9/30 text-accent-2'
                    : 'text-neutral-3 hover:bg-neutral-6/50 hover:text-neutral-1'
                }`}
              >
                {s.source === 'workflow'
                  ? <IconSparkles size={12} className={`flex-shrink-0 self-center ${dotColor.replace(/bg-/g, 'text-')}`} />
                  : s.source === 'webhook'
                  ? <IconRobot size={12} className={`flex-shrink-0 self-center ${dotColor.replace(/bg-/g, 'text-')}`} />
                  : <span className="inline-flex items-center justify-center w-[12px] flex-shrink-0 self-center"><span className={`inline-block h-1.5 w-1.5 rounded-full ${dotColor}`} /></span>
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
                  <span className="flex-1 truncate font-normal">{sessionDisplayName(s)}</span>
                )}
                {!isEditing && (
                  <>
                    <span className="text-[13px] text-neutral-6 tabular-nums flex-shrink-0">{compactAge(s.created)}</span>
                    <span
                      onClick={e => { e.stopPropagation(); startEditing(s) }}
                      className="cursor-pointer flex-shrink-0 text-transparent group-hover:text-neutral-5 hover:text-neutral-2! transition-colors"
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

          {/* Inline docs picker */}
          {docsPickerOpen && docsPickerRepoDir === node.workingDir && onDocsPickerSelect && onDocsPickerClose && (
            <DocsFilePicker
              files={docsPickerFiles ?? []}
              loading={docsPickerLoading ?? false}
              starredDocs={docsStarredDocs ?? []}
              onSelect={onDocsPickerSelect}
              onClose={onDocsPickerClose}
            />
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
                      className="group w-full flex items-baseline gap-2 pl-12 pr-2 py-0.5 text-left text-[15px] text-neutral-4 hover:bg-neutral-6/50 hover:text-neutral-2 transition-colors"
                    >
                      <IconArchive size={12} className="flex-shrink-0 self-center opacity-40" />
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
