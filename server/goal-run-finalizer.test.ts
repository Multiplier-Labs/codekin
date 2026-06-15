/** Tests for the GoalRun finalizer — stubs the git/gh runners and asserts the
 * deterministic commit/push/PR sequence per completion policy, plus graceful
 * failure handling (verification already passed, so finalization never throws). */
import { describe, it, expect, afterEach } from 'vitest'
import { defaultFinalizer, _setFinalizerRunners, _resetFinalizerRunners, type FinalizeOptions } from './goal-run-finalizer.js'

afterEach(() => {
  _resetFinalizerRunners()
})

type Call = { args: string[]; cwd: string }

/** Wire stub runners, recording every git/gh invocation. */
function wire(opts: {
  status?: string
  git?: (args: string[]) => Promise<string>
  gh?: (args: string[]) => Promise<string>
}): { git: Call[]; gh: Call[] } {
  const git: Call[] = []
  const gh: Call[] = []
  _setFinalizerRunners(
    (args, cwd) => {
      git.push({ args, cwd })
      if (opts.git) return opts.git(args)
      if (args[0] === 'status') return Promise.resolve(opts.status ?? '')
      return Promise.resolve('')
    },
    (args, cwd) => {
      gh.push({ args, cwd })
      if (opts.gh) return opts.gh(args)
      return Promise.resolve('https://github.com/acme/repo/pull/42\n')
    },
  )
  return { git, gh }
}

const base: FinalizeOptions = { cwd: '/wt/feat', branch: 'fix/ci', policy: 'pr', title: 'fix ci', body: 'body' }

describe('defaultFinalizer', () => {
  it('commits a dirty tree, pushes, opens a PR and captures the url (policy=pr)', async () => {
    const rec = wire({ status: ' M src/a.ts\n' })
    const res = await defaultFinalizer.finalize(base)

    expect(res.prUrl).toBe('https://github.com/acme/repo/pull/42')
    expect(res.note).toContain('opened PR')
    expect(rec.git.map((c) => c.args)).toEqual([
      ['status', '--porcelain'],
      ['add', '-A'],
      ['commit', '-m', 'fix ci'],
      ['push', '-u', 'origin', 'fix/ci'],
    ])
    expect(rec.gh[0].args).toEqual(['pr', 'create', '--head', 'fix/ci', '--title', 'fix ci', '--body', 'body'])
    expect(rec.gh[0].cwd).toBe('/wt/feat')
  })

  it('skips the commit when the tree is clean', async () => {
    const rec = wire({ status: '   \n' })
    await defaultFinalizer.finalize(base)
    expect(rec.git.map((c) => c.args[0])).toEqual(['status', 'push'])
  })

  it('commits locally without pushing for policy=commit-only', async () => {
    const rec = wire({ status: ' M src/a.ts\n' })
    const res = await defaultFinalizer.finalize({ ...base, policy: 'commit-only' })
    expect(res.prUrl).toBeNull()
    expect(res.note).toContain('committed locally')
    expect(rec.git.map((c) => c.args[0])).toEqual(['status', 'add', 'commit'])
    expect(rec.gh).toHaveLength(0)
  })

  it('pushes without opening a PR for policy=merge', async () => {
    const rec = wire({ status: ' M src/a.ts\n' })
    const res = await defaultFinalizer.finalize({ ...base, policy: 'merge' })
    expect(res.prUrl).toBeNull()
    expect(res.note).toContain('pushed branch fix/ci')
    expect(rec.gh).toHaveLength(0)
  })

  it('records a failure note (and never throws) when the push fails', async () => {
    const rec = wire({
      status: ' M src/a.ts\n',
      git: (args) => (args[0] === 'push' ? Promise.reject(new Error('no upstream')) : Promise.resolve('')),
    })
    const res = await defaultFinalizer.finalize(base)
    expect(res.prUrl).toBeNull()
    expect(res.note).toContain('push failed')
    expect(rec.gh).toHaveLength(0)
  })

  it('recovers an already-open PR url when create reports it exists', async () => {
    wire({
      status: ' M src/a.ts\n',
      gh: (args) =>
        args[1] === 'create'
          ? Promise.reject(new Error('a pull request already exists'))
          : Promise.resolve('https://github.com/acme/repo/pull/7\n'),
    })
    const res = await defaultFinalizer.finalize(base)
    expect(res.prUrl).toBe('https://github.com/acme/repo/pull/7')
    expect(res.note).toContain('already open')
  })

  it('reports PR creation failure when no existing PR can be recovered', async () => {
    wire({
      status: ' M src/a.ts\n',
      gh: () => Promise.reject(new Error('gh not authenticated')),
    })
    const res = await defaultFinalizer.finalize(base)
    expect(res.prUrl).toBeNull()
    expect(res.note).toContain('PR creation failed')
  })
})
