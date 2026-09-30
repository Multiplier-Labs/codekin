/**
 * How tasks group in the Tasks view: by what they need, with "running"
 * (an attempt is active now) kept apart from "queued" (waiting for Joe).
 */

import { repoName, type JoeTask, type TaskList } from './tasksApi'

export type SectionId = 'decision' | 'review' | 'running' | 'queued' | 'todo'

export const SECTIONS: { id: SectionId; title: string }[] = [
  { id: 'decision', title: 'Needs your decision' },
  { id: 'review', title: 'Ready for review' },
  { id: 'running', title: 'Running' },
  { id: 'queued', title: 'Queued' },
  { id: 'todo', title: 'To do' },
]

/** Which list a task belongs in. Closed tasks return null. */
export function sectionOf(task: JoeTask): SectionId | null {
  switch (task.status) {
    case 'needs_decision': return 'decision'
    case 'in_review': return 'review'
    case 'done':
    case 'dismissed': return null
  }
  if (task.execution === 'running') return 'running'
  if (task.execution === 'queued') return 'queued'
  // in_progress without a live attempt is waiting on Joe, not running
  // (a server without the execution substate only has the status to go on).
  if (task.status === 'in_progress') return task.execution === undefined ? 'running' : 'queued'
  return 'todo'
}

export interface RepoSummary {
  repo: string
  needsYou: number
  running: number
  queued: number
  open: number
}

/** Per-repo counts across all tasks — the compact overview above the list. */
export function summarizeRepos(data: TaskList | null): RepoSummary[] {
  const byRepo = new Map<string, RepoSummary>()
  for (const task of data?.tasks ?? []) {
    const section = sectionOf(task)
    if (!section) continue
    const entry = byRepo.get(task.repo) ?? { repo: task.repo, needsYou: 0, running: 0, queued: 0, open: 0 }
    entry.open++
    if (section === 'decision' || section === 'review') entry.needsYou++
    if (section === 'running') entry.running++
    if (section === 'queued') entry.queued++
    byRepo.set(task.repo, entry)
  }
  return [...byRepo.values()].sort((a, b) => b.needsYou - a.needsYou || b.open - a.open || repoName(a.repo).localeCompare(repoName(b.repo)))
}

