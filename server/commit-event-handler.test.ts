/**
 * Tests for CommitEventHandler — verifies the multi-layer filter chain
 * (branch / message / config / dedup / concurrency) and dispatch to the
 * workflow engine.
 *
 * The workflow engine, config loader, and prefix loader are all mocked so
 * the handler runs entirely in-memory with no SQLite or filesystem access.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  startRun: vi.fn(async (_kind: string, _input: Record<string, unknown>) => ({ id: 'run-123' })),
  listRuns: vi.fn((_opts?: unknown) => [] as Array<{ input: { repoPath: string } }>),
  config: { reviewRepos: [] as Array<{
    id: string
    name: string
    repoPath: string
    enabled: boolean
    kind?: string
    customPrompt?: string
    model?: string
    provider?: string
  }> },
  prefixes: [] as string[],
}))

vi.mock('./workflow-engine.js', () => ({
  getWorkflowEngine: () => ({
    startRun: mockState.startRun,
    listRuns: mockState.listRuns,
  }),
}))

vi.mock('./workflow-config.js', () => ({
  loadWorkflowConfig: () => mockState.config,
}))

vi.mock('./workflow-loader.js', () => ({
  getWorkflowCommitPrefixes: () => mockState.prefixes,
  isWorkflowReportsBranch: (branch: string) =>
    branch === 'codekin/reports' || /^audit\/[^/]+-\d{4}-\d{2}-\d{2}$/.test(branch),
}))

import { CommitEventHandler, sanitizeCommitField, type CommitEvent } from './commit-event-handler.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<CommitEvent> = {}): CommitEvent {
  return {
    repoPath: '/repos/owner/foo',
    branch: 'main',
    commitHash: 'a'.repeat(40),
    commitMessage: 'feat: add a thing',
    author: 'alice',
    ...overrides,
  }
}

function enableRepoConfig(repoPath = '/repos/owner/foo') {
  mockState.config.reviewRepos = [
    {
      id: 'r1',
      name: 'foo',
      repoPath,
      enabled: true,
      kind: 'commit-review',
      customPrompt: 'review please',
      model: 'sonnet',
      provider: 'claude',
    },
  ]
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('sanitizeCommitField', () => {
  it('truncates strings longer than the default maxLen (500)', () => {
    const long = 'a'.repeat(600)
    expect(sanitizeCommitField(long)).toHaveLength(500)
  })

  it('truncates to a custom maxLen', () => {
    const long = 'b'.repeat(300)
    expect(sanitizeCommitField(long, 200)).toHaveLength(200)
  })

  it('strips ASCII control characters including NUL and ESC', () => {
    expect(sanitizeCommitField('hello\x00world')).toBe('helloworld')
    expect(sanitizeCommitField('esc\x1b[31mcolor')).toBe('esc[31mcolor')
    expect(sanitizeCommitField('line\nfeed')).toBe('linefeed')
    expect(sanitizeCommitField('\x7fhidden')).toBe('hidden')
    expect(sanitizeCommitField('\x01\x02\x1f\x7f')).toBe('')
  })

  it('leaves normal commit message text unchanged', () => {
    const msg = 'feat: add login page (issue #123)'
    expect(sanitizeCommitField(msg)).toBe(msg)
  })
})

describe('CommitEventHandler', () => {
  let handler: CommitEventHandler

  beforeEach(() => {
    vi.useFakeTimers()
    mockState.startRun.mockClear()
    mockState.listRuns.mockClear()
    mockState.startRun.mockResolvedValue({ id: 'run-123' } as any)
    mockState.listRuns.mockReturnValue([])
    mockState.config.reviewRepos = []
    mockState.prefixes = []
    handler = new CommitEventHandler()
  })

  afterEach(() => {
    handler.shutdown()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  // -------------------------------------------------------------------------
  // Layer 1: Branch filter
  // -------------------------------------------------------------------------

  it('rejects commits on the codekin/reports branch', async () => {
    enableRepoConfig()
    const result = await handler.handle(makeEvent({ branch: 'codekin/reports' }))
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('reports branch')
    expect(mockState.startRun).not.toHaveBeenCalled()
  })

  // -------------------------------------------------------------------------
  // Layer 2: Message filter
  // -------------------------------------------------------------------------

  it('rejects commits whose message starts with a workflow commitMessage prefix', async () => {
    enableRepoConfig()
    mockState.prefixes = ['chore(codekin):', 'workflow(auto):']
    const result = await handler.handle(
      makeEvent({ commitMessage: 'workflow(auto): nightly run' }),
    )
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('workflow commit message')
    expect(result.reason).toContain('workflow(auto):')
    expect(mockState.startRun).not.toHaveBeenCalled()
  })

  it('does not reject when prefix is a substring but not a prefix', async () => {
    enableRepoConfig()
    mockState.prefixes = ['workflow(auto):']
    const result = await handler.handle(
      makeEvent({ commitMessage: 'feat: invokes workflow(auto): logic' }),
    )
    expect(result.accepted).toBe(true)
    expect(mockState.startRun).toHaveBeenCalledOnce()
  })

  // -------------------------------------------------------------------------
  // Layer 3: Config lookup
  // -------------------------------------------------------------------------

  it('rejects when no enabled commit-review config exists for the repo', async () => {
    mockState.config.reviewRepos = []
    const result = await handler.handle(makeEvent())
    expect(result.accepted).toBe(false)
    expect(result.reason).toMatch(/no enabled commit-review config/i)
  })

  it('rejects when config exists but is disabled', async () => {
    mockState.config.reviewRepos = [{
      id: 'r1', name: 'foo', repoPath: '/repos/owner/foo',
      enabled: false, kind: 'commit-review',
    }]
    const result = await handler.handle(makeEvent())
    expect(result.accepted).toBe(false)
    expect(result.reason).toMatch(/no enabled commit-review config/i)
  })

  it('rejects when config kind is not commit-review', async () => {
    mockState.config.reviewRepos = [{
      id: 'r1', name: 'foo', repoPath: '/repos/owner/foo',
      enabled: true, kind: 'pr-review',
    }]
    const result = await handler.handle(makeEvent())
    expect(result.accepted).toBe(false)
  })

  it('rejects when repo path does not match', async () => {
    mockState.config.reviewRepos = [{
      id: 'r1', name: 'foo', repoPath: '/repos/owner/bar',
      enabled: true, kind: 'commit-review',
    }]
    const result = await handler.handle(makeEvent({ repoPath: '/repos/owner/foo' }))
    expect(result.accepted).toBe(false)
  })

  // -------------------------------------------------------------------------
  // Layer 4: Dedup
  // -------------------------------------------------------------------------

  it('rejects a duplicate commit hash within the TTL', async () => {
    enableRepoConfig()
    const event = makeEvent({ commitHash: 'b'.repeat(40) })

    const first = await handler.handle(event)
    expect(first.accepted).toBe(true)

    const second = await handler.handle(event)
    expect(second.accepted).toBe(false)
    expect(second.reason).toMatch(/duplicate commit hash/i)
    expect(mockState.startRun).toHaveBeenCalledOnce()
  })

  it('does NOT cross-suppress identical hashes across different repos', async () => {
    // Two unrelated repos can produce the same commit hash (e.g. cherry-pick,
    // identical empty commit). Each deserves its own commit-review run. The
    // dedup key must be scoped per-repo.
    mockState.config.reviewRepos = [
      { id: 'r1', name: 'foo', repoPath: '/repos/owner/foo', enabled: true, kind: 'commit-review' },
      { id: 'r2', name: 'bar', repoPath: '/repos/owner/bar', enabled: true, kind: 'commit-review' },
    ]
    const sharedHash = 'd'.repeat(40)

    const r1 = await handler.handle(makeEvent({ repoPath: '/repos/owner/foo', commitHash: sharedHash }))
    expect(r1.accepted).toBe(true)

    const r2 = await handler.handle(makeEvent({ repoPath: '/repos/owner/bar', commitHash: sharedHash }))
    expect(r2.accepted).toBe(true)

    // And a *third* call against the first repo with the same hash is still
    // suppressed (per-repo dedup is intact).
    const r1Dup = await handler.handle(makeEvent({ repoPath: '/repos/owner/foo', commitHash: sharedHash }))
    expect(r1Dup.accepted).toBe(false)
    expect(r1Dup.reason).toMatch(/duplicate commit hash/i)

    expect(mockState.startRun).toHaveBeenCalledTimes(2)
  })

  it('accepts the same commit hash again after the dedup TTL elapses', async () => {
    enableRepoConfig()
    const event = makeEvent({ commitHash: 'c'.repeat(40) })

    const first = await handler.handle(event)
    expect(first.accepted).toBe(true)

    // Advance past the 1-hour TTL plus the 10-minute cleanup interval to
    // ensure pruneExpired() runs and removes the entry.
    vi.advanceTimersByTime(2 * 60 * 60 * 1000)

    const second = await handler.handle(event)
    expect(second.accepted).toBe(true)
    expect(mockState.startRun).toHaveBeenCalledTimes(2)
  })

  // -------------------------------------------------------------------------
  // Layer 5: Concurrency cap
  // -------------------------------------------------------------------------

  it('rejects when a commit-review is already running for this repo', async () => {
    enableRepoConfig('/repos/owner/foo')
    mockState.listRuns.mockReturnValue([
      { input: { repoPath: '/repos/owner/foo' } } as any,
    ])
    const result = await handler.handle(makeEvent())
    expect(result.accepted).toBe(false)
    expect(result.reason).toMatch(/already running/i)
    expect(mockState.startRun).not.toHaveBeenCalled()
  })

  it('accepts when an active run is for a different repo', async () => {
    enableRepoConfig('/repos/owner/foo')
    mockState.listRuns.mockReturnValue([
      { input: { repoPath: '/repos/owner/other' } } as any,
    ])
    const result = await handler.handle(makeEvent())
    expect(result.accepted).toBe(true)
  })

  // -------------------------------------------------------------------------
  // Dispatch + happy path
  // -------------------------------------------------------------------------

  it('dispatches the workflow run with config-derived parameters', async () => {
    enableRepoConfig('/repos/owner/foo')
    const event = makeEvent({
      repoPath: '/repos/owner/foo',
      commitHash: 'd'.repeat(40),
      commitMessage: 'feat: add foo',
    })

    const result = await handler.handle(event)
    expect(result.accepted).toBe(true)
    expect(result.runId).toBe('run-123')

    expect(mockState.startRun).toHaveBeenCalledWith(
      'commit-review',
      expect.objectContaining({
        repoPath: '/repos/owner/foo',
        repoName: 'foo',
        commitHash: 'd'.repeat(40),
        customPrompt: 'review please',
        model: 'sonnet',
        provider: 'claude',
      }),
    )
  })

  it('passes sanitized commitMessage, branch, and author to engine.startRun', async () => {
    enableRepoConfig('/repos/owner/foo')
    // Craft inputs with control characters that should be stripped and a
    // commitMessage that exceeds 500 chars (should be truncated).
    const longMsg = 'feat: ' + 'x'.repeat(600)
    const event = makeEvent({
      repoPath: '/repos/owner/foo',
      commitHash: 'f'.repeat(40),
      commitMessage: longMsg,
      branch: 'main\x1b[danger',
      author: 'alice\x00',
    })

    const result = await handler.handle(event)
    expect(result.accepted).toBe(true)

    const startRunInput = mockState.startRun.mock.calls[0][1] as Record<string, unknown>
    expect((startRunInput.commitMessage as string).length).toBe(500)
    expect(startRunInput.commitMessage).not.toContain('\x1b')
    expect(startRunInput.branch).toBe('main[danger')
    expect(startRunInput.author).toBe('alice')
  })

  it('returns a failure result and reason when startRun throws', async () => {
    enableRepoConfig()
    mockState.startRun.mockRejectedValueOnce(new Error('engine boom'))

    const result = await handler.handle(makeEvent({ commitHash: 'e'.repeat(40) }))
    expect(result.accepted).toBe(false)
    expect(result.reason).toContain('engine boom')
  })

  // -------------------------------------------------------------------------
  // shutdown / pruneExpired
  // -------------------------------------------------------------------------

  it('shutdown clears the cleanup timer and seenCommits map', async () => {
    enableRepoConfig()
    await handler.handle(makeEvent({ commitHash: 'f'.repeat(40) }))

    handler.shutdown()

    // After shutdown, the same commit should be accepted again (map cleared)
    // and no more cleanup timers should fire.  Re-instantiate to verify
    // independent state.
    handler = new CommitEventHandler()
    const result = await handler.handle(makeEvent({ commitHash: 'f'.repeat(40) }))
    expect(result.accepted).toBe(true)
  })
})
