/**
 * Archived sessions — the Archive tab's content renderer plus the fullscreen
 * transcript viewer.
 *
 * `ArchivedSessionsList` is pure content: no header, no retention control, no
 * scroll container. `RepoDrawer` owns those. Each row is two lines (title, then
 * age / turns / worktree / source) and carries the two actions that matter:
 * "Continue in new session" inline, and delete behind the row's `⋯` menu.
 *
 * `ArchivedSessionViewer` is the fullscreen read-only transcript. It is kept
 * because opening an archived session is still useful — it is just no longer
 * the only way to continue from one.
 */

import { useState, useEffect, useCallback } from 'react'
import { IconArchive, IconTrash, IconRobot, IconRobotFace, IconTimeline, IconX, IconLoader2, IconMessagePlus, IconGitBranch } from '@tabler/icons-react'
import { listArchivedSessions, getArchivedSession, deleteArchivedSession, type ArchivedSessionInfo, type ArchivedSessionFull } from '../lib/ccApi'
import { rebuildFromHistory } from '../hooks/useChatSocket'
import { ChatView } from './ChatView'
import { RowMenu } from './RowMenu'
import type { ChatMessage } from '../types'

function parseUtcDate(dateStr: string): Date {
  // SQLite datetime('now') returns 'YYYY-MM-DD HH:MM:SS' without timezone — treat as UTC.
  // New format uses ISO 8601 'YYYY-MM-DDTHH:MM:SSZ' which is unambiguous.
  if (!dateStr.includes('T') && !dateStr.includes('Z') && !dateStr.includes('+')) {
    return new Date(dateStr.replace(' ', 'T') + 'Z')
  }
  return new Date(dateStr)
}

function compactAge(dateStr: string): string {
  const seconds = Math.floor((Date.now() - parseUtcDate(dateStr).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function displayName(session: ArchivedSessionInfo): string {
  const name = session.name || session.id.slice(0, 8)
  if (name.startsWith('hub:')) return 'unnamed session'
  return name
}

/** A worktree session's workingDir differs from its canonical repo root. */
function worktreeName(session: ArchivedSessionInfo): string | null {
  if (!session.groupDir || session.groupDir === session.workingDir) return null
  return session.workingDir.split('/').pop() ?? null
}

function SourceIcon({ source, size = 12 }: { source: string; size?: number }) {
  if (source === 'workflow') return <IconTimeline size={size} className="shrink-0 opacity-50" />
  if (source === 'joe' || source === 'agent') return <IconRobotFace size={size} className="shrink-0 opacity-50" />
  if (source === 'webhook') return <IconRobot size={size} className="shrink-0 opacity-50" />
  return <IconArchive size={size} className="shrink-0 opacity-50" />
}

/** Build a text summary of messages for context in a new session. */
function buildContextSummary(messages: ChatMessage[], sessionName: string): string {
  const parts: string[] = []
  parts.push(`Here is the conversation from a previous session "${sessionName}" for context:\n`)
  for (const msg of messages) {
    if (msg.type === 'user') {
      parts.push(`**User:** ${msg.text}`)
    } else if (msg.type === 'assistant') {
      parts.push(`**Assistant:** ${msg.text}`)
    }
  }
  parts.push('\n---\nPlease continue from where this conversation left off. What would you like to work on?')
  return parts.join('\n\n')
}

/* ── Archive tab content ────────────────────────────────────────── */

interface ListProps {
  token: string
  /** Repo to scope the list to. */
  workingDir: string | null
  /** Bump to force a reload. */
  refreshKey?: number
  /** Filter text owned by the drawer's filter row. */
  filter?: string
  /** Open the fullscreen transcript for this archived session. */
  onView: (id: string) => void
  /** Start a fresh session seeded with the archived transcript. */
  onNewSessionFromArchive?: (workingDir: string, context: string) => void
}

export function ArchivedSessionsList({ token, workingDir, refreshKey, filter = '', onView, onNewSessionFromArchive }: ListProps) {
  const [sessions, setSessions] = useState<ArchivedSessionInfo[]>([])
  const [loading, setLoading] = useState(true)
  const [continuingId, setContinuingId] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return
    let cancelled = false
    setLoading(true) // eslint-disable-line react-hooks/set-state-in-effect -- data fetching
    listArchivedSessions(token, workingDir ?? undefined)
      .then(list => { if (!cancelled) setSessions(list) })
      .catch((err: unknown) => {
        console.error('Failed to load archived sessions:', err)
        if (!cancelled) setSessions([])
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [token, workingDir, refreshKey])

  const handleDelete = useCallback((id: string) => {
    deleteArchivedSession(token, id)
      .then(() => { setSessions(prev => prev.filter(s => s.id !== id)) })
      .catch((err: unknown) => { console.error('Failed to delete archived session:', err) })
  }, [token])

  const handleContinue = useCallback((session: ArchivedSessionInfo) => {
    if (!onNewSessionFromArchive) return
    setContinuingId(session.id)
    getArchivedSession(token, session.id)
      .then(full => {
        const context = buildContextSummary(rebuildFromHistory(full.outputHistory), displayName(full))
        // Prefer the canonical repo root: a worktree session's workingDir points
        // at a now-deleted path that matches no live repo.
        onNewSessionFromArchive(full.groupDir ?? full.workingDir, context)
      })
      .catch((err: unknown) => { console.error('Failed to load archived session:', err) })
      .finally(() => { setContinuingId(null) })
  }, [token, onNewSessionFromArchive])

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <IconLoader2 size={16} className="animate-spin text-ink-muted" />
      </div>
    )
  }

  if (sessions.length === 0) {
    return (
      <EmptyState
        title="Nothing archived yet"
        body="Closing a session archives it here with its full transcript, so you can read it back or continue from it later."
      />
    )
  }

  const needle = filter.trim().toLowerCase()
  const visible = needle ? sessions.filter(s => displayName(s).toLowerCase().includes(needle)) : sessions

  if (visible.length === 0) {
    return <EmptyState title="No matching sessions" body={`No archived session matches "${filter.trim()}".`} />
  }

  return (
    <div className="flex flex-col py-1">
      {visible.map(s => {
        const title = displayName(s)
        const wt = worktreeName(s)
        return (
          <div
            key={s.id}
            className="group flex items-start gap-1 rounded-control px-1 py-1 transition-colors hover:bg-surface-raised"
          >
            <button
              onClick={() => { onView(s.id) }}
              title={`Open transcript — ${title}`}
              className="min-w-0 flex-1 rounded-control px-1 py-0.5 text-left"
            >
              <span className="flex items-center gap-1.5">
                <SourceIcon source={s.source} />
                <span className="truncate text-body text-ink">{title}</span>
              </span>
              <span className="mt-0.5 flex items-center gap-1.5 pl-5 text-micro text-ink-faint">
                <span className="tabular-nums">{compactAge(s.archivedAt)} ago</span>
                <span aria-hidden="true">·</span>
                <span className="tabular-nums">{s.messageCount} turn{s.messageCount === 1 ? '' : 's'}</span>
                {wt && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="flex min-w-0 items-center gap-0.5">
                      <IconGitBranch size={10} className="shrink-0" />
                      <span className="truncate font-mono">{wt}</span>
                    </span>
                  </>
                )}
              </span>
            </button>
            {onNewSessionFromArchive && (
              <button
                onClick={() => { handleContinue(s) }}
                disabled={continuingId === s.id}
                title="Continue in new session"
                className="tap-target flex shrink-0 items-center gap-1 rounded-control px-1.5 py-1 text-meta text-ink-faint transition-colors hover:bg-primary-10/40 hover:text-primary-4 disabled:opacity-50"
              >
                {continuingId === s.id
                  ? <IconLoader2 size={14} className="animate-spin" />
                  : <IconMessagePlus size={14} stroke={2} />}
                <span className="hidden @[380px]:inline">Continue</span>
              </button>
            )}
            <RowMenu
              label={`Actions for ${title}`}
              items={[{
                label: 'Delete permanently',
                icon: <IconTrash size={14} />,
                danger: true,
                onSelect: () => {
                  if (window.confirm(`Delete the archived session "${title}"? This cannot be undone.`)) {
                    handleDelete(s.id)
                  }
                },
              }]}
            />
          </div>
        )
      })}
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="px-4 py-8 text-center">
      <p className="text-body font-medium text-ink-muted">{title}</p>
      <p className="mt-1 text-meta text-ink-faint">{body}</p>
    </div>
  )
}

/* ── Fullscreen transcript viewer ───────────────────────────────── */

interface ViewerProps {
  token: string
  /** Archived session to show; null renders nothing. */
  sessionId: string | null
  fontSize: number
  onClose: () => void
  onNewSessionFromArchive?: (workingDir: string, context: string) => void
}

export function ArchivedSessionViewer({ token, sessionId, fontSize, onClose, onNewSessionFromArchive }: ViewerProps) {
  const [viewing, setViewing] = useState<ArchivedSessionFull | null>(null)
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!sessionId || !token) {
      setViewing(null) // eslint-disable-line react-hooks/set-state-in-effect -- reset on close
      return
    }
    let cancelled = false
    setLoading(true)
    getArchivedSession(token, sessionId)
      .then(full => { if (!cancelled) setViewing(full) })
      .catch((err: unknown) => { console.error('Failed to load archived session:', err) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [sessionId, token])

  useEffect(() => {
    if (!sessionId) return
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleKey)
    return () => { document.removeEventListener('keydown', handleKey) }
  }, [sessionId, onClose])

  const handleNewFromContext = useCallback(() => {
    if (!viewing || !onNewSessionFromArchive) return
    const context = buildContextSummary(rebuildFromHistory(viewing.outputHistory), displayName(viewing))
    onNewSessionFromArchive(viewing.groupDir ?? viewing.workingDir, context)
    onClose()
  }, [viewing, onNewSessionFromArchive, onClose])

  if (!sessionId) return null

  if (loading && !viewing) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-page">
        <IconLoader2 size={24} className="animate-spin text-ink-muted" />
      </div>
    )
  }

  if (!viewing) return null

  const messages = rebuildFromHistory(viewing.outputHistory)

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-page">
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-edge bg-surface px-4 py-2">
        <IconArchive size={16} className="text-ink-muted" />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-body font-medium text-ink">{displayName(viewing)}</span>
          <span className="text-meta text-ink-muted">
            Archived {compactAge(viewing.archivedAt)} ago &middot; {viewing.messageCount} turns
          </span>
        </div>
        {onNewSessionFromArchive && (
          <button
            onClick={handleNewFromContext}
            className="flex items-center gap-1.5 rounded-control bg-primary-10/30 px-2.5 py-1.5 text-body font-medium text-primary-4 transition-colors hover:bg-primary-9/40 hover:text-primary-3"
            title="Start a new session with this conversation as context"
          >
            <IconMessagePlus size={16} stroke={2} />
            <span>Continue in new session</span>
          </button>
        )}
        <button
          onClick={onClose}
          className="tap-target rounded-control p-1 text-ink-muted transition-colors hover:bg-surface-raised hover:text-ink"
          title="Close"
        >
          <IconX size={16} stroke={2} />
        </button>
      </div>
      <div className="flex flex-1 flex-col overflow-hidden">
        <ChatView
          messages={messages}
          fontSize={fontSize}
          planningMode={false}
          activityLabel={undefined}
        />
      </div>
    </div>
  )
}
