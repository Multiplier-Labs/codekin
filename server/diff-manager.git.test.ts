/** Tests for DiffManager branch review against real temporary git repositories: merge-base views, base selection, untracked files, error honesty and discard guards. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DiffManager } from './diff-manager.js'
import type { WsServerMessage } from './types.js'

type DiffResult = Extract<WsServerMessage, { type: 'diff_result' }>
type DiffError = Extract<WsServerMessage, { type: 'diff_error' }>

let root: string
let repo: string
const dm = new DiffManager()

function git(args: string[], cwd = repo): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function write(file: string, content: string, cwd = repo): void {
  writeFileSync(join(cwd, file), content)
}

function commit(file: string, content: string, message: string, cwd = repo): string {
  write(file, content, cwd)
  git(['add', file], cwd)
  git(['commit', '-q', '-m', message], cwd)
  return git(['rev-parse', 'HEAD'], cwd)
}

async function diff(view: Parameters<DiffManager['getDiff']>[1], base?: Parameters<DiffManager['getDiff']>[2]): Promise<DiffResult> {
  const result = await dm.getDiff(repo, view, base)
  if (result.type !== 'diff_result') throw new Error(`expected diff_result, got ${JSON.stringify(result)}`)
  return result
}

async function diffError(view: Parameters<DiffManager['getDiff']>[1], base?: Parameters<DiffManager['getDiff']>[2]): Promise<DiffError> {
  const result = await dm.getDiff(repo, view, base)
  if (result.type !== 'diff_error') throw new Error(`expected diff_error, got ${result.type}`)
  return result
}

const paths = (r: DiffResult) => r.files.map(f => f.path).sort()

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codekin-diff-')))
  repo = join(root, 'proj')
  mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  commit('README.md', 'hello\n', 'initial')
  commit('app.ts', 'export const a = 1\n', 'app')
  git(['checkout', '-q', '-b', 'feat/login'])
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('branch review views', () => {
  it('shows committed work that the uncommitted view misses', async () => {
    commit('login.ts', 'export const login = true\n', 'add login')

    expect((await diff('all')).files).toEqual([])
    const branch = await diff('branch')
    expect(paths(branch)).toEqual(['login.ts'])
    expect(branch.review).toMatchObject({ baseRef: 'main', baseSource: 'default', mergeBase: git(['rev-parse', 'main']), head: git(['rev-parse', 'HEAD']) })
    expect(branch.review!.candidates).toContain('main')
    expect(paths(await diff('committed'))).toEqual(['login.ts'])
  })

  it('combines committed, modified and untracked files in the task view only', async () => {
    commit('login.ts', 'export const login = true\n', 'add login')
    write('app.ts', 'export const a = 2\n')
    write('notes.md', 'todo\n')

    const branch = await diff('branch')
    expect(paths(branch)).toEqual(['app.ts', 'login.ts', 'notes.md'])
    // Committed-only files are unmarked; edited and new files are flagged.
    expect(branch.files.filter(f => f.uncommitted).map(f => f.path).sort()).toEqual(['app.ts', 'notes.md'])
    expect(branch.summary.uncommittedFiles).toBe(2)
    const committed = await diff('committed')
    expect(paths(committed)).toEqual(['login.ts'])
    expect(committed.summary.uncommittedFiles).toBeUndefined()
    expect(committed.files.some(f => f.uncommitted)).toBe(false)
    expect(paths(await diff('all'))).toEqual(['app.ts', 'notes.md'])
  })

  it('excludes changes that landed on the base after the branch started', async () => {
    commit('login.ts', 'x\n', 'add login')
    git(['checkout', '-q', 'main'])
    commit('hotfix.ts', 'fix\n', 'hotfix on main')
    git(['checkout', '-q', 'feat/login'])

    expect(paths(await diff('branch'))).toEqual(['login.ts'])
  })

  it('uses the more recent fork point when origin is ahead of a stale local base', async () => {
    const forkPoint = git(['rev-parse', 'main'])
    git(['checkout', '-q', 'main'])
    const upstreamWork = commit('upstream.ts', 'u\n', 'upstream change')
    git(['update-ref', 'refs/remotes/origin/main', upstreamWork])
    git(['reset', '-q', '--hard', forkPoint])  // local main is stale
    git(['checkout', '-q', '-b', 'feat/rebased', 'origin/main'])
    commit('mine.ts', 'm\n', 'my change')

    const branch = await diff('branch')

    expect(paths(branch)).toEqual(['mine.ts'])
    expect(branch.review).toMatchObject({ baseRef: 'origin/main', mergeBase: upstreamWork })
  })

  it("honors the preferred base and reports where it came from", async () => {
    git(['branch', 'develop'])
    commit('login.ts', 'x\n', 'add login')

    const r = await diff('branch', { ref: 'develop', source: 'user' })

    expect(r.review).toMatchObject({ baseRef: 'develop', baseSource: 'user' })
    expect(paths(r)).toEqual(['login.ts'])
  })

  it('reports renames and binary files in the branch view', async () => {
    git(['mv', 'app.ts', 'main.ts'])
    git(['commit', '-q', '-m', 'rename'])
    writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255]))
    git(['add', 'logo.bin'])
    git(['commit', '-q', '-m', 'binary'])

    const files = (await diff('branch')).files
    expect(files.find(f => f.path === 'main.ts')?.status).toBe('renamed')
    expect(files.find(f => f.path === 'logo.bin')?.isBinary).toBe(true)
  })
})

describe('actionable failures instead of empty diffs', () => {
  it('explains a base that does not exist', async () => {
    const err = await diffError('branch', { ref: 'nope', source: 'user' })
    expect(err.message).toContain('"nope" does not exist')
  })

  it('explains unrelated history', async () => {
    git(['checkout', '-q', '--orphan', 'island'])
    git(['rm', '-rq', '--cached', '.'])
    commit('solo.txt', 's\n', 'unrelated root')

    const err = await diffError('branch', { ref: 'main', source: 'user' })
    expect(err.message).toContain('no common history')
  })

  it('explains a repository without commits', async () => {
    const fresh = join(root, 'fresh')
    mkdirSync(fresh)
    git(['init', '-q', '-b', 'main'], fresh)
    write('a.txt', 'a\n', fresh)
    git(['add', 'a.txt'], fresh)

    const result = await dm.getDiff(fresh, 'branch')
    expect(result).toMatchObject({ type: 'diff_error' })
    expect((result as DiffError).message).toContain('no commits yet')
    // The uncommitted view still works before the first commit.
    const all = await dm.getDiff(fresh, 'all')
    expect(all.type === 'diff_result' && all.files.map(f => f.path)).toEqual(['a.txt'])
  })

  it('reports a directory that is not a repository as an error, not "no changes"', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)

    for (const view of ['all', 'staged', 'unstaged'] as const) {
      expect((await dm.getDiff(plain, view)).type).toBe('diff_error')
    }
  })

  it('marks large untracked files as listed without content', async () => {
    writeFileSync(join(repo, 'big.log'), 'x'.repeat(1024 * 1024 + 1))

    const r = await diff('branch')
    expect(r.files.find(f => f.path === 'big.log')?.isBinary).toBe(true)
    expect(r.incomplete).toEqual(['1 untracked file(s) over 1 MB are listed without content.'])
  })
})

describe('discard guard', () => {
  it('refuses to discard from branch views and leaves files alone', async () => {
    write('app.ts', 'changed\n')

    for (const view of ['branch', 'committed'] as const) {
      const result = await dm.discardChanges(repo, view as never, ['app.ts'])
      expect(result).toMatchObject({ type: 'diff_error' })
    }
    expect(paths(await diff('all'))).toEqual(['app.ts'])
  })
})

describe('getChangeSummary', () => {
  it('counts nothing on a fresh branch', async () => {
    expect(await dm.getChangeSummary(repo)).toEqual({ uncommittedFiles: 0, branchCommits: 0 })
  })

  it('counts commits on the branch even when the working tree is clean', async () => {
    commit('login.ts', 'x\n', 'add login')
    commit('logout.ts', 'y\n', 'add logout')

    expect(await dm.getChangeSummary(repo)).toEqual({ uncommittedFiles: 0, branchCommits: 2 })
  })

  it('counts modified and untracked files', async () => {
    commit('login.ts', 'x\n', 'add login')
    write('app.ts', 'changed\n')
    write('notes.md', 'todo\n')

    expect(await dm.getChangeSummary(repo)).toEqual({ uncommittedFiles: 2, branchCommits: 1 })
  })

  it('uses the preferred base', async () => {
    commit('login.ts', 'x\n', 'add login')
    git(['branch', 'checkpoint'])
    commit('logout.ts', 'y\n', 'add logout')

    expect((await dm.getChangeSummary(repo, { ref: 'checkpoint', source: 'user' })).branchCommits).toBe(1)
  })

  it('reports unknown commits outside a repository or before the first commit', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)
    expect(await dm.getChangeSummary(plain)).toEqual({ uncommittedFiles: 0, branchCommits: null })

    const fresh = join(root, 'fresh')
    mkdirSync(fresh)
    git(['init', '-q', '-b', 'main'], fresh)
    write('a.txt', 'a\n', fresh)
    expect(await dm.getChangeSummary(fresh)).toEqual({ uncommittedFiles: 1, branchCommits: null })
  })
})
