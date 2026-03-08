/**
 * Session list panel for the right sidebar.
 *
 * Shows all sessions for the active repo with status indicators.
 * Adapted from the floating SessionList component for sidebar embedding.
 */

import { IconPlus, IconRobot, IconTimeline } from '@tabler/icons-react'
import type { Session } from '../types'

interface Props {
  sessions: Session[]
  activeSessionId: string | null
  waitingSessions: Record<string, boolean>
  tentativeQueues?: Record<string, string[]>
  onSelect: (sessionId: string) => void
  onDelete: (sessionId: string) => void
  onNew: () => void
}

function displayName(session: Session): string {
  const name = session.name || session.id.slice(0, 8)
  if (name.startsWith('hub:')) return 'new session'
  return name
}

function compactAge(created: string): string {
  const seconds = Math.floor((Date.now() - new Date(created).getTime()) / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d`
}

function sessionStateClasses(
  s: Session,
  waitingSessions: Record<string, boolean>,
  tentativeQueues?: Record<string, string[]>,
): [string, string] {
  if ((tentativeQueues?.[s.id]?.length ?? 0) > 0) return ['text-accent-6', 'animate-pulse']
  if (waitingSessions[s.id]) return ['text-warning-5', 'animate-pulse']
  if (s.isProcessing) return ['text-success-6', 'animate-pulse']
  if (s.active) return ['text-neutral-5', '']
  return ['text-neutral-7', '']
}

function sessionDotClasses(
  s: Session,
  waitingSessions: Record<string, boolean>,
  tentativeQueues?: Record<string, string[]>,
): string {
  if ((tentativeQueues?.[s.id]?.length ?? 0) > 0) return 'bg-accent-6 animate-pulse'
  if (waitingSessions[s.id]) return 'bg-warning-5 animate-pulse'
  if (s.isProcessing) return 'bg-success-6 animate-pulse'
  if (s.active) return 'bg-neutral-5'
  return 'bg-neutral-7'
}

export function SessionListPanel({ sessions, activeSessionId, waitingSessions, tentativeQueues, onSelect, onDelete, onNew }: Props) {
  if (sessions.length === 0) return null

  return (
    <div className="flex flex-col min-h-0">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 bg-neutral-9/70 border-b border-neutral-8/40 flex-shrink-0">
        <span className="text-[13px] font-semibold text-neutral-1 uppercase tracking-wider">Sessions</span>
        <button
          onClick={onNew}
          className="rounded p-0.5 text-neutral-4 hover:text-neutral-1 hover:bg-neutral-6/25 transition-colors cursor-pointer"
          title="New session"
        >
          <IconPlus size={14} stroke={2} />
        </button>
      </div>

      {/* Session list */}
      <div className="flex flex-col py-0.5 overflow-y-auto max-h-[200px]">
        {sessions.map(s => {
          const isActive = s.id === activeSessionId
          return (
            <button
              key={s.id}
              onClick={() => onSelect(s.id)}
              className={`group flex items-center gap-2 px-3 py-1 text-left transition-colors ${
                isActive
                  ? 'bg-accent-9/30 text-accent-2'
                  : 'text-neutral-3 hover:bg-neutral-8/50 hover:text-neutral-1'
              }`}
            >
              {s.source === 'workflow' ? (
                <IconTimeline size={12} className={`shrink-0 ${sessionStateClasses(s, waitingSessions, tentativeQueues).join(' ')}`} />
              ) : s.source === 'webhook' ? (
                <IconRobot size={12} className={`shrink-0 ${sessionStateClasses(s, waitingSessions, tentativeQueues).join(' ')}`} />
              ) : (
                <span className={`inline-block h-1.5 w-1.5 rounded-full flex-shrink-0 ${sessionDotClasses(s, waitingSessions, tentativeQueues)}`} />
              )}
              <span className="flex-1 truncate text-[15px]">{displayName(s)}</span>
              <span className="shrink-0 text-[13px] text-neutral-5 tabular-nums">{compactAge(s.created)}</span>
              <span
                onClick={e => { e.stopPropagation(); onDelete(s.id) }}
                className="cursor-pointer text-[15px] text-transparent hover:text-error-5 group-hover:text-neutral-5 flex-shrink-0"
              >
                ×
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
