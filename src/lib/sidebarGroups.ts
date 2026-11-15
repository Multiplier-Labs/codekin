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

/** How the sidebar orders its groups. */
export type RepoSort = 'activity' | 'name'

export function repoDisplayName(workingDir: string): string {
  const parts = workingDir.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || workingDir
}

/** Sidebar key of the one group holding every scratch session. */
export const SCRATCH_GROUP = '__scratch__'

function sidebarGroupKey(s: Session): string {
  return s.place?.kind === 'scratch' ? SCRATCH_GROUP : groupKey(s)
}

/**
 * The sidebar's groups. By activity (the default): the group whose latest
 * session is most current comes first, with the same rule sessions use inside
 * a group — a turn in progress beats any finished one. By name: Scratch first,
 * then alphabetical by folder name.
 */
export function buildRepoNodes(
  sessions: Session[],
  waitingSessions: Record<string, boolean>,
  tentativeQueues: Record<string, { text: string; files: File[] }[]>,
  sort: RepoSort = 'activity',
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
  const groups = Array.from(map.entries()).map(([key, list]) => [key, [...list].sort(byLatestActivity)] as const)
  return groups.sort((a, b) => {
    if (sort === 'activity') {
      // Each list is sorted, so its first session is the group's latest.
      const byActivity = byLatestActivity(a[1][0], b[1][0])
      if (byActivity) return byActivity
    } else {
      if (a[0] === SCRATCH_GROUP) return -1
      if (b[0] === SCRATCH_GROUP) return 1
    }
    return label(a[0]).localeCompare(label(b[0]))
  }).map(([key, repoSessions]) => {
    // Older servers send no place; the group then shows no tag.
    const place = repoSessions.find(s => s.place)?.place
    return {
      workingDir: key,
      displayName: label(key),
      kind: key === SCRATCH_GROUP ? 'scratch' as const : place?.kind,
      git: place?.git,
      sessions: repoSessions,
      hasWaiting: repoSessions.some(s => waitingSessions[s.id]),
      hasActive: repoSessions.some(s => s.isProcessing),
      hasTentative: repoSessions.some(s => (tentativeQueues[s.id]?.length ?? 0) > 0),
    }
  })
}
