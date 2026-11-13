/**
 * How the sidebar groups sessions: by place. Each repo or folder is a group
 * keyed by its root (`groupDir ?? workingDir`); every scratch session shares
 * one Scratch group. The Scratch key is sidebar-only — each scratch session
 * keeps its own folder as its groupKey, so queueing, approvals and the
 * server's project root stay per folder.
 */

import type { Session } from '../types'
import type { RepoNode } from '../components/RepoSection'
import { groupKey } from '../hooks/useSessionOrchestration'
import { byLatestActivity } from './sessionOrder'

export function repoDisplayName(workingDir: string): string {
  const parts = workingDir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workingDir
}

/** Sidebar key of the one group holding every scratch session. */
export const SCRATCH_GROUP = '__scratch__'

function sidebarGroupKey(s: Session): string {
  return s.place?.kind === 'scratch' ? SCRATCH_GROUP : groupKey(s)
}

/** The sidebar's groups, Scratch first, then alphabetical by folder name. */
export function buildRepoNodes(
  sessions: Session[],
  waitingSessions: Record<string, boolean>,
  tentativeQueues: Record<string, { text: string; files: File[] }[]>,
): RepoNode[] {
  const map = new Map<string, Session[]>()
  for (const s of sessions) {
    if (s.source === 'orchestrator') continue
    const key = sidebarGroupKey(s)
    const list = map.get(key) ?? []
    list.push(s)
    map.set(key, list)
  }
  const label = (key: string) => key === SCRATCH_GROUP ? 'Scratch' : repoDisplayName(key)
  return Array.from(map.entries()).sort((a, b) => {
    // Scratch first; then alphabetical by folder name.
    if (a[0] === SCRATCH_GROUP) return -1
    if (b[0] === SCRATCH_GROUP) return 1
    return label(a[0]).localeCompare(label(b[0]))
  }).map(([key, repoSessions]) => {
    // Older servers send no place; the group then shows no tag.
    const place = repoSessions.find(s => s.place)?.place
    return {
      workingDir: key,
      displayName: label(key),
      kind: key === SCRATCH_GROUP ? 'scratch' as const : place?.kind,
      git: place?.git,
      sessions: [...repoSessions].sort(byLatestActivity),
      hasWaiting: repoSessions.some(s => waitingSessions[s.id]),
      hasActive: repoSessions.some(s => s.isProcessing),
      hasTentative: repoSessions.some(s => (tentativeQueues[s.id]?.length ?? 0) > 0),
    }
  })
}
