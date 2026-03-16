/**
 * Stateless git-diff operations extracted from SessionManager.
 *
 * All functions operate on a working directory path and have no dependency
 * on session state, making them independently testable.
 */

import { execFile } from 'child_process'
import { promises as fs } from 'fs'
import path from 'path'
import { promisify } from 'util'
import type { DiffFileStatus, DiffScope, DiffSummary, WsServerMessage } from './types.js'
import { parseDiff, createUntrackedFileDiff } from './diff-parser.js'

const execFileAsync = promisify(execFile)

/**
 * Return a copy of process.env with GIT_* vars removed that can interfere
 * with child git processes (e.g. GIT_INDEX_FILE, GIT_DIR, GIT_PREFIX).
 * The server may inherit these from the shell that launched pm2/node.
 */
export function cleanGitEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_') && key !== 'GIT_EDITOR') delete env[key]
  }
  return env
}

/** Max stdout for git commands (2 MB). */
const GIT_MAX_BUFFER = 2 * 1024 * 1024
/** Timeout for git commands (10 seconds). */
const GIT_TIMEOUT_MS = 10_000
/** Max paths per git command to stay under ARG_MAX (~128 KB on Linux). */
const GIT_PATH_CHUNK_SIZE = 200

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

/**
 * Run git diff in a working directory and return structured results.
 * Includes untracked file discovery for 'unstaged' and 'all' scopes.
 */
export async function getDiff(cwd: string, scope: DiffScope = 'all'): Promise<WsServerMessage> {
  try {
    // Get branch name
    let branch: string
    try {
      const branchResult = await execGit(['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
      branch = branchResult.trim()
      if (branch === 'HEAD') {
        const shaResult = await execGit(['rev-parse', '--short', 'HEAD'], cwd)
        branch = `detached at ${shaResult.trim()}`
      }
    } catch {
      branch = 'unknown'
    }

    // Build diff command based on scope
    const diffArgs = ['diff', '--find-renames', '--no-color', '--unified=3']
    if (scope === 'staged') {
      diffArgs.push('--cached')
    } else if (scope === 'all') {
      diffArgs.push('HEAD')
    }

    let rawDiff: string
    try {
      rawDiff = await execGit(diffArgs, cwd)
    } catch {
      if (scope === 'all') {
        const [staged, unstaged] = await Promise.all([
          execGit(['diff', '--cached', '--find-renames', '--no-color', '--unified=3'], cwd).catch(() => ''),
          execGit(['diff', '--find-renames', '--no-color', '--unified=3'], cwd).catch(() => ''),
        ])
        rawDiff = staged + unstaged
      } else {
        rawDiff = ''
      }
    }

    const { files, truncated, truncationReason } = parseDiff(rawDiff)

    // Discover untracked files for 'unstaged' and 'all' scopes
    if (scope !== 'staged') {
      try {
        const untrackedRaw = await execGit(
          ['ls-files', '--others', '--exclude-standard'],
          cwd,
        )
        const untrackedPaths = untrackedRaw.trim().split('\n').filter(Boolean)
        for (const relPath of untrackedPaths) {
          try {
            const fullPath = path.join(cwd, relPath)
            const content = await fs.readFile(fullPath, 'utf-8')
            files.push(createUntrackedFileDiff(relPath, content))
          } catch {
            files.push({
              path: relPath,
              status: 'added',
              isBinary: true,
              additions: 0,
              deletions: 0,
              hunks: [],
            })
          }
        }
      } catch {
        // ls-files failed — skip untracked
      }
    }

    const summary: DiffSummary = {
      filesChanged: files.length,
      insertions: files.reduce((sum, f) => sum + f.additions, 0),
      deletions: files.reduce((sum, f) => sum + f.deletions, 0),
      truncated,
      truncationReason,
    }

    return { type: 'diff_result', files, summary, branch, scope }
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to get diff'
    return { type: 'diff_error', message }
  }
}

/**
 * Discard changes in a working directory per the given scope and paths.
 * Returns a fresh diff_result after discarding.
 */
export async function discardChanges(
  cwd: string,
  scope: DiffScope,
  paths?: string[],
  statuses?: Record<string, DiffFileStatus>,
): Promise<WsServerMessage> {
  try {
    // Validate paths
    if (paths) {
      const root = path.join(path.resolve(cwd), path.sep)
      for (const p of paths) {
        if (p.includes('..') || path.isAbsolute(p)) {
          return { type: 'diff_error', message: `Invalid path: ${p}` }
        }
        const resolved = path.resolve(cwd, p)
        if (resolved !== path.resolve(cwd) && !resolved.startsWith(root)) {
          return { type: 'diff_error', message: `Path escapes working directory: ${p}` }
        }
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
    return await getDiff(cwd, scope)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to discard changes'
    return { type: 'diff_error', message }
  }
}
