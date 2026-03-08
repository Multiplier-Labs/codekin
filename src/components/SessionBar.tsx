/**
 * Horizontal tab bar showing open repositories as clickable tabs.
 *
 * Sessions are grouped by repository (using groupDir or workingDir).
 * Each tab shows the repo name, session count, and a status indicator:
 * pulsing amber for waiting input, green for active, gray for idle.
 * Tabs can be closed to remove all sessions for that repo.
 */

import type { Session } from '../types'

interface Props {
  sessions: Session[]
  waitingSessions: Record<string, boolean>
  tentativeQueues?: Record<string, string[]>
  onSelectRepo: (workingDir: string) => void
  onDeleteRepo: (workingDir: string) => void
  activeWorkingDir: string | null
}

/** Derive a short display name from a workingDir path */
function repoDisplayName(workingDir: string): string {
  const parts = workingDir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workingDir
}

interface RepoGroup {
  workingDir: string
  displayName: string
  sessions: Session[]
  hasWaiting: boolean
  hasActive: boolean
  hasIdle: boolean
  hasTentative: boolean
}

/** Use groupDir (if set) for tab grouping, falling back to workingDir. */
function groupKey(s: Session): string {
  return s.groupDir ?? s.workingDir
}

function groupByRepo(sessions: Session[], waitingSessions: Record<string, boolean>, tentativeQueues: Record<string, string[]>): RepoGroup[] {
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
    hasIdle: repoSessions.some(s => s.active && !s.isProcessing),
    hasTentative: repoSessions.some(s => (tentativeQueues[s.id]?.length ?? 0) > 0),
  }))
}

export function SessionBar({ sessions, waitingSessions, tentativeQueues, onSelectRepo, onDeleteRepo, activeWorkingDir }: Props) {
  if (sessions.length === 0) return null

  const groups = groupByRepo(sessions, waitingSessions, tentativeQueues ?? {})

  return (
    <div className="flex items-center gap-1 overflow-x-auto pl-4">
      {groups.map(g => {
        const isActive = g.workingDir === activeWorkingDir
        return (
          <button
            key={g.workingDir}
            onClick={() => onSelectRepo(g.workingDir)}
            className={`app-session-tab group flex items-center gap-1.5 rounded px-2.5 py-1 text-[15px] transition ${
              isActive
                ? 'bg-accent-8/50 text-accent-2 border border-accent-6/60'
                : 'text-neutral-2 border border-transparent hover:bg-neutral-6 hover:text-neutral-1'
            }`}
          >
            <span
              className={`inline-block h-1.5 w-1.5 rounded-full ${
                g.hasTentative
                  ? isActive ? 'bg-accent-3 animate-pulse' : 'bg-accent-6 animate-pulse'
                  : g.hasWaiting
                  ? isActive ? 'bg-warning-3 animate-pulse' : 'bg-warning-5 animate-pulse'
                  : g.hasActive
                  ? isActive ? 'bg-success-3 animate-pulse' : 'bg-success-6 animate-pulse'
                  : g.hasIdle
                  ? isActive ? 'bg-accent-2' : 'bg-neutral-5'
                  : isActive ? 'bg-accent-4' : 'bg-neutral-7'
              }`}
            />
            <span className="max-w-[180px] truncate">{g.displayName}</span>
            <span className="text-[13px] opacity-60">({g.sessions.length})</span>
            <span
              onClick={e => { e.stopPropagation(); onDeleteRepo(g.workingDir) }}
              className="ml-0.5 cursor-pointer text-transparent hover:text-error-5 group-hover:text-neutral-5"
            >
              ×
            </span>
          </button>
        )
      })}
    </div>
  )
}
