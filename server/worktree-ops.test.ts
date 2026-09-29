/** Tests for worktree-ops — runs real git against temporary repositories to verify worktrees are created, reused and removed without destroying work. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareWorktree, removeWorktree, type WorktreeCreated } from './worktree-ops.js'

let root: string
let repo: string

function git(args: string[], cwd = repo): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function commit(cwd: string, file: string, content: string, message: string): string {
  writeFileSync(join(cwd, file), content)
  git(['add', file], cwd)
  git(['commit', '-q', '-m', message], cwd)
  return git(['rev-parse', 'HEAD'], cwd)
}

function branchExists(branch: string): boolean {
  try {
    git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

async function created(opts: Parameters<typeof prepareWorktree>[0]): Promise<WorktreeCreated> {
  const result = await prepareWorktree(opts)
  if (!result.ok) throw new Error(`expected success, got ${result.code}: ${result.message}`)
  return result
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codekin-wt-ops-')))
  repo = join(root, 'proj')
  mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  commit(repo, 'README.md', 'hello\n', 'initial')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('prepareWorktree', () => {
  it('creates a generated branch from the default branch as a sibling directory', async () => {
    const mainHead = git(['rev-parse', 'main'])
    const wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(wt.path).toBe(join(root, 'proj-wt-abcd1234'))
    expect(wt.repoRoot).toBe(repo)
    expect(wt.reused).toBe(false)
    expect(wt.baseRef).toBe('main')
    expect(wt.baseCommit).toBe(mainHead)
    expect(git(['rev-parse', '--abbrev-ref', 'HEAD'], wt.path)).toBe('wt/abcd1234')
  })

  it('resolves the main repository when called from inside a worktree', async () => {
    const first = await created({ sourceDir: repo, ownerId: 'aaaa1111', branch: 'wt/aaaa1111', generatedBranch: true })
    const second = await created({ sourceDir: first.path, ownerId: 'bbbb2222', branch: 'wt/bbbb2222', generatedBranch: true })

    expect(second.repoRoot).toBe(repo)
    expect(second.path).toBe(join(root, 'proj-wt-bbbb2222'))
  })

  it("reuses the owner's existing worktree without touching its changes", async () => {
    const first = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })
    writeFileSync(join(first.path, 'README.md'), 'edited\n')
    writeFileSync(join(first.path, 'notes.txt'), 'untracked\n')

    const again = await created({ sourceDir: first.path, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true, ownedPath: first.path })

    expect(again.reused).toBe(true)
    expect(again.path).toBe(first.path)
    expect(readFileSync(join(first.path, 'README.md'), 'utf-8')).toBe('edited\n')
    expect(readFileSync(join(first.path, 'notes.txt'), 'utf-8')).toBe('untracked\n')
  })

  it('skips an occupied directory instead of deleting it', async () => {
    const occupied = join(root, 'proj-wt-abcd1234')
    mkdirSync(occupied)
    writeFileSync(join(occupied, 'precious.txt'), 'keep me\n')

    const wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(wt.path).toBe(join(root, 'proj-wt-abcd1234-2'))
    expect(readFileSync(join(occupied, 'precious.txt'), 'utf-8')).toBe('keep me\n')
  })

  it('skips a registered worktree on another branch at the managed path', async () => {
    const other = join(root, 'proj-wt-abcd1234')
    git(['worktree', 'add', '-q', '-b', 'feat/other', other])
    writeFileSync(join(other, 'wip.txt'), 'in progress\n')

    const wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(wt.path).toBe(join(root, 'proj-wt-abcd1234-2'))
    expect(readFileSync(join(other, 'wip.txt'), 'utf-8')).toBe('in progress\n')
  })

  it('reclaims an empty leftover directory', async () => {
    mkdirSync(join(root, 'proj-wt-abcd1234'))

    const wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(wt.path).toBe(join(root, 'proj-wt-abcd1234'))
  })

  it('reports a collision when every managed path is occupied', async () => {
    for (const suffix of ['', '-2', '-3', '-4', '-5', '-6', '-7', '-8', '-9']) {
      const dir = join(root, `proj-wt-abcd1234${suffix}`)
      mkdirSync(dir)
      writeFileSync(join(dir, 'x'), 'x')
    }

    const result = await prepareWorktree({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(result).toMatchObject({ ok: false, code: 'path_collision' })
  })

  it('keeps commits on an existing generated branch', async () => {
    git(['branch', 'wt/abcd1234'])
    git(['checkout', '-q', 'wt/abcd1234'])
    const unique = commit(repo, 'feature.txt', 'work\n', 'agent work')
    git(['checkout', '-q', 'main'])

    const wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(git(['rev-parse', 'HEAD'], wt.path)).toBe(unique)
    expect(wt.baseRef).toBeUndefined()
  })

  it('restarts an unused generated branch from the current base', async () => {
    git(['branch', 'wt/abcd1234'])
    const advanced = commit(repo, 'later.txt', 'later\n', 'main moved on')

    const wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(git(['rev-parse', 'HEAD'], wt.path)).toBe(advanced)
    expect(wt.baseRef).toBe('main')
  })

  it('never resets a caller-supplied branch', async () => {
    git(['branch', 'fix/thing'])
    const old = git(['rev-parse', 'fix/thing'])
    commit(repo, 'later.txt', 'later\n', 'main moved on')

    const wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'fix/thing', generatedBranch: false })

    expect(git(['rev-parse', 'HEAD'], wt.path)).toBe(old)
  })

  it('refuses a branch that is checked out by someone else', async () => {
    git(['worktree', 'add', '-q', '-b', 'fix/taken', join(root, 'elsewhere')])

    const result = await prepareWorktree({ sourceDir: repo, ownerId: 'abcd1234', branch: 'fix/taken', generatedBranch: false })

    expect(result).toMatchObject({ ok: false, code: 'branch_in_use' })
  })

  it('reports a directory outside any repository', async () => {
    const plain = join(root, 'plain')
    mkdirSync(plain)

    const result = await prepareWorktree({ sourceDir: plain, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })

    expect(result).toMatchObject({ ok: false, code: 'not_a_git_repo' })
  })

  it('leaves no branch or directory behind when git worktree add fails', async () => {
    const result = await prepareWorktree({
      sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true, baseBranch: 'does-not-exist',
    })

    expect(result).toMatchObject({ ok: false, code: 'git_failed' })
    expect(branchExists('wt/abcd1234')).toBe(false)
    expect(existsSync(join(root, 'proj-wt-abcd1234'))).toBe(false)
  })

  it('serializes concurrent requests for the same repository', async () => {
    const results = await Promise.all(['a', 'b', 'c', 'd'].map(id =>
      prepareWorktree({ sourceDir: repo, ownerId: `${id}0000000`, branch: `wt/${id}0000000`, generatedBranch: true })))

    expect(results.every(r => r.ok)).toBe(true)
  })
})

describe('removeWorktree', () => {
  let wt: WorktreeCreated

  beforeEach(async () => {
    wt = await created({ sourceDir: repo, ownerId: 'abcd1234', branch: 'wt/abcd1234', generatedBranch: true })
  })

  it('removes a clean worktree and keeps its branch', async () => {
    const result = await removeWorktree(wt.path, repo)

    expect(result).toEqual({ removed: true })
    expect(existsSync(wt.path)).toBe(false)
    expect(branchExists('wt/abcd1234')).toBe(true)
  })

  it('removes a worktree whose only extra content is ignored', async () => {
    commit(wt.path, '.gitignore', 'node_modules/\n', 'ignore deps')
    mkdirSync(join(wt.path, 'node_modules'))
    writeFileSync(join(wt.path, 'node_modules', 'dep.js'), '')

    const result = await removeWorktree(wt.path, repo)

    expect(result.removed).toBe(true)
  })

  it('retains a worktree with uncommitted changes', async () => {
    writeFileSync(join(wt.path, 'README.md'), 'edited\n')

    const result = await removeWorktree(wt.path, repo)

    expect(result.removed).toBe(false)
    expect(result.reason).toBeTruthy()
    expect(readFileSync(join(wt.path, 'README.md'), 'utf-8')).toBe('edited\n')
  })

  it('retains a worktree with untracked files', async () => {
    writeFileSync(join(wt.path, 'new.txt'), 'new\n')

    const result = await removeWorktree(wt.path, repo)

    expect(result.removed).toBe(false)
    expect(existsSync(join(wt.path, 'new.txt'))).toBe(true)
  })

  it('treats an already-missing worktree as removed and prunes it', async () => {
    rmSync(wt.path, { recursive: true, force: true })

    const result = await removeWorktree(wt.path, repo)

    expect(result).toEqual({ removed: true })
    expect(git(['worktree', 'list'])).not.toContain('proj-wt-abcd1234')
  })
})
