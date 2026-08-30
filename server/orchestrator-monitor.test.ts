/** Tests for OrchestratorMonitor lifecycle — engine-driven tick registration vs legacy intervals —
 * plus the passive-repo notifier predicate, repo discovery, and loop event notifications. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./config.js', () => ({
  DATA_DIR: '/tmp/monitor-test-data',
  REPOS_ROOT: '/nonexistent-monitor-test-root',
  AGENT_DISPLAY_NAME: 'TestAgent',
  getAgentDisplayName: () => 'TestAgent',
}))

import { hasEnabledWorkflowForRepo, discoverRepoPathsUnder, OrchestratorMonitor } from './orchestrator-monitor.js'
import type { SessionManager } from './session-manager.js'
import type { WorkflowEngine } from './workflow-engine.js'
import type { ReviewRepoConfig } from './workflow-config.js'

function makeSessions(): SessionManager {
  return { isRateLimited: vi.fn(() => false) } as unknown as SessionManager
}

function makeEngine() {
  return {
    on: vi.fn(),
    registerTickTask: vi.fn(),
    unregisterTickTask: vi.fn(),
    getEngineHealth: vi.fn(() => ({ lastTickAt: null, tickCount: 0 })),
  } as unknown as WorkflowEngine
}

describe('OrchestratorMonitor lifecycle', () => {
  let monitor: OrchestratorMonitor

  afterEach(() => {
    monitor.stop()
    vi.useRealTimers()
  })

  it('registers poll and aging as engine tick tasks when an engine is attached', () => {
    monitor = new OrchestratorMonitor(makeSessions())
    const engine = makeEngine()
    monitor.setEngine(engine)

    monitor.start()

    expect(engine.registerTickTask).toHaveBeenCalledWith('orchestrator-poll', 15 * 60 * 1000, expect.any(Function))
    expect(engine.registerTickTask).toHaveBeenCalledWith('orchestrator-aging', 6 * 60 * 60 * 1000, expect.any(Function))

    // Idempotent start — no duplicate registrations.
    monitor.start()
    expect(engine.registerTickTask).toHaveBeenCalledTimes(2)

    monitor.stop()
    expect(engine.unregisterTickTask).toHaveBeenCalledWith('orchestrator-poll')
    expect(engine.unregisterTickTask).toHaveBeenCalledWith('orchestrator-aging')
  })

  it('falls back to setInterval without an engine', () => {
    vi.useFakeTimers()
    monitor = new OrchestratorMonitor(makeSessions())

    monitor.start()
    // No engine attached — nothing to assert against but absence of throw;
    // stop() must clear the intervals so fake timers drain cleanly.
    monitor.stop()
    vi.advanceTimersByTime(20 * 60 * 1000)
  })
})

/** The passive-repo notifier predicate — alerts were firing for repos with
 * zero enabled workflows, recommending de-scheduling workflows that didn't exist. */
describe('hasEnabledWorkflowForRepo', () => {
  const repoPath = '/srv/repos/calendar-scheduling-advanced'

  const make = (overrides: Partial<ReviewRepoConfig>): ReviewRepoConfig => ({
    id: overrides.id ?? 'r',
    name: overrides.name ?? 'repo',
    repoPath: overrides.repoPath ?? '/srv/repos/foo',
    cronExpression: overrides.cronExpression ?? '0 6 * * *',
    enabled: overrides.enabled ?? false,
    ...overrides,
  })

  it('returns false when there are no entries in reviewRepos', () => {
    expect(hasEnabledWorkflowForRepo(repoPath, [])).toBe(false)
  })

  it('returns false when 3 entries match the repo but all are disabled', () => {
    const entries = [
      make({ id: '1', repoPath, enabled: false }),
      make({ id: '2', repoPath, enabled: false, kind: 'commit-review' }),
      make({ id: '3', repoPath, enabled: false, kind: 'security' }),
    ]
    expect(hasEnabledWorkflowForRepo(repoPath, entries)).toBe(false)
  })

  it('returns true when 1 entry is enabled and 2 are disabled', () => {
    const entries = [
      make({ id: '1', repoPath, enabled: false }),
      make({ id: '2', repoPath, enabled: true, kind: 'commit-review' }),
      make({ id: '3', repoPath, enabled: false, kind: 'security' }),
    ]
    expect(hasEnabledWorkflowForRepo(repoPath, entries)).toBe(true)
  })

  it('ignores enabled entries belonging to a different repo', () => {
    const entries = [
      make({ id: '1', repoPath: '/srv/repos/other', enabled: true }),
    ]
    expect(hasEnabledWorkflowForRepo(repoPath, entries)).toBe(false)
  })
})

describe('discoverRepoPathsUnder', () => {
  let root: string

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codekin-discover-'))
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  function makeRepo(...segments: string[]): string {
    const repo = join(root, ...segments)
    mkdirSync(join(repo, '.git'), { recursive: true })
    return repo
  }

  it('returns [] when the root does not exist', () => {
    expect(discoverRepoPathsUnder(join(root, 'missing'))).toEqual([])
  })

  it('finds flat repos directly under the root', () => {
    const a = makeRepo('repo-a')
    const b = makeRepo('repo-b')
    expect(discoverRepoPathsUnder(root).sort()).toEqual([a, b].sort())
  })

  it('finds org-style repos one level down (root/org/repo)', () => {
    const flat = makeRepo('flat-repo')
    const nested = makeRepo('my-org', 'nested-repo')
    expect(discoverRepoPathsUnder(root).sort()).toEqual([flat, nested].sort())
  })

  it('does not recurse past depth 2', () => {
    makeRepo('a', 'b', 'too-deep')
    expect(discoverRepoPathsUnder(root)).toEqual([])
  })

  it('does not descend into repos looking for nested repos', () => {
    const outer = makeRepo('outer')
    mkdirSync(join(outer, 'vendor', 'inner', '.git'), { recursive: true })
    expect(discoverRepoPathsUnder(root)).toEqual([outer])
  })

  it('ignores plain files at both levels', () => {
    writeFileSync(join(root, 'README.md'), 'hi')
    mkdirSync(join(root, 'org'))
    writeFileSync(join(root, 'org', 'notes.txt'), 'hi')
    expect(discoverRepoPathsUnder(root)).toEqual([])
  })
})

describe('handleLoopEvent', () => {
  // isRateLimited: true short-circuits delivery — notifications stay in the
  // buffer where getAll() can observe them, without touching fs or the outbox.
  const fakeSessions = { isRateLimited: () => true } as unknown as SessionManager

  function monitor(): OrchestratorMonitor {
    return new OrchestratorMonitor(fakeSessions)
  }

  const base = { runId: 'r1', sequence: 1, at: '2026-08-30T12:00:00.000Z', actor: { type: 'system' as const } }

  it('notifies once (severity action) when a session blocks, pointing at pending_prompts', () => {
    const m = monitor()
    const blocked = { ...base, type: 'session_blocked', payload: { requestId: 'req-1', toolName: 'Bash' } }
    m.handleLoopEvent(blocked)
    m.handleLoopEvent(blocked)

    const all = m.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].severity).toBe('action')
    expect(all[0].body).toContain('pending_prompts')
  })

  // getAll() is newest-first, so the later 'failed' notification leads.
  it('notifies separately for a later event of the same run', () => {
    const m = monitor()
    m.handleLoopEvent({ ...base, type: 'session_blocked', payload: { requestId: 'req-1' } })
    m.handleLoopEvent({ ...base, sequence: 2, type: 'run_completed', payload: { outcome: 'failed', reason: 'budget exhausted' } })

    const all = m.getAll()
    expect(all).toHaveLength(2)
    expect(all.map(n => n.severity)).toEqual(['alert', 'action'])
  })

  /** Regression: the pair used to flip order when it straddled a millisecond
   * tick, because equal timestamps fell back to insertion order. */
  it('keeps newest-first order when notifications cross a millisecond boundary', () => {
    const m = monitor()
    m.handleLoopEvent({ ...base, type: 'session_blocked', payload: { requestId: 'req-1' } })
    const until = Date.now() + 2
    while (Date.now() < until) { /* busy-wait past a millisecond tick */ }
    m.handleLoopEvent({ ...base, sequence: 2, type: 'run_completed', payload: { outcome: 'failed' } })

    expect(m.getAll().map(n => n.severity)).toEqual(['alert', 'action'])
  })

  it('ignores progress events and non-failure completions', () => {
    const m = monitor()
    m.handleLoopEvent({ ...base, type: 'state_changed', payload: { state: 'executing' } })
    m.handleLoopEvent({ ...base, sequence: 2, type: 'evaluation_completed', payload: { status: 'fail' } })
    m.handleLoopEvent({ ...base, sequence: 3, type: 'run_completed', payload: { outcome: 'completed' } })
    m.handleLoopEvent({ ...base, sequence: 4, type: 'run_completed', payload: { outcome: 'canceled' } })
    expect(m.getAll()).toHaveLength(0)
  })

  it('notifies on a pending intervention with its decision title', () => {
    const m = monitor()
    m.handleLoopEvent({
      ...base,
      runId: 'r2',
      type: 'intervention_created',
      payload: { interventionId: 'iv-1', purpose: 'escalation', title: 'Approve completion of "Coverage Increase"?' },
    })
    const all = m.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].title).toContain('needs a decision')
    expect(all[0].title).toContain('Coverage Increase')
  })
})
