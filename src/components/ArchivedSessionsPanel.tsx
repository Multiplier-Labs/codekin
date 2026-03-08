/**
 * Panel showing archived (previously closed) sessions.
 *
 * Can be used in two modes:
 * 1. List mode: shows all archived sessions with a list UI (visible=true, no initialViewId)
 * 2. Direct view mode: opens a specific archived session fullscreen (visible=true, initialViewId set)
 */

import { useState, useEffect, useCallback } from 'react'
import { IconArchive, IconTrash, IconRobot, IconTimeline, IconX, IconLoader2, IconMessagePlus } from '@tabler/icons-react'
import { listArchivedSessions, getArchivedSession, deleteArchivedSession, getRetentionDays, setRetentionDays as setRetentionDaysApi, type ArchivedSessionInfo, type ArchivedSessionFull } from '../lib/ccApi'
import { rebuildFromHistory } from '../hooks/useChatSocket'
import { ChatView } from './ChatView'
import type { ChatMessage } from '../types'

interface Props {
  token: string
  visible: boolean
  fontSize: number
  workingDir?: string | null
  refreshKey?: number
  onNewSessionFromArchive?: (workingDir: string, context: string) => void
  /** If provided, immediately open this archived session in fullscreen viewer */
  initialViewId?: string | null
  /** Called when the fullscreen viewer is closed (for direct view mode) */
  onClose?: () => void
}

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

export function ArchivedSessionsPanel({ token, visible, fontSize, workingDir, refreshKey, onNewSessionFromArchive, initialViewId, onClose }: Props) {
  const [sessions, setSessions] = useState<ArchivedSessionInfo[]>([])
  const [viewing, setViewing] = useState<ArchivedSessionFull | null>(null)
  const [loading, setLoading] = useState(false)
  const [retentionDays, setRetentionDays] = useState(7)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const [list, days] = await Promise.all([
        listArchivedSessions(token, workingDir ?? undefined),
        getRetentionDays(token),
      ])
      setSessions(list)
      setRetentionDays(days)
    } catch (err) {
      console.error('Failed to load archived sessions:', err)
    }
  }, [token, workingDir])

  // List mode: refresh when visible without initialViewId
  useEffect(() => {
    if (visible && !initialViewId) refresh()
  }, [visible, initialViewId, refresh, refreshKey])

  // Direct view mode: auto-load the specified session
  useEffect(() => {
    if (!visible || !initialViewId || !token) return
    setLoading(true)
    getArchivedSession(token, initialViewId)
      .then(setViewing)
      .catch(err => console.error('Failed to load archived session:', err))
      .finally(() => setLoading(false))
  }, [visible, initialViewId, token])

  const handleView = useCallback(async (id: string) => {
    setLoading(true)
    try {
      const full = await getArchivedSession(token, id)
      setViewing(full)
    } catch (err) {
      console.error('Failed to load archived session:', err)
    } finally {
      setLoading(false)
    }
  }, [token])

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    try {
      await deleteArchivedSession(token, id)
      setSessions(prev => prev.filter(s => s.id !== id))
      if (viewing?.id === id) setViewing(null)
    } catch (err) {
      console.error('Failed to delete archived session:', err)
    }
  }, [token, viewing])

  const handleRetentionChange = useCallback(async (days: number) => {
    try {
      const actual = await setRetentionDaysApi(token, days)
      setRetentionDays(actual)
    } catch (err) {
      console.error('Failed to update retention:', err)
    }
  }, [token])

  const handleNewFromContext = useCallback(() => {
    if (!viewing || !onNewSessionFromArchive) return
    const messages = rebuildFromHistory(viewing.outputHistory)
    const context = buildContextSummary(messages, displayName(viewing))
    onNewSessionFromArchive(viewing.workingDir, context)
    setViewing(null)
    onClose?.()
  }, [viewing, onNewSessionFromArchive, onClose])

  const handleCloseViewer = useCallback(() => {
    setViewing(null)
    onClose?.()
  }, [onClose])

  if (!visible) return null

  // Loading state for direct view mode
  if (initialViewId && loading && !viewing) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-neutral-12">
        <IconLoader2 size={24} className="text-neutral-4 animate-spin" />
      </div>
    )
  }

  // Full-screen overlay for viewing an archived session
  if (viewing) {
    const messages = rebuildFromHistory(viewing.outputHistory)
    return (
      <div className="fixed inset-0 z-50 flex flex-col bg-neutral-12">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-2 bg-neutral-9/70 border-b border-neutral-8/40 flex-shrink-0">
          <IconArchive size={16} className="text-neutral-4" />
          <div className="flex-1 min-w-0">
            <span className="text-[15px] font-medium text-neutral-1 truncate block">{displayName(viewing)}</span>
            <span className="text-[13px] text-neutral-5">
              Archived {compactAge(viewing.archivedAt)} ago &middot; {viewing.messageCount} messages
            </span>
          </div>
          {onNewSessionFromArchive && (
            <button
              onClick={handleNewFromContext}
              className="flex items-center gap-1.5 rounded px-2.5 py-1.5 text-[13px] font-medium text-primary-4 bg-primary-10/30 hover:bg-primary-9/40 hover:text-primary-3 transition-colors"
              title="Start a new session with this conversation as context"
            >
              <IconMessagePlus size={16} stroke={2} />
              <span>Continue in new session</span>
            </button>
          )}
          <button
            onClick={handleCloseViewer}
            className="rounded p-1 text-neutral-4 hover:text-neutral-1 hover:bg-neutral-8 transition-colors"
            title="Close"
          >
            <IconX size={16} stroke={2} />
          </button>
        </div>
        {/* Chat history (read-only, scrollable) */}
        <div className="flex-1 overflow-hidden flex flex-col">
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

  // List mode (no initialViewId) — inline sidebar panel
  if (initialViewId) return null

  return (
    <div className="flex flex-col min-h-0 flex-1">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-neutral-9/70 border-b border-neutral-8/40 flex-shrink-0">
        <span className="text-[13px] font-semibold text-neutral-1 uppercase tracking-wider">Archived Sessions</span>
        <div className="flex items-center gap-1">
          <label className="text-[12px] text-neutral-5" title="Auto-delete after this many days">
            Keep
          </label>
          <input
            type="number"
            min={1}
            max={365}
            value={retentionDays}
            onChange={e => handleRetentionChange(Number(e.target.value))}
            className="w-10 text-[13px] text-neutral-2 bg-neutral-8 border border-neutral-7 rounded px-1 py-0.5 text-center"
          />
          <span className="text-[12px] text-neutral-5">d</span>
        </div>
      </div>

      {/* Session list */}
      {sessions.length === 0 ? (
        <div className="px-3 py-4 text-[13px] text-neutral-5 text-center">
          No archived sessions
        </div>
      ) : (
        <div className="flex flex-col py-0.5 overflow-y-auto flex-1 min-h-0">
          {sessions.map(s => (
            <button
              key={s.id}
              onClick={() => handleView(s.id)}
              className="group flex items-center gap-2 px-3 py-1 text-left transition-colors text-neutral-3 hover:bg-neutral-8/50 hover:text-neutral-1"
            >
              {s.source === 'workflow' ? (
                <IconTimeline size={12} className="shrink-0 opacity-50" />
              ) : s.source === 'webhook' ? (
                <IconRobot size={12} className="shrink-0 opacity-50" />
              ) : (
                <IconArchive size={12} className="shrink-0 opacity-50" />
              )}
              <span className="flex-1 truncate text-[15px]">{displayName(s)}</span>
              <span className="shrink-0 text-[13px] text-neutral-5 tabular-nums">{compactAge(s.archivedAt)}</span>
              {loading ? (
                <IconLoader2 size={14} className="shrink-0 text-neutral-5 animate-spin" />
              ) : (
                <span
                  onClick={e => handleDelete(s.id, e)}
                  className="cursor-pointer text-transparent hover:text-error-5 group-hover:text-neutral-5 flex-shrink-0"
                >
                  <IconTrash size={14} />
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
