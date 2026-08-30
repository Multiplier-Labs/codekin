import { describe, it, expect, afterEach } from 'vitest'
import { defaultLoopFinalizer, _setLoopFinalizerRunners, _resetLoopFinalizerRunners } from './loop-finalizer.js'

type Call = { args: string[]; cwd: string }

function harness(opts: {
  dirty?: boolean
  pushFails?: boolean
  prCreateFails?: boolean
  existingPr?: string | null
}) {
  const git: Call[] = []
  const gh: Call[] = []
  _setLoopFinalizerRunners(
    async (args, cwd) => {
      git.push({ args, cwd })
      if (args[0] === 'status') return opts.dirty ? ' M src/x.ts' : ''
      if (args[0] === 'push' && opts.pushFails) throw new Error('remote rejected')
      return ''
    },
    async (args, cwd) => {
      gh.push({ args, cwd })
      if (args[1] === 'create') {
        if (opts.prCreateFails) throw new Error('pr exists')
        return 'https://github.com/x/y/pull/7\n'
      }
      // pr view
      if (opts.existingPr) return opts.existingPr
      throw new Error('no pr')
    },
  )
  return { git, gh }
}

afterEach(() => _resetLoopFinalizerRunners())

const base = { cwd: '/wt', branch: 'loop/x', title: 't', body: 'b' } as const

describe('defaultLoopFinalizer', () => {
  it('commits a dirty tree and opens a PR', async () => {
    const { git } = harness({ dirty: true })
    const result = await defaultLoopFinalizer.finalize({ ...base, action: 'pull-request' })
    expect(result).toEqual({ prUrl: 'https://github.com/x/y/pull/7', note: expect.stringContaining('opened PR'), clean: true })
    expect(git.map((c) => c.args[0])).toEqual(['status', 'add', 'commit', 'push'])
  })

  it('commit-only never pushes', async () => {
    const { git, gh } = harness({ dirty: true })
    const result = await defaultLoopFinalizer.finalize({ ...base, action: 'commit-only' })
    expect(result.clean).toBe(true)
    expect(git.some((c) => c.args[0] === 'push')).toBe(false)
    expect(gh).toHaveLength(0)
  })

  it('a clean tree skips the commit (idempotent re-finalize)', async () => {
    const { git } = harness({ dirty: false })
    await defaultLoopFinalizer.finalize({ ...base, action: 'pull-request' })
    expect(git.map((c) => c.args[0])).toEqual(['status', 'push'])
  })

  it('push failure is reported, not thrown, and marks the result unclean', async () => {
    harness({ dirty: true, pushFails: true })
    const result = await defaultLoopFinalizer.finalize({ ...base, action: 'pull-request' })
    expect(result.prUrl).toBeNull()
    expect(result.clean).toBe(false)
    expect(result.note).toContain('push failed')
  })

  it('recovers an already-open PR instead of failing', async () => {
    harness({ dirty: false, prCreateFails: true, existingPr: 'https://github.com/x/y/pull/3' })
    const result = await defaultLoopFinalizer.finalize({ ...base, action: 'pull-request' })
    expect(result).toEqual({ prUrl: 'https://github.com/x/y/pull/3', note: expect.stringContaining('already open'), clean: true })
  })

  it('PR creation failure without an existing PR is unclean but not fatal', async () => {
    harness({ dirty: false, prCreateFails: true, existingPr: null })
    const result = await defaultLoopFinalizer.finalize({ ...base, action: 'pull-request' })
    expect(result.prUrl).toBeNull()
    expect(result.clean).toBe(false)
    expect(result.note).toContain('PR creation failed')
  })
})
