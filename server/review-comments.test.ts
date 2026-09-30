/** Tests for review-comments — anchors read from real temporary git repos (worktree, index, commits, removed lines), staleness for edited/moved/deleted code, validation, and the batched feedback prompt. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  anchorErrorMessage, buildFeedbackPrompt, canModify, createAnchor, isAnchorStale, newComment, type AnchorInput,
} from './review-comments.js'

let root: string
let repo: string
let base: string
let head: string

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function write(file: string, lines: string[]): void {
  writeFileSync(join(repo, file), lines.join('\n') + '\n')
}

async function anchorError(input: AnchorInput): Promise<string> {
  try {
    await createAnchor(repo, input)
  } catch (err) {
    return anchorErrorMessage(err) ?? `unexpected: ${String(err)}`
  }
  throw new Error('expected createAnchor to fail')
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codekin-review-')))
  repo = join(root, 'proj')
  mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  write('app.ts', ['const a = 1', 'const b = 2', 'const c = 3', 'export { a, b, c }'])
  git(['add', '.'])
  git(['commit', '-q', '-m', 'base'])
  base = git(['rev-parse', 'HEAD'])
  git(['checkout', '-q', '-b', 'feat/x'])
  write('app.ts', ['const a = 1', 'const b = 20', 'const d = 4', 'export { a, b, d }'])
  git(['commit', '-qam', 'change'])
  head = git(['rev-parse', 'HEAD'])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('createAnchor', () => {
  it('reads new-side lines from the working tree for task views', async () => {
    const a = await createAnchor(repo, { path: 'app.ts', side: 'new', startLine: 2, endLine: 3, view: 'branch', baseCommit: base })

    expect(a).toMatchObject({ source: 'worktree', excerpt: ['const b = 20', 'const d = 4'] })
    expect(a.fingerprint).toMatch(/^[0-9a-f]{16}$/)
  })

  it('reads removed lines from the merge base, and committed lines from HEAD', async () => {
    const removed = await createAnchor(repo, { path: 'app.ts', side: 'old', startLine: 3, endLine: 3, view: 'branch', baseCommit: base })
    expect(removed).toMatchObject({ source: 'commit', commit: base, excerpt: ['const c = 3'] })

    write('app.ts', ['// uncommitted edit'])
    const committed = await createAnchor(repo, { path: 'app.ts', side: 'new', startLine: 1, endLine: 2, view: 'committed', baseCommit: base, headCommit: head })
    expect(committed).toMatchObject({ source: 'commit', commit: head, excerpt: ['const a = 1', 'const b = 20'] })
  })

  it('reads staged lines from the index and removed uncommitted lines from HEAD', async () => {
    write('app.ts', ['staged line'])
    git(['add', 'app.ts'])
    write('app.ts', ['unstaged line'])

    expect((await createAnchor(repo, { path: 'app.ts', side: 'new', startLine: 1, endLine: 1, view: 'staged' })).excerpt).toEqual(['staged line'])
    expect((await createAnchor(repo, { path: 'app.ts', side: 'old', startLine: 2, endLine: 2, view: 'all' })).excerpt).toEqual(['const b = 20'])
    expect((await createAnchor(repo, { path: 'app.ts', side: 'old', startLine: 1, endLine: 1, view: 'unstaged' })).excerpt).toEqual(['staged line'])
  })

  it('rejects paths outside the repository, bad ranges and unknown commits', async () => {
    expect(await anchorError({ path: '../secret', side: 'new', startLine: 1, endLine: 1, view: 'all' })).toContain('Invalid path')
    expect(await anchorError({ path: '/etc/passwd', side: 'new', startLine: 1, endLine: 1, view: 'all' })).toContain('Invalid path')
    expect(await anchorError({ path: 'app.ts', side: 'new', startLine: 3, endLine: 2, view: 'all' })).toContain('Invalid line range')
    expect(await anchorError({ path: 'app.ts', side: 'new', startLine: 1, endLine: 9, view: 'all' })).toContain('only 4 line(s)')
    expect(await anchorError({ path: 'app.ts', side: 'new', startLine: 1, endLine: 500, view: 'all' })).toContain('at most 200 lines')
    expect(await anchorError({ path: 'app.ts', side: 'old', startLine: 1, endLine: 1, view: 'branch', baseCommit: 'deadbeef' })).toContain('not in this repository')
    expect(await anchorError({ path: 'app.ts', side: 'old', startLine: 1, endLine: 1, view: 'branch', baseCommit: '--output=x' })).toContain('invalid base')
    expect(await anchorError({ path: 'missing.ts', side: 'new', startLine: 1, endLine: 1, view: 'all' })).toContain('not available')
  })
})

describe('isAnchorStale', () => {
  const input: AnchorInput = { path: 'app.ts', side: 'new', startLine: 2, endLine: 3, view: 'branch', baseCommit: '' }

  it('is fresh while the lines are unchanged, even if other lines change', async () => {
    const a = await createAnchor(repo, input)
    write('app.ts', ['const a = 100', 'const b = 20', 'const d = 4', 'export { a, b, d }', '// more'])

    expect(await isAnchorStale(repo, a)).toBe(false)
  })

  it('is stale when the lines are edited', async () => {
    const a = await createAnchor(repo, input)
    write('app.ts', ['const a = 1', 'const b = 21', 'const d = 4', 'export { a, b, d }'])

    expect(await isAnchorStale(repo, a)).toBe(true)
  })

  it('is stale when the lines move, rather than following them', async () => {
    const a = await createAnchor(repo, input)
    write('app.ts', ['// new header', 'const a = 1', 'const b = 20', 'const d = 4', 'export { a, b, d }'])

    expect(await isAnchorStale(repo, a)).toBe(true)
  })

  it('is stale when the file is deleted or shortened', async () => {
    const a = await createAnchor(repo, input)
    rmSync(join(repo, 'app.ts'))

    expect(await isAnchorStale(repo, a)).toBe(true)
  })

  it('never marks removed-line anchors stale', async () => {
    const a = await createAnchor(repo, { path: 'app.ts', side: 'old', startLine: 3, endLine: 3, view: 'branch', baseCommit: base })
    rmSync(join(repo, 'app.ts'))

    expect(await isAnchorStale(repo, a)).toBe(false)
  })
})

describe('buildFeedbackPrompt', () => {
  it('orders comments by file and line, quotes the code, and flags stale originals', async () => {
    const author = { id: 'owner', role: 'owner' as const }
    write('b.md', ['has ``` fences'])
    const later = newComment(await createAnchor(repo, { path: 'app.ts', side: 'new', startLine: 4, endLine: 4, view: 'all' }), 'Export c too?', author)
    const earlier = newComment(await createAnchor(repo, { path: 'app.ts', side: 'new', startLine: 2, endLine: 3, view: 'all' }), 'Why 20?', author)
    const removed = newComment(await createAnchor(repo, { path: 'app.ts', side: 'old', startLine: 3, endLine: 3, view: 'branch', baseCommit: base }), 'Keep c', author)
    const fenced = newComment(await createAnchor(repo, { path: 'b.md', side: 'new', startLine: 1, endLine: 1, view: 'all' }), 'Fence', author)

    const prompt = buildFeedbackPrompt([
      { comment: later, stale: false }, { comment: earlier, stale: true }, { comment: removed, stale: false }, { comment: fenced, stale: false },
    ])

    expect(prompt).toContain('Review feedback on your changes (4 comments).')
    expect(prompt.indexOf('app.ts, lines 2–3')).toBeLessThan(prompt.indexOf('app.ts, line 4'))
    expect(prompt).toContain('```\nconst b = 20\nconst d = 4\n```\n\nWhy 20?')
    expect(prompt).toContain('this code has changed since the comment was written')
    expect(prompt).toContain(`app.ts, removed line 3 (as in ${base.slice(0, 8)})`)
    expect(prompt).toContain('````\nhas ``` fences\n````')
  })
})

describe('canModify', () => {
  it('lets owners change anything and others only their own comments', async () => {
    const c = newComment(await createAnchor(repo, { path: 'app.ts', side: 'new', startLine: 1, endLine: 1, view: 'all' }), 'x', { id: 'u1', role: 'grantee' })

    expect(canModify(c, { id: 'owner', role: 'owner' })).toBe(true)
    expect(canModify(c, { id: 'u1', role: 'grantee' })).toBe(true)
    expect(canModify(c, { id: 'u2', role: 'grantee' })).toBe(false)
  })
})
