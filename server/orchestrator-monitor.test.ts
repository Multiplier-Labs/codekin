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

const notified = vi.hoisted(() => [] as Array<{ label: string; title: string; body: string }>)
vi.mock('./orchestrator-notify.js', () => ({
  notifyOrchestrator: (_sessions: unknown, args: { label: string; title: string; body: string }) => {
    notified.push(args)
    return true
  },
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

  it('registers the poll as an engine tick task when an engine is attached', () => {
    monitor = new OrchestratorMonitor(makeSessions())
    const engine = makeEngine()
    monitor.setEngine(engine)

    monitor.start()

    expect(engine.registerTickTask).toHaveBeenCalledWith('orchestrator-poll', 15 * 60 * 1000, expect.any(Function))

    // Idempotent start — no duplicate registrations.
    monitor.start()
    expect(engine.registerTickTask).toHaveBeenCalledTimes(1)

    monitor.stop()
    expect(engine.unregisterTickTask).toHaveBeenCalledWith('orchestrator-poll')
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
  const fakeSessions = { isRateLimited: () => false } as unknown as SessionManager

  function monitor(): OrchestratorMonitor {
    notified.length = 0
    return new OrchestratorMonitor(fakeSessions)
  }

  const base = { runId: 'r1', sequence: 1, at: '2026-08-30T12:00:00.000Z', actor: { type: 'system' as const } }

  it('notifies once (label ACTION) when a session blocks, pointing at pending_prompts', () => {
    const m = monitor()
    const blocked = { ...base, type: 'session_blocked', payload: { requestId: 'req-1', toolName: 'Bash' } }
    m.handleLoopEvent(blocked)
    m.handleLoopEvent(blocked)

    expect(notified).toHaveLength(1)
    expect(notified[0].label).toBe('ACTION')
    expect(notified[0].body).toContain('pending_prompts')
  })

  it('notifies separately for a later event of the same run', () => {
    const m = monitor()
    m.handleLoopEvent({ ...base, type: 'session_blocked', payload: { requestId: 'req-1' } })
    m.handleLoopEvent({ ...base, sequence: 2, type: 'run_completed', payload: { outcome: 'failed', reason: 'budget exhausted' } })

    expect(notified.map(n => n.label)).toEqual(['ACTION', 'ALERT'])
    expect(notified[1].body).toContain('budget exhausted')
  })

  it('ignores progress events and non-failure completions', () => {
    const m = monitor()
    m.handleLoopEvent({ ...base, type: 'state_changed', payload: { state: 'executing' } })
    m.handleLoopEvent({ ...base, sequence: 2, type: 'evaluation_completed', payload: { status: 'fail' } })
    m.handleLoopEvent({ ...base, sequence: 3, type: 'run_completed', payload: { outcome: 'completed' } })
    m.handleLoopEvent({ ...base, sequence: 4, type: 'run_completed', payload: { outcome: 'canceled' } })
    expect(notified).toHaveLength(0)
  })

  it('notifies on a pending intervention with its decision title', () => {
    const m = monitor()
    m.handleLoopEvent({
      ...base,
      runId: 'r2',
      type: 'intervention_created',
      payload: { interventionId: 'iv-1', purpose: 'escalation', title: 'Approve completion of "Coverage Increase"?' },
    })
    expect(notified).toHaveLength(1)
    expect(notified[0].title).toContain('needs a decision')
    expect(notified[0].title).toContain('Coverage Increase')
  })
})

describe('notify', () => {
  it('maps severity to the notification label on the shared path', () => {
    notified.length = 0
    new OrchestratorMonitor({ isRateLimited: () => false } as unknown as SessionManager)
      .notify('alert', 'Probe breach', 'p95 over budget')
    expect(notified).toEqual([{ label: 'ALERT', title: 'Probe breach', body: 'p95 over budget' }])
  })
})
