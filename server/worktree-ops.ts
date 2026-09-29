/**
 * Non-destructive git worktree creation and removal for session isolation.
 *
 * Invariants:
 * - Never recursively delete a directory. A leftover path is reused only when
 *   it is a registered worktree for the same branch; an empty directory may be
 *   removed with a non-recursive rmdir; anything else is a collision.
 * - Never discard commits. A generated branch is reset to the base only when
 *   it has no commits of its own; caller-supplied branches are never reset.
 * - Never force-remove a worktree. Removal uses plain `git worktree remove`,
 *   which refuses dirty or untracked content; such worktrees are retained.
 * - Operations on the same repository are serialized.
 */

import { execFile } from 'child_process'
import { existsSync, readdirSync, realpathSync, rmdirSync, statSync } from 'fs'
import path from 'path'
import { promisify } from 'util'
import { cleanGitEnv } from './diff-manager.js'

const execFileAsync = promisify(execFile)

/** Candidate managed paths per owner: `<project>-wt-<id>`, then `-2` … `-9`. */
const MAX_PATH_CANDIDATES = 9

export type WorktreeErrorCode = 'session_not_found' | 'not_a_git_repo' | 'branch_in_use' | 'path_collision' | 'git_failed'

export interface WorktreeCreated {
  ok: true
  /** Absolute worktree path. */
  path: string
  branch: string
  /** Main checkout of the repository (parent of the common git dir). */
  repoRoot: string
  /** Ref the branch was created from; undefined when an existing branch was used. */
  baseRef?: string
  /** Commit `baseRef` resolved to at creation time. */
  baseCommit?: string
  /** True when an existing worktree owned by the caller was reused as-is. */
  reused: boolean
}

export interface WorktreeFailed {
  ok: false
  code: WorktreeErrorCode
  /** User-readable explanation. */
  message: string
}

export type WorktreeResult = WorktreeCreated | WorktreeFailed

export interface PrepareWorktreeOptions {
  /** Any directory inside the repository (may itself be a worktree). */
  sourceDir: string
  /** Stable owner id used to name the managed path (e.g. first 8 chars of a session id). */
  ownerId: string
  branch: string
  /** True when Codekin generated the branch name (e.g. `wt/<id>`), so it may reset an unused one. */
  generatedBranch: boolean
  /** Ref to branch from when creating a new branch. Defaults to the detected default branch. */
  baseBranch?: string
  /** Worktree path the owner already holds, if any; it may be reused. */
  ownedPath?: string
}

export interface RemoveWorktreeResult {
  removed: boolean
  /** Why the worktree was retained (git's message), when `removed` is false. */
  reason?: string
}

interface WorktreeEntry {
  path: string
  branch?: string
}

const repoLocks = new Map<string, Promise<unknown>>()

/** Serialize `fn` with every other operation holding the same key. */
async function withRepoLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(key) ?? Promise.resolve()
  const run = prev.catch(() => {}).then(fn)
  repoLocks.set(key, run)
  try {
    return await run
  } finally {
    if (repoLocks.get(key) === run) repoLocks.delete(key)
  }
}

async function git(args: string[], cwd: string, timeout = 5000): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, env: cleanGitEnv(), timeout })
  return stdout
}

function errorText(err: unknown): string {
  if (err && typeof err === 'object' && 'stderr' in err) {
    const { stderr } = err as { stderr: unknown }
    if (typeof stderr === 'string' && stderr.trim()) return stderr.trim()
  }
  return err instanceof Error ? err.message : String(err)
}

/** Resolve symlinks when the path exists so paths from git and from callers compare equal. */
function canonical(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return path.resolve(p)
  }
}

/**
 * Resolve the main checkout of the repository containing `dir`.
 * Uses --git-common-dir so a worktree resolves to its parent repository.
 */
export async function resolveRepoRoot(dir: string): Promise<string | null> {
  try {
    const commonDir = (await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], dir)).trim()
    if (!commonDir || !path.isAbsolute(commonDir)) return null
    return path.dirname(commonDir)
  } catch {
    return null
  }
}

/**
 * Detect the default branch of a repository: origin/HEAD, then local
 * `main`, then `master`. Returns null if none can be determined.
 */
export async function detectDefaultBranch(repoRoot: string): Promise<string | null> {
  try {
    const ref = (await git(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoRoot)).trim()
    if (ref) return ref.replace('refs/remotes/origin/', '')
  } catch {
    // origin/HEAD not set — fall through to heuristics
  }
  for (const candidate of ['main', 'master']) {
    try {
      await git(['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`], repoRoot, 3000)
      return candidate
    } catch {
      // branch doesn't exist, try next
    }
  }
  return null
}

async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await git(['worktree', 'list', '--porcelain'], repoRoot)
  const entries: WorktreeEntry[] = []
  let current: WorktreeEntry | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      current = { path: canonical(line.slice('worktree '.length)) }
      entries.push(current)
    } else if (current && line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).replace(/^refs\/heads\//, '')
    }
  }
  return entries
}

async function refExists(ref: string, cwd: string): Promise<boolean> {
  try {
    await git(['show-ref', '--verify', '--quiet', ref], cwd, 3000)
    return true
  } catch {
    return false
  }
}

async function resolveCommit(ref: string, cwd: string): Promise<string | undefined> {
  try {
    return (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).trim() || undefined
  } catch {
    return undefined
  }
}

function isEmptyDir(p: string): boolean {
  try {
    return statSync(p).isDirectory() && readdirSync(p).length === 0
  } catch {
    return false
  }
}

/** Managed paths for an owner: `<project>-wt-<id>` and its numbered variants. */
function managedPaths(repoRoot: string, ownerId: string): string[] {
  const base = path.resolve(repoRoot, '..', `${path.basename(repoRoot)}-wt-${ownerId}`)
  const paths = [base]
  for (let i = 2; i <= MAX_PATH_CANDIDATES; i++) paths.push(`${base}-${i}`)
  return paths
}

/**
 * Create (or reuse) an isolated worktree for `opts.branch`.
 *
 * Reuses a registered worktree already on the branch when it belongs to the
 * owner (its managed path or `ownedPath`). Otherwise picks the first managed
 * path that is free, skipping any occupied directory rather than deleting it.
 */
export async function prepareWorktree(opts: PrepareWorktreeOptions): Promise<WorktreeResult> {
  const repoRoot = await resolveRepoRoot(opts.sourceDir)
  if (!repoRoot) {
    return { ok: false, code: 'not_a_git_repo', message: `${opts.sourceDir} is not inside a git repository.` }
  }
  return withRepoLock(canonical(repoRoot), () => prepareLocked(repoRoot, opts))
}

async function prepareLocked(repoRoot: string, opts: PrepareWorktreeOptions): Promise<WorktreeResult> {
  const { branch } = opts
  const candidates = managedPaths(repoRoot, opts.ownerId)
  const owned = new Set(candidates.map(canonical))
  if (opts.ownedPath) owned.add(canonical(opts.ownedPath))

  try {
    // Prune only drops registrations whose directories are gone; it never touches files.
    await git(['worktree', 'prune'], repoRoot).catch((e: unknown) => {
      console.warn('[worktree] prune failed:', errorText(e))
    })
    const worktrees = await listWorktrees(repoRoot)

    // 1. The branch is already checked out somewhere.
    const holder = worktrees.find(w => w.branch === branch)
    if (holder) {
      if (owned.has(holder.path) && existsSync(holder.path)) {
        console.log(`[worktree] Reusing existing worktree ${holder.path} (branch: ${branch})`)
        return { ok: true, path: holder.path, branch, repoRoot, reused: true }
      }
      return {
        ok: false,
        code: 'branch_in_use',
        message: `Branch ${branch} is already checked out at ${holder.path}.`,
      }
    }

    // 2. Pick a free managed path. Occupied paths are skipped, never deleted.
    const registered = new Set(worktrees.map(w => w.path))
    let worktreePath: string | undefined
    for (const candidate of candidates) {
      if (!existsSync(candidate)) {
        worktreePath = candidate
        break
      }
      if (!registered.has(canonical(candidate)) && isEmptyDir(candidate)) {
        rmdirSync(candidate) // non-recursive: only succeeds on an empty directory
        worktreePath = candidate
        break
      }
      console.warn(`[worktree] Path ${candidate} is occupied — trying the next candidate`)
    }
    if (!worktreePath) {
      return {
        ok: false,
        code: 'path_collision',
        message: `Every worktree location for ${path.basename(candidates[0])} is already occupied. Remove unused worktrees and retry.`,
      }
    }

    // 3. Decide how to attach the branch.
    const branchExists = await refExists(`refs/heads/${branch}`, repoRoot)
    let baseRef: string | undefined
    let args: string[]
    if (branchExists) {
      const base = opts.generatedBranch ? (opts.baseBranch ?? await detectDefaultBranch(repoRoot)) : undefined
      const unique = base
        ? Number((await git(['rev-list', '--count', `${base}..${branch}`], repoRoot).catch(() => '1')).trim())
        : 1
      if (base && unique === 0) {
        // A generated branch with no commits of its own: restart it from the base.
        baseRef = base
        args = ['worktree', 'add', '-B', branch, worktreePath, base]
      } else {
        args = ['worktree', 'add', worktreePath, branch]
      }
    } else {
      baseRef = opts.baseBranch ?? await detectDefaultBranch(repoRoot) ?? undefined
      args = ['worktree', 'add', '-b', branch, worktreePath]
      if (baseRef) args.push(baseRef)
    }
    const baseCommit = await resolveCommit(baseRef ?? 'HEAD', repoRoot)

    try {
      await git(args, repoRoot, 15000)
    } catch (err) {
      await rollbackFailedAdd(repoRoot, worktreePath, branch, branchExists, baseCommit)
      return { ok: false, code: 'git_failed', message: `git worktree add failed: ${errorText(err)}` }
    }

    console.log(`[worktree] Created worktree ${worktreePath} (branch: ${branch}${baseRef ? ` from ${baseRef}` : ''})`)
    return { ok: true, path: worktreePath, branch, repoRoot, baseRef, baseCommit, reused: false }
  } catch (err) {
    return { ok: false, code: 'git_failed', message: errorText(err) }
  }
}

/**
 * Undo only what a failed `git worktree add` provably created: an empty or
 * clean worktree at the new path, and a new branch still at its start commit.
 */
async function rollbackFailedAdd(
  repoRoot: string, worktreePath: string, branch: string, branchExisted: boolean, startCommit?: string,
): Promise<void> {
  if (existsSync(worktreePath)) {
    if (isEmptyDir(worktreePath)) {
      try { rmdirSync(worktreePath) } catch { /* leave it */ }
    } else {
      await git(['worktree', 'remove', worktreePath], repoRoot).catch((e: unknown) => {
        console.warn(`[worktree] Left partial worktree ${worktreePath} in place:`, errorText(e))
      })
    }
  }
  if (!branchExisted && startCommit && await refExists(`refs/heads/${branch}`, repoRoot)) {
    const tip = await resolveCommit(`refs/heads/${branch}`, repoRoot)
    if (tip === startCommit) {
      await git(['branch', '-D', branch], repoRoot).catch((e: unknown) => {
        console.warn(`[worktree] Could not remove new branch ${branch}:`, errorText(e))
      })
    }
  }
}

/**
 * Remove a worktree without force. Git refuses when it has modified or
 * untracked files; the worktree is then retained and the reason returned.
 * The branch is always kept.
 */
export async function removeWorktree(worktreePath: string, repoDir: string): Promise<RemoveWorktreeResult> {
  const repoRoot = await resolveRepoRoot(repoDir) ?? repoDir
  return withRepoLock(canonical(repoRoot), async () => {
    try {
      if (existsSync(worktreePath)) {
        await git(['worktree', 'remove', worktreePath], repoRoot, 10000)
      }
      await git(['worktree', 'prune'], repoRoot).catch((e: unknown) => {
        console.warn('[worktree] prune after cleanup failed:', errorText(e))
      })
      return { removed: true }
    } catch (err) {
      return { removed: false, reason: errorText(err) }
    }
  })
}
