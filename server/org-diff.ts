/**
 * Changes for an org session: one diff across the repositories in its folder.
 *
 * An org session runs in `<repos root>/<owner>`, which is not a repository; its
 * edits land in the clones there, or — with worktrees on — in this session's
 * `<name>-wt-<id8>` worktrees (see org-manifest.ts). The combined diff reuses
 * the single-repo DiffManager per repository and prefixes each file path with
 * the repository's folder name, so paths stay relative to the session's
 * working directory and the file list groups by repository.
 *
 * - Uncommitted views cover every clone and session worktree with changes.
 * - Branch views ('branch', 'committed') cover only this session's worktrees:
 *   they are the checkouts on the session's branch; a clone's own branch
 *   history is not this session's work.
 * - Discard is routed to the repository named by each path's first segment.
 */

import { readdirSync } from 'fs'
import { join } from 'path'
import { clonedRepos } from './org-manifest.js'
import { getFileStatuses, invalidDiscardPath, isDiffScope, type DiffManager } from './diff-manager.js'
import { isGitWorkTree } from './places.js'
import type { DiffFile, DiffFileStatus, DiffScope, DiffSummary, DiffView, WsServerMessage } from './types.js'

export interface OrgRepo {
  /** Folder name under the org folder; the path prefix in the combined diff. */
  name: string
  dir: string
  /** One of this session's worktrees (rather than a shared clone). */
  worktree: boolean
}

/** Repositories to diff for this session: every clone, plus this session's worktrees. */
export function orgReposFor(orgDir: string, sessionId: string): OrgRepo[] {
  const suffix = `-wt-${sessionId.slice(0, 8)}`
  const repos: OrgRepo[] = clonedRepos(orgDir).map(name => ({ name, dir: join(orgDir, name), worktree: false }))
  let names: string[] = []
  try {
    names = readdirSync(orgDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
  } catch { /* folder gone: nothing to diff */ }
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.endsWith(suffix) && isGitWorkTree(join(orgDir, name))) {
      repos.push({ name, dir: join(orgDir, name), worktree: true })
    }
  }
  return repos
}

/** Run `fn` over `items` with at most `limit` in flight, keeping order. */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}

const CONCURRENCY = 6

const isBranchView = (view: DiffView) => view === 'branch' || view === 'committed'

/** Repositories worth diffing for `view`: those with uncommitted changes, or this session's worktrees for branch views. */
async function reposForView(repos: OrgRepo[], view: DiffView): Promise<OrgRepo[]> {
  if (isBranchView(view)) return repos.filter(r => r.worktree)
  const counts = await mapLimit(repos, CONCURRENCY, r => getFileStatuses(r.dir).then(s => Object.keys(s).length).catch(() => 0))
  return repos.filter((_, i) => counts[i] > 0)
}

function prefixed(file: DiffFile, name: string): DiffFile {
  return { ...file, path: `${name}/${file.path}`, ...(file.oldPath ? { oldPath: `${name}/${file.oldPath}` } : {}) }
}

/** The combined diff for an org session. */
export async function getOrgDiff(dm: DiffManager, orgDir: string, sessionId: string, view: DiffView): Promise<WsServerMessage> {
  const repos = await reposForView(orgReposFor(orgDir, sessionId), view)
  const results = await mapLimit(repos, CONCURRENCY, r => dm.getDiff(r.dir, view))
  const files: DiffFile[] = []
  const incomplete: string[] = []
  let truncated = false
  const reasons: string[] = []
  results.forEach((result, i) => {
    const { name } = repos[i]
    if (result.type === 'diff_error') {
      incomplete.push(`${name}: ${result.message}`)
      return
    }
    if (result.type !== 'diff_result') return
    files.push(...result.files.map(f => prefixed(f, name)))
    if (result.summary.truncated) {
      truncated = true
      if (result.summary.truncationReason) reasons.push(`${name}: ${result.summary.truncationReason}`)
    }
    for (const note of result.incomplete ?? []) incomplete.push(`${name}: ${note}`)
  })
  const changedRepos = new Set(files.map(f => f.path.split('/')[0])).size
  const summary: DiffSummary = {
    filesChanged: files.length,
    insertions: files.reduce((sum, f) => sum + f.additions, 0),
    deletions: files.reduce((sum, f) => sum + f.deletions, 0),
    truncated,
    ...(reasons.length ? { truncationReason: reasons.join('; ') } : {}),
    ...(view === 'branch' ? { uncommittedFiles: files.filter(f => f.uncommitted).length } : {}),
  }
  return {
    type: 'diff_result', files, summary, scope: view,
    branch: changedRepos === 1 ? `1 repository` : `${changedRepos} repositories`,
    ...(incomplete.length ? { incomplete } : {}),
  }
}

/** How much an org session has to review, summed over its repositories. */
export async function getOrgChangeSummary(dm: DiffManager, orgDir: string, sessionId: string): Promise<{ uncommittedFiles: number; branchCommits: number | null }> {
  const repos = orgReposFor(orgDir, sessionId)
  const summaries = await mapLimit(repos, CONCURRENCY, async r => {
    if (r.worktree) return dm.getChangeSummary(r.dir)
    const uncommittedFiles = await getFileStatuses(r.dir).then(s => Object.keys(s).length).catch(() => 0)
    return { uncommittedFiles, branchCommits: null }
  })
  let branchCommits: number | null = null
  for (const s of summaries) if (s.branchCommits !== null) branchCommits = (branchCommits ?? 0) + s.branchCommits
  return { uncommittedFiles: summaries.reduce((n, s) => n + s.uncommittedFiles, 0), branchCommits }
}

/**
 * Discard changes in an org session. Each path's first segment names the
 * repository; every path is checked (known repository, no traversal) before
 * anything is discarded, so a bad path never leaves a partial discard. With no paths, every repository's changes are discarded.
 */
export async function discardOrgChanges(
  dm: DiffManager, orgDir: string, sessionId: string, scope: DiffScope,
  paths?: string[], statuses?: Record<string, DiffFileStatus>,
): Promise<WsServerMessage> {
  const repos = orgReposFor(orgDir, sessionId)
  const byName = new Map(repos.map(r => [r.name, r]))
  const groups = new Map<string, { paths: string[]; statuses: Record<string, DiffFileStatus> }>()
  const targets = paths ?? (statuses ? Object.keys(statuses) : null)
  if (!isDiffScope(scope)) {
    return { type: 'diff_error', message: 'Changes can only be discarded from the Uncommitted, Staged or Unstaged views.', scope }
  }
  if (targets) {
    for (const p of targets) {
      const slash = p.indexOf('/')
      const name = slash > 0 ? p.slice(0, slash) : ''
      if (!byName.has(name) || slash === p.length - 1) return { type: 'diff_error', message: `Not in a repository of this session: ${p}`, scope }
      const group = groups.get(name) ?? { paths: [], statuses: {} }
      const rel = p.slice(slash + 1)
      const invalid = invalidDiscardPath(byName.get(name)!.dir, rel)
      if (invalid) return { type: 'diff_error', message: `${name}: ${invalid}`, scope }
      group.paths.push(rel)
      if (statuses?.[p]) group.statuses[rel] = statuses[p]
      groups.set(name, group)
    }
  }
  const work = targets
    ? [...groups].map(([name, g]) => ({ repo: byName.get(name)!, paths: g.paths, statuses: statuses ? g.statuses : undefined }))
    : (await reposForView(repos, scope)).map(repo => ({ repo, paths: undefined, statuses: undefined }))
  for (const { repo, paths: repoPaths, statuses: repoStatuses } of work) {
    const result = await dm.discardChanges(repo.dir, scope, repoPaths, repoStatuses)
    if (result.type === 'diff_error') return { ...result, message: `${repo.name}: ${result.message}` }
  }
  return getOrgDiff(dm, orgDir, sessionId, scope)
}
