/** Tests for pr-status — real temporary git repos with a fake gh runner: check summaries, local-vs-remote head, distinct unknown states, caching/staleness and the cached PR review base. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  _clearPrStatusCache, _setPrStatusRunner, cachedPrBaseFor, classifyGhError, getPrStatus, summarizeChecks,
} from './pr-status.js'

let root: string
let repo: string
let gh: ReturnType<typeof vi.fn>

function git(args: string[]): string {
  return execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

function commit(file: string, message: string): string {
  writeFileSync(join(repo, file), `${message}\n`)
  git(['add', file])
  git(['commit', '-q', '-m', message])
  return git(['rev-parse', 'HEAD'])
}

function pull(extra: Record<string, unknown> = {}) {
  return {
    number: 12, title: 'Add login', url: 'https://github.com/o/r/pull/12', state: 'OPEN', isDraft: false,
    baseRefName: 'main', headRefName: 'feat/login', headRefOid: git(['rev-parse', 'HEAD']),
    isCrossRepository: false, headRepositoryOwner: { login: 'o' }, updatedAt: '2026-09-29T10:00:00Z',
    statusCheckRollup: [], reviewDecision: '', ...extra,
  }
}

function ghReturns(pulls: unknown[]) {
  gh.mockResolvedValue(JSON.stringify(pulls))
}

function ghError(stderr: string, code?: string) {
  gh.mockRejectedValue(Object.assign(new Error('Command failed: gh'), { stderr, code }))
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'codekin-pr-')))
  repo = join(root, 'proj')
  mkdirSync(repo)
  git(['init', '-q', '-b', 'main'])
  commit('README.md', 'initial')
  git(['checkout', '-q', '-b', 'feat/login'])
  commit('login.ts', 'login')
  gh = vi.fn()
  _setPrStatusRunner(gh as unknown as (args: string[], cwd: string) => Promise<string>)
  _clearPrStatusCache()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('summarizeChecks', () => {
  it('counts check runs and commit statuses by outcome', () => {
    const summary = summarizeChecks([
      { __typename: 'CheckRun', name: 'lint', status: 'COMPLETED', conclusion: 'SUCCESS' },
      { __typename: 'CheckRun', name: 'test', status: 'COMPLETED', conclusion: 'FAILURE' },
      { __typename: 'CheckRun', name: 'e2e', status: 'IN_PROGRESS', conclusion: '' },
      { __typename: 'CheckRun', name: 'docs', status: 'COMPLETED', conclusion: 'SKIPPED' },
      { __typename: 'StatusContext', context: 'ci/legacy', state: 'ERROR' },
      { __typename: 'StatusContext', context: 'ci/wait', state: 'PENDING' },
    ])

    expect(summary).toEqual({ total: 6, passed: 1, failed: 2, pending: 2, skipped: 1, failing: ['test', 'ci/legacy'] })
  })

  it('treats a missing rollup as no checks', () => {
    expect(summarizeChecks(null)).toMatchObject({ total: 0, passed: 0, failed: 0, pending: 0 })
  })
})

describe('classifyGhError', () => {
  it.each([
    [Object.assign(new Error('spawn gh ENOENT'), { code: 'ENOENT' }), 'gh_missing'],
    [Object.assign(new Error('x'), { stderr: 'To get started with GitHub CLI, please run:  gh auth login' }), 'unauthenticated'],
    [Object.assign(new Error('x'), { stderr: 'HTTP 403: API rate limit exceeded' }), 'rate_limited'],
    [Object.assign(new Error('x'), { stderr: 'none of the git remotes configured for this repository point to a known GitHub host' }), 'no_github_remote'],
    [Object.assign(new Error('x'), { stderr: 'HTTP 502: Bad Gateway' }), 'error'],
  ])('classifies %#', (err, state) => {
    expect(classifyGhError(err).state).toBe(state)
  })
})

describe('getPrStatus', () => {
  it("reports the branch's pull request, checks and a clean in-sync tree", async () => {
    ghReturns([pull({ statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })])

    const status = await getPrStatus(repo)

    expect(gh).toHaveBeenCalledWith(expect.arrayContaining(['pr', 'list', '--head', 'feat/login', '--state', 'all']), repo)
    expect(status).toMatchObject({ state: 'found', branch: 'feat/login', dirty: false })
    expect(status.pulls[0]).toMatchObject({ number: 12, state: 'OPEN', ahead: 0, behind: 0, checks: { passed: 1, total: 1 } })
  })

  it('shows local commits not pushed and edits not checked', async () => {
    ghReturns([pull()])
    commit('more.ts', 'more work')
    writeFileSync(join(repo, 'wip.ts'), 'wip\n')

    const status = await getPrStatus(repo)

    expect(status.dirty).toBe(true)
    expect(status.pulls[0]).toMatchObject({ ahead: 1, behind: 0 })
  })

  it('reports unknown ahead/behind when the PR head is not fetched', async () => {
    ghReturns([pull({ headRefOid: 'a'.repeat(40) })])

    expect((await getPrStatus(repo)).pulls[0]).toMatchObject({ ahead: null, behind: null })
  })

  it('lists open PRs first and ignores other heads', async () => {
    ghReturns([
      pull({ number: 1, state: 'MERGED', updatedAt: '2026-09-29T12:00:00Z' }),
      pull({ number: 2, state: 'OPEN', updatedAt: '2026-09-28T12:00:00Z' }),
      pull({ number: 3, headRefName: 'feat/login-v2' }),
    ])

    expect((await getPrStatus(repo)).pulls.map(p => p.number)).toEqual([2, 1])
  })

  it('distinguishes "no pull request" from lookup failures', async () => {
    ghReturns([])
    expect(await getPrStatus(repo)).toMatchObject({ state: 'none', pulls: [] })

    _clearPrStatusCache()
    ghError('please run: gh auth login')
    expect(await getPrStatus(repo)).toMatchObject({ state: 'unauthenticated', pulls: [] })
  })

  it('reuses a recent lookup and refreshes on demand', async () => {
    ghReturns([pull()])

    await getPrStatus(repo)
    await getPrStatus(repo)
    expect(gh).toHaveBeenCalledTimes(1)

    await getPrStatus(repo, { refresh: true })
    expect(gh).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good result, marked stale, when a refresh fails', async () => {
    ghReturns([pull()])
    await getPrStatus(repo)
    ghError('HTTP 403: API rate limit exceeded')

    const status = await getPrStatus(repo, { refresh: true })

    expect(status.state).toBe('found')
    expect(status.pulls[0].number).toBe(12)
    expect(status.staleReason).toContain('rate limit')
  })

  it('does not look anything up for a detached HEAD', async () => {
    git(['checkout', '-q', '--detach'])

    expect(await getPrStatus(repo)).toMatchObject({ state: 'none' })
    expect(gh).not.toHaveBeenCalled()
  })
})

describe('cachedPrBaseFor', () => {
  it('uses the base of the single open same-repository PR, without calling gh', async () => {
    ghReturns([pull({ baseRefName: 'develop' })])
    await getPrStatus(repo)
    gh.mockClear()

    expect(await cachedPrBaseFor(repo)).toBe('develop')
    expect(gh).not.toHaveBeenCalled()
  })

  it('returns null before any lookup, for fork PRs, and when ambiguous', async () => {
    expect(await cachedPrBaseFor(repo)).toBeNull()

    ghReturns([pull({ isCrossRepository: true })])
    await getPrStatus(repo, { refresh: true })
    expect(await cachedPrBaseFor(repo)).toBeNull()

    ghReturns([pull({ number: 1 }), pull({ number: 2, baseRefName: 'develop' })])
    await getPrStatus(repo, { refresh: true })
    expect(await cachedPrBaseFor(repo)).toBeNull()
  })
})
