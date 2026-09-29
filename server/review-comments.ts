/**
 * Anchored review comments: a reviewer selects lines in the Changes panel,
 * drafts comments, and sends them to the agent as one prompt.
 *
 * An anchor records where the comment points (file, side, line range), which
 * content that was (working tree, index, or an immutable commit) and the exact
 * lines — read here, on the server, never taken from the client — plus a
 * fingerprint of them. At send time a new-side anchor is compared with the
 * current working tree: if those lines changed or moved, the comment is stale
 * and is never silently re-attached elsewhere. Old-side (removed) lines come
 * from an immutable commit and cannot go stale.
 */

import { createHash, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { execGit } from './diff-manager.js'
import type { DiffView, ReviewAnchor, ReviewComment } from './types.js'

/** Longest range one comment may anchor to. */
export const MAX_ANCHOR_LINES = 200
/** Longest comment body. */
export const MAX_COMMENT_LENGTH = 10_000
/** Comments kept per session (drafts and sent). */
export const MAX_COMMENTS_PER_SESSION = 200

export interface AnchorInput {
  path: string
  side: 'new' | 'old'
  startLine: number
  endLine: number
  view: DiffView
  /** Merge base of a branch view (old side of 'branch'/'committed'). */
  baseCommit?: string
  /** HEAD a 'committed' view was computed at (its new side). */
  headCommit?: string
}

/** A comment author as known to the server. */
export interface ReviewAuthor {
  id: string
  role: 'owner' | 'grantee'
}

class AnchorError extends Error {}

function fingerprint(lines: string[]): string {
  return createHash('sha256').update(lines.join('\n')).digest('hex').slice(0, 16)
}

/** Reject paths that could leave the working directory. */
function checkPath(cwd: string, rel: string): string {
  if (!rel || rel.includes('\0') || rel.split(/[\\/]/).includes('..') || path.isAbsolute(rel)) {
    throw new AnchorError(`Invalid path: ${rel}`)
  }
  const root = path.resolve(cwd)
  const full = path.resolve(root, rel)
  if (!full.startsWith(root + path.sep)) throw new AnchorError(`Path escapes the working directory: ${rel}`)
  return full
}

async function verifyCommit(sha: string | undefined, cwd: string, what: string): Promise<string> {
  if (!sha || !/^[0-9a-f]{7,64}$/i.test(sha)) throw new AnchorError(`Missing or invalid ${what} commit.`)
  try {
    return (await execGit(['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], cwd)).trim()
  } catch {
    throw new AnchorError(`The ${what} commit ${sha.slice(0, 8)} is not in this repository.`)
  }
}

/** Which content a side of a view shows. */
async function resolveSource(cwd: string, input: AnchorInput): Promise<Pick<ReviewAnchor, 'source' | 'commit'>> {
  const { view, side } = input
  if (side === 'new') {
    if (view === 'staged') return { source: 'index' }
    if (view === 'committed') return { source: 'commit', commit: await verifyCommit(input.headCommit, cwd, 'head') }
    return { source: 'worktree' }
  }
  if (view === 'branch' || view === 'committed') return { source: 'commit', commit: await verifyCommit(input.baseCommit, cwd, 'base') }
  if (view === 'unstaged') return { source: 'index' }
  const head = (await execGit(['rev-parse', '--verify', '--quiet', 'HEAD'], cwd).catch(() => '')).trim()
  if (!head) throw new AnchorError('This branch has no commits, so removed lines cannot be anchored.')
  return { source: 'commit', commit: head }
}

function splitLines(text: string): string[] {
  const lines = text.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

/** Read a file's lines from the working tree, the index, or a commit; null if absent. */
async function readLines(cwd: string, rel: string, source: ReviewAnchor['source'], commit?: string): Promise<string[] | null> {
  const full = checkPath(cwd, rel)
  try {
    if (source === 'worktree') return splitLines(await fs.readFile(full, 'utf-8'))
    const spec = source === 'index' ? `:${rel}` : `${commit}:${rel}`
    return splitLines(await execGit(['show', spec], cwd))
  } catch {
    return null
  }
}

/** Build an anchor from the file content the server reads itself. */
export async function createAnchor(cwd: string, input: AnchorInput): Promise<ReviewAnchor> {
  const { startLine, endLine } = input
  const side: string = input.side  // client input: check at runtime
  if (side !== 'new' && side !== 'old') throw new AnchorError('Invalid side.')
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    throw new AnchorError('Invalid line range.')
  }
  if (endLine - startLine + 1 > MAX_ANCHOR_LINES) throw new AnchorError(`A comment can cover at most ${MAX_ANCHOR_LINES} lines.`)
  const { source, commit } = await resolveSource(cwd, input)
  const lines = await readLines(cwd, input.path, source, commit)
  if (!lines) throw new AnchorError(`${input.path} is not available in the selected version.`)
  if (endLine > lines.length) throw new AnchorError(`${input.path} has only ${lines.length} line(s).`)
  const excerpt = lines.slice(startLine - 1, endLine)
  return {
    path: input.path, side: input.side, startLine, endLine, view: input.view,
    source, ...(commit ? { commit } : {}), excerpt, fingerprint: fingerprint(excerpt),
  }
}

/**
 * Whether the code a comment points at has changed in the working tree.
 * Removed-line anchors refer to an immutable commit and are never stale.
 */
export async function isAnchorStale(cwd: string, anchor: ReviewAnchor): Promise<boolean> {
  if (anchor.side === 'old') return false
  const lines = await readLines(cwd, anchor.path, 'worktree').catch(() => null)
  if (!lines || anchor.endLine > lines.length) return true
  return fingerprint(lines.slice(anchor.startLine - 1, anchor.endLine)) !== anchor.fingerprint
}

/** Validate a comment body. */
export function checkBody(body: unknown): string {
  if (typeof body !== 'string' || !body.trim()) throw new AnchorError('The comment is empty.')
  if (body.length > MAX_COMMENT_LENGTH) throw new AnchorError(`A comment can be at most ${MAX_COMMENT_LENGTH} characters.`)
  return body.trim()
}

export function newComment(anchor: ReviewAnchor, body: string, author: ReviewAuthor): ReviewComment {
  return {
    id: randomUUID(), body, anchor, status: 'draft',
    author: author.id, authorRole: author.role, createdAt: new Date().toISOString(),
  }
}

/** Owners may change any comment; others only their own. */
export function canModify(comment: ReviewComment, author: ReviewAuthor): boolean {
  return author.role === 'owner' || comment.author === author.id
}

/** A user-facing message for anchor/validation failures (other errors propagate). */
export function anchorErrorMessage(err: unknown): string | null {
  return err instanceof AnchorError ? err.message : null
}

function lineLabel(a: ReviewAnchor): string {
  return a.startLine === a.endLine ? `line ${a.startLine}` : `lines ${a.startLine}–${a.endLine}`
}

function fence(lines: string[]): string {
  const longest = Math.max(2, ...lines.map(l => /`+/.exec(l)?.[0].length ?? 0))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}\n${lines.join('\n')}\n${ticks}`
}

/** One prompt for a batch of comments, in file and line order. */
export function buildFeedbackPrompt(comments: { comment: ReviewComment; stale: boolean }[]): string {
  const sorted = [...comments].sort((a, b) =>
    a.comment.anchor.path.localeCompare(b.comment.anchor.path) || a.comment.anchor.startLine - b.comment.anchor.startLine)
  const parts = [
    `Review feedback on your changes (${sorted.length} comment${sorted.length === 1 ? '' : 's'}).`,
    'Address each comment. The quoted code is exactly what the reviewer saw.',
  ]
  sorted.forEach(({ comment, stale }, i) => {
    const a = comment.anchor
    const where = a.side === 'old'
      ? `${a.path}, removed ${lineLabel(a)} (as in ${a.commit?.slice(0, 8) ?? 'the base'})`
      : `${a.path}, ${lineLabel(a)}${a.source === 'commit' && a.commit ? ` (as committed in ${a.commit.slice(0, 8)})` : ''}`
    parts.push(`${i + 1}. ${where}${stale ? '\n   Note: this code has changed since the comment was written; it refers to the quoted original.' : ''}`)
    parts.push(fence(a.excerpt))
    parts.push(comment.body)
  })
  return parts.join('\n\n')
}
