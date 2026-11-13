/** Changes for an org session, against real git repositories in an org folder. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DiffManager } from './diff-manager.js'
import { discardOrgChanges, getOrgChangeSummary, getOrgDiff, orgReposFor } from './org-diff.js'
import type { WsServerMessage } from './types.js'

type DiffResult = Extract<WsServerMessage, { type: 'diff_result' }>

const SESSION = 'abcdef12-0000-0000-0000-000000000000'
const OTHER = '99999999-0000-0000-0000-000000000000'
const dm = new DiffManager()
let org: string

function git(args: string[], cwd: string): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function repo(name: string): string {
  const dir = join(org, name)
  mkdirSync(dir)
  git(['init', '-q', '-b', 'main'], dir)
  writeFileSync(join(dir, 'README.md'), `# ${name}\n`)
  git(['add', '.'], dir)
  git(['commit', '-q', '-m', 'init'], dir)
  return dir
}

async function diff(view: Parameters<typeof getOrgDiff>[3]): Promise<DiffResult> {
  const result = await getOrgDiff(dm, org, SESSION, view)
  if (result.type !== 'diff_result') throw new Error(`expected diff_result, got ${JSON.stringify(result)}`)
  return result
}

beforeEach(() => {
  org = join(realpathSync(mkdtempSync(join(tmpdir(), 'codekin-orgdiff-'))), 'acme-co')
  mkdirSync(org)
})
afterEach(() => { rmSync(join(org, '..'), { recursive: true, force: true }) })

describe('org session changes', () => {
  it('lists clones and only this session\'s worktrees', () => {
    const api = repo('api')
    repo('web')
    git(['worktree', 'add', '-q', '../api-wt-abcdef12', '-b', 'wt/abcdef12'], api)
    git(['worktree', 'add', '-q', '../api-wt-99999999', '-b', 'wt/99999999'], api)
    expect(orgReposFor(org, SESSION).map(r => [r.name, r.worktree])).toEqual([['api', false], ['web', false], ['api-wt-abcdef12', true]])
    expect(orgReposFor(org, OTHER).map(r => r.name)).toEqual(['api', 'web', 'api-wt-99999999'])
  })

  it('combines uncommitted changes across repositories, paths prefixed by repository', async () => {
    const api = repo('api')
    const web = repo('web')
    repo('docs')
    writeFileSync(join(api, 'README.md'), '# api\nchanged\n')
    writeFileSync(join(web, 'new.txt'), 'hello\n')
    const result = await diff('all')
    expect(result.files.map(f => f.path).sort()).toEqual(['api/README.md', 'web/new.txt'])
    expect(result.branch).toBe('2 repositories')
    expect(result.summary.filesChanged).toBe(2)
    expect(result.summary.insertions).toBeGreaterThanOrEqual(2)
    expect(await getOrgChangeSummary(dm, org, SESSION)).toEqual({ uncommittedFiles: 2, branchCommits: null })
  })

  it('branch views cover this session\'s worktrees, not the clones\' own history', async () => {
    const api = repo('api')
    writeFileSync(join(api, 'README.md'), '# api\nedited in the clone\n')
    git(['worktree', 'add', '-q', '../api-wt-abcdef12', '-b', 'wt/abcdef12'], api)
    const wt = join(org, 'api-wt-abcdef12')
    writeFileSync(join(wt, 'feature.txt'), 'x\n')
    git(['add', '.'], wt)
    git(['commit', '-q', '-m', 'feature'], wt)
    const committed = await diff('committed')
    expect(committed.files.map(f => f.path)).toEqual(['api-wt-abcdef12/feature.txt'])
    const summary = await getOrgChangeSummary(dm, org, SESSION)
    expect(summary.branchCommits).toBe(1)
    expect(summary.uncommittedFiles).toBe(1)
  })

  it('is empty, not an error, when nothing changed or nothing is cloned', async () => {
    expect((await diff('all')).files).toEqual([])
    repo('api')
    const result = await diff('all')
    expect(result.files).toEqual([])
    expect(result.branch).toBe('0 repositories')
  })

  it('discards per repository, and refuses paths outside the session\'s repositories', async () => {
    const api = repo('api')
    const web = repo('web')
    writeFileSync(join(api, 'README.md'), '# api\nchanged\n')
    writeFileSync(join(web, 'README.md'), '# web\nchanged\n')
    const after = await discardOrgChanges(dm, org, SESSION, 'all', ['api/README.md'])
    expect(after.type).toBe('diff_result')
    expect(readFileSync(join(api, 'README.md'), 'utf-8')).toBe('# api\n')
    expect((after as DiffResult).files.map(f => f.path)).toEqual(['web/README.md'])

    for (const bad of ['README.md', 'nope/README.md', '../x/README.md', 'web/']) {
      const refused = await discardOrgChanges(dm, org, SESSION, 'all', [bad])
      expect(refused.type).toBe('diff_error')
    }
    expect(readFileSync(join(web, 'README.md'), 'utf-8')).toBe('# web\nchanged\n')
  })

  it('discards everything when no paths are given', async () => {
    const api = repo('api')
    writeFileSync(join(api, 'new.txt'), 'x\n')
    const after = await discardOrgChanges(dm, org, SESSION, 'all')
    expect((after as DiffResult).files).toEqual([])
    expect(existsSync(join(api, 'new.txt'))).toBe(false)
  })
})
