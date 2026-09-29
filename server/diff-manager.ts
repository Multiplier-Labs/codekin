/**
 * DiffManager — encapsulates stateless git-diff operations.
 *
 * Extracted from SessionManager to reduce its complexity. All methods operate
 * on a working directory path and have no dependency on session state, making
 * them independently testable.
 *
 * The class is instantiated once by SessionManager and delegates are called
 * with the relevant session's workingDir.
 */

import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'
import type { DiffFile, DiffFileStatus, DiffReview, DiffScope, DiffSummary, DiffView, WsServerMessage } from './types.js'
import { parseDiff, createUntrackedFileDiff } from './diff-parser.js'
import { detectDefaultBranch } from './worktree-ops.js'

const execFileAsync = promisify(execFile)

/** Max stdout for git commands (2 MB). */
const GIT_MAX_BUFFER = 2 * 1024 * 1024
/** Timeout for git commands (10 seconds). */
const GIT_TIMEOUT_MS = 10_000
/** Max paths per git command to stay under ARG_MAX (~128 KB on Linux). */
const GIT_PATH_CHUNK_SIZE = 200

/**
 * Return a copy of process.env with GIT_* vars removed that can interfere
 * with child git processes (e.g. GIT_INDEX_FILE, GIT_DIR, GIT_PREFIX).
 * The server may inherit these from the shell that launched pm2/node.
 */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') || key === 'GIT_EDITOR'
    )
  )
}

/** Run a git command as a fixed argv array (no shell interpolation). */
export async function execGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: GIT_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
  })
  return stdout
}

/** Run a git command with paths chunked to avoid E2BIG. Concatenates stdout. */
export async function execGitChunked(baseArgs: string[], paths: string[], cwd: string): Promise<string> {
  let result = ''
  for (let i = 0; i < paths.length; i += GIT_PATH_CHUNK_SIZE) {
    const chunk = paths.slice(i, i + GIT_PATH_CHUNK_SIZE)
    result += await execGit([...baseArgs, '--', ...chunk], cwd)
  }
  return result
}

/** Get file statuses from `git status --porcelain` for given paths (or all). */
export async function getFileStatuses(cwd: string, paths?: string[]): Promise<Record<string, DiffFileStatus>> {
  const args = ['status', '--porcelain', '-z']
  if (paths) args.push('--', ...paths)
  const raw = await execGit(args, cwd)
  const result: Record<string, DiffFileStatus> = {}
  // git status --porcelain=v1 -z format: XY NUL path NUL
  const parts = raw.split('\0')
  let i = 0
  while (i < parts.length) {
    const entry = parts[i]
    if (entry.length < 3) { i++; continue }
    const x = entry[0]
    const y = entry[1]
    const filePath = entry.slice(3)
    if (x === 'R' || x === 'C') {
      const newPath = parts[i + 1] ?? filePath
      result[newPath] = 'renamed'
      i += 2
    } else if (x === 'D' || y === 'D') {
      result[filePath] = 'deleted'
      i++
    } else if (x === '?' && y === '?') {
      result[filePath] = 'added'
      i++
    } else if (x === 'A') {
      result[filePath] = 'added'
      i++
    } else {
      result[filePath] = 'modified'
      i++
    }
  }
  return result
}

/** Max stdout for a diff (32 MB); the parser shows the first 2 MB and flags truncation. */
const DIFF_MAX_BUFFER = 32 * 1024 * 1024
/** Refs offered as review bases. */
const MAX_BASE_CANDIDATES = 50

const DIFF_SCOPES: ReadonlySet<string> = new Set(['staged', 'unstaged', 'all'])
const DIFF_VIEWS: ReadonlySet<string> = new Set([...DIFF_SCOPES, 'branch', 'committed'])

/** Runtime check for a discardable scope (client input is untrusted). */
export function isDiffScope(value: unknown): value is DiffScope {
  return typeof value === 'string' && DIFF_SCOPES.has(value)
}

/** Runtime check for a diff view (client input is untrusted). */
export function isDiffView(value: unknown): value is DiffView {
  return typeof value === 'string' && DIFF_VIEWS.has(value)
}

function isBranchView(view: DiffView): view is 'branch' | 'committed' {
  return view === 'branch' || view === 'committed'
}

/** The caller's preferred review base (from session state). */
export interface ReviewBasePreference {
  ref: string
  source: 'user' | 'worktree'
}

/** A git failure with a message meant for the user. */
export class DiffUserError extends Error {}

function describeGitError(err: unknown, fallback: string): string {
  if (err instanceof DiffUserError) return err.message
  if (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return `The diff is larger than ${DIFF_MAX_BUFFER / 1024 / 1024} MB and cannot be shown.`
  }
  if (err && typeof err === 'object' && 'stderr' in err && typeof err.stderr === 'string' && err.stderr.trim()) {
    return err.stderr.trim()
  }
  return err instanceof Error ? err.message : fallback
}

/** Run a diff command with a larger buffer than other git commands. */
async function execGitDiff(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    env: cleanGitEnv(),
    maxBuffer: DIFF_MAX_BUFFER,
    timeout: GIT_TIMEOUT_MS,
  })
  return stdout
}

async function hasCommits(cwd: string): Promise<boolean> {
  try {
    await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)
    return true
  } catch {
    return false
  }
}

async function resolveHead(cwd: string): Promise<string | null> {
  try {
    return (await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd)).trim() || null
  } catch {
    return null
  }
}

async function currentBranchLabel(cwd: string): Promise<string> {
  try {
    const name = (await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)).trim()
    if (name !== 'HEAD') return name
    const sha = (await execGit(['rev-parse', '--short', 'HEAD'], cwd)).trim()
    return `detached at ${sha}`
  } catch {
    return 'unknown'
  }
}

async function commitOf(ref: string, cwd: string): Promise<string | null> {
  // Refs never start with '-'; rejecting them keeps user input out of option parsing.
  if (!ref || ref.startsWith('-')) return null
  try {
    return (await execGit(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).trim() || null
  } catch {
    return null
  }
}

async function isAncestor(a: string, b: string, cwd: string): Promise<boolean> {
  try {
    await execGit(['merge-base', '--is-ancestor', a, b], cwd)
    return true
  } catch {
    return false
  }
}

/** Whether `ref` names a commit in the repository at `cwd`. */
export async function isValidReviewBase(ref: string, cwd: string): Promise<boolean> {
  return (await commitOf(ref, cwd)) !== null
}

/**
 * Resolve the merge base for a branch view. For a bare branch name both the
 * local branch and `origin/<name>` are considered, and the more recent fork
 * point wins: a stale local main or an unpushed local main would otherwise
 * pull unrelated commits into the review.
 */
async function resolveReview(cwd: string, head: string | null, preferred?: ReviewBasePreference): Promise<DiffReview> {
  if (!head) throw new DiffUserError('This branch has no commits yet, so there is nothing to compare. Use the Uncommitted view.')
  let baseName = preferred?.ref
  let baseSource: DiffReview['baseSource'] = preferred?.source ?? 'default'
  if (!baseName) {
    baseName = await detectDefaultBranch(cwd) ?? undefined
    baseSource = 'default'
  }
  if (!baseName) throw new DiffUserError('No review base found: this repository has no main or master branch. Choose a base branch.')

  const refs = baseName.includes('/') ? [baseName] : [baseName, `origin/${baseName}`]
  let best: { ref: string; mergeBase: string } | null = null
  let resolvable = false
  for (const ref of refs) {
    if (!(await commitOf(ref, cwd))) continue
    resolvable = true
    let mergeBase: string
    try {
      mergeBase = (await execGit(['merge-base', 'HEAD', ref], cwd)).trim()
    } catch {
      continue
    }
    if (!mergeBase) continue
    if (!best || await isAncestor(best.mergeBase, mergeBase, cwd)) best = { ref, mergeBase }
  }
  if (!resolvable) throw new DiffUserError(`Review base "${baseName}" does not exist in this repository. Choose another base.`)
  if (!best) {
    throw new DiffUserError(`HEAD and "${baseName}" have no common history (unrelated branches, or a shallow clone without the fork point). Fetch more history or choose another base.`)
  }
  return { baseRef: best.ref, baseSource, mergeBase: best.mergeBase, head, candidates: await listBaseCandidates(cwd) }
}

async function listBaseCandidates(cwd: string): Promise<string[]> {
  try {
    const out = await execGit(['for-each-ref', '--format=%(refname:short)', '--sort=-committerdate', 'refs/heads', 'refs/remotes'], cwd)
    return out.split('\n').filter(r => r && !r.endsWith('/HEAD') && r !== 'origin').slice(0, MAX_BASE_CANDIDATES)
  } catch {
    return []
  }
}

/**
 * Encapsulates git-diff and discard operations for a working directory.
 *
 * Stateless — all methods take a `cwd` parameter and don't hold any mutable
 * state, so a single instance can safely serve all sessions.
 */
export class DiffManager {
  /**
   * Run git diff in a working directory and return structured results.
   *
   * Uncommitted views ('all', 'staged', 'unstaged') compare against HEAD or
   * the index. Branch views compare against the merge base of HEAD and the
   * review base: 'committed' is merge base → HEAD, 'branch' is merge base →
   * working tree plus untracked files. Failures produce `diff_error` (or an
   * `incomplete` note) — never a silently empty result.
   */
  async getDiff(cwd: string, view: DiffView = 'all', base?: ReviewBasePreference): Promise<WsServerMessage> {
    try {
      const branch = await currentBranchLabel(cwd)
      for (let attempt = 0; ; attempt++) {
        const headBefore = await resolveHead(cwd)
        const review = isBranchView(view) ? await resolveReview(cwd, headBefore, base) : undefined
        const collected = await this.collect(cwd, view, review)
        // Git has no snapshot of a live checkout: if HEAD moved while we were
        // reading (e.g. the agent committed), retry once, then say so.
        const headAfter = await resolveHead(cwd)
        if (headAfter !== headBefore) {
          if (attempt === 0) continue
          collected.incomplete.push('The branch moved while the diff was being collected. Refresh to see the latest state.')
        }
        const { files, truncated, truncationReason, incomplete } = collected
        const summary: DiffSummary = {
          filesChanged: files.length,
          insertions: files.reduce((sum, f) => sum + f.additions, 0),
          deletions: files.reduce((sum, f) => sum + f.deletions, 0),
          truncated,
          truncationReason,
          ...(view === 'branch' ? { uncommittedFiles: files.filter(f => f.uncommitted).length } : {}),
        }
        return {
          type: 'diff_result', files, summary, branch, scope: view,
          ...(review ? { review } : {}),
          ...(incomplete.length ? { incomplete } : {}),
        }
      }
    } catch (err) {
      return { type: 'diff_error', message: describeGitError(err, 'Failed to get diff'), scope: view }
    }
  }

  /** Run the diff for one view and append untracked files where the view includes them. */
  private async collect(cwd: string, view: DiffView, review?: DiffReview): Promise<{
    files: DiffFile[]; truncated: boolean; truncationReason?: string; incomplete: string[]
  }> {
    const incomplete: string[] = []
    const diffArgs = ['diff', '--find-renames', '--no-color', '--unified=3']
    let rawDiff: string
    if (view === 'committed' && review) {
      rawDiff = await execGitDiff([...diffArgs, review.mergeBase, review.head], cwd)
    } else if (view === 'branch' && review) {
      rawDiff = await execGitDiff([...diffArgs, review.mergeBase], cwd)
    } else if (view === 'staged') {
      rawDiff = await execGitDiff([...diffArgs, '--cached'], cwd)
    } else if (view === 'unstaged') {
      rawDiff = await execGitDiff(diffArgs, cwd)
    } else if (await hasCommits(cwd)) {
      rawDiff = await execGitDiff([...diffArgs, 'HEAD'], cwd)
    } else {
      // No commits yet: everything staged plus everything unstaged.
      const [staged, unstaged] = await Promise.all([
        execGitDiff([...diffArgs, '--cached'], cwd),
        execGitDiff(diffArgs, cwd),
      ])
      rawDiff = staged + unstaged
    }

    const { files, truncated, truncationReason } = parseDiff(rawDiff)

    if (view !== 'staged' && view !== 'committed') {
      let untrackedPaths: string[] = []
      try {
        const untrackedRaw = await execGit(['ls-files', '--others', '--exclude-standard'], cwd)
        untrackedPaths = untrackedRaw.trim().split('\n').filter(Boolean)
      } catch {
        incomplete.push('Untracked files could not be listed.')
      }
      let large = 0
      let unreadable = 0
      const MAX_UNTRACKED_FILE_SIZE = 1024 * 1024 // 1 MB
      for (const relPath of untrackedPaths) {
        const placeholder: DiffFile = { path: relPath, status: 'added', isBinary: true, additions: 0, deletions: 0, hunks: [] }
        try {
          const fullPath = path.join(cwd, relPath)
          const stat = await fs.stat(fullPath)
          if (stat.size > MAX_UNTRACKED_FILE_SIZE) {
            large++
            files.push(placeholder)
            continue
          }
          const content = await fs.readFile(fullPath, 'utf-8')
          files.push(createUntrackedFileDiff(relPath, content))
        } catch {
          unreadable++
          files.push(placeholder)
        }
      }
      if (large) incomplete.push(`${large} untracked file(s) over 1 MB are listed without content.`)
      if (unreadable) incomplete.push(`${unreadable} untracked file(s) could not be read.`)
    }

    // The task view mixes history and live edits: mark which files still
    // have uncommitted changes so reviewers know what is not yet in a commit.
    if (view === 'branch') {
      try {
        const live = await getFileStatuses(cwd)
        for (const f of files) if (f.path in live) f.uncommitted = true
      } catch {
        incomplete.push('Could not tell which files have uncommitted changes.')
      }
    }

    return { files, truncated, truncationReason, incomplete }
  }

  /**
   * Discard changes in a working directory per the given scope and paths.
   * Returns a fresh diff_result after discarding.
   */
  async discardChanges(
    cwd: string,
    scope: DiffScope,
    paths?: string[],
    statuses?: Record<string, DiffFileStatus>,
  ): Promise<WsServerMessage> {
    // Branch views are history, not edits: only uncommitted scopes can be
    // discarded, whatever the client sends.
    if (!isDiffScope(scope)) {
      return { type: 'diff_error', message: 'Changes can only be discarded from the Uncommitted, Staged or Unstaged views.', scope }
    }
    try {
      // Validate every client-supplied path (both `paths` and `statuses`
      // keys, since either can become the effective target list below)
      // against path traversal, before any of them reach git or fs calls.
      const root = path.join(path.resolve(cwd), path.sep)
      const clientPaths = [...(paths ?? []), ...Object.keys(statuses ?? {})]
      for (const p of clientPaths) {
        if (p.includes('..') || path.isAbsolute(p)) {
          return { type: 'diff_error', message: `Invalid path: ${p}` }
        }
        const resolved = path.resolve(cwd, p)
        if (resolved !== path.resolve(cwd) && !resolved.startsWith(root)) {
          return { type: 'diff_error', message: `Path escapes working directory: ${p}` }
        }
      }

      // Determine file statuses if not provided
      let fileStatuses = statuses ?? {}
      if (!statuses && paths) {
        fileStatuses = await getFileStatuses(cwd, paths)
      } else if (!statuses && !paths) {
        fileStatuses = await getFileStatuses(cwd)
      }

      const targetPaths = paths ?? Object.keys(fileStatuses)

      // Separate files by status for different handling
      const trackedPaths: string[] = []
      const untrackedPaths: string[] = []
      const stagedNewPaths: string[] = []

      for (const p of targetPaths) {
        const status = fileStatuses[p]
        if (status === 'added') {
          try {
            const indexEntry = (await execGit(['ls-files', '--stage', '--', p], cwd)).trim()
            if (indexEntry) {
              stagedNewPaths.push(p)
            } else {
              untrackedPaths.push(p)
            }
          } catch {
            untrackedPaths.push(p)
          }
        } else {
          trackedPaths.push(p)
        }
      }

      // Handle tracked files (modified, deleted, renamed) with git restore
      if (trackedPaths.length > 0) {
        const restoreArgs = ['restore']
        if (scope === 'staged') {
          restoreArgs.push('--staged')
        } else if (scope === 'all') {
          restoreArgs.push('--staged', '--worktree')
        } else {
          restoreArgs.push('--worktree')
        }

        try {
          await execGitChunked(restoreArgs, trackedPaths, cwd)
        } catch (err) {
          console.warn('[discard] git restore failed, trying fallback:', err)
          if (scope === 'staged' || scope === 'all') {
            await execGitChunked(['reset', 'HEAD'], trackedPaths, cwd)
          }
          if (scope === 'unstaged' || scope === 'all') {
            await execGitChunked(['checkout'], trackedPaths, cwd)
          }
        }
      }

      // Handle staged new files
      if (stagedNewPaths.length > 0) {
        if (scope === 'staged') {
          await execGitChunked(['rm', '--cached'], stagedNewPaths, cwd)
        } else if (scope === 'all') {
          await execGitChunked(['rm', '--cached'], stagedNewPaths, cwd)
          for (const p of stagedNewPaths) {
            await fs.unlink(path.join(cwd, p)).catch(() => {})
          }
        }
      }

      // Handle untracked files (delete from disk)
      if (untrackedPaths.length > 0 && scope !== 'staged') {
        for (const p of untrackedPaths) {
          await fs.unlink(path.join(cwd, p)).catch(() => {})
        }
      }

      // Return fresh diff
      return await this.getDiff(cwd, scope)
    } catch (err) {
      return { type: 'diff_error', message: describeGitError(err, 'Failed to discard changes'), scope }
    }
  }
}
