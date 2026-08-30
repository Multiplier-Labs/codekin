/** Tests for the passive-repo notifier predicate — see #issue: alerts were
 * firing for repos with zero enabled workflows, recommending de-scheduling
 * workflows that didn't exist. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hasEnabledWorkflowForRepo, discoverRepoPathsUnder, OrchestratorMonitor } from './orchestrator-monitor.js'
import type { SessionManager } from './session-manager.js'
import type { ReviewRepoConfig } from './workflow-config.js'

const make = (overrides: Partial<ReviewRepoConfig>): ReviewRepoConfig => ({
  id: overrides.id ?? 'r',
  name: overrides.name ?? 'repo',
  repoPath: overrides.repoPath ?? '/srv/repos/foo',
  cronExpression: overrides.cronExpression ?? '0 6 * * *',
  enabled: overrides.enabled ?? false,
  ...overrides,
})

describe('hasEnabledWorkflowForRepo', () => {
  const repoPath = '/srv/repos/calendar-scheduling-advanced'

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

describe('handleGoalRunEvent', () => {
  // isRateLimited: true short-circuits delivery — notifications stay in the
  // buffer where getAll() can observe them, without touching fs or the outbox.
  const fakeSessions = { isRateLimited: () => true } as unknown as SessionManager

  function monitor(): OrchestratorMonitor {
    return new OrchestratorMonitor(fakeSessions)
  }

  it('notifies once (severity action) when a run blocks, pointing at pending_prompts', () => {
    const m = monitor()
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'ci-autorepair', status: 'blocked' })
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'ci-autorepair', status: 'blocked' })

    const all = m.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].severity).toBe('action')
    expect(all[0].title).toContain('ci-autorepair')
    expect(all[0].body).toContain('pending_prompts')
  })

  // getAll() is newest-first, so the later 'failed' notification leads.
  it('notifies separately for a later state of the same run', () => {
    const m = monitor()
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'ci-autorepair', status: 'blocked' })
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'ci-autorepair', status: 'failed' })

    const all = m.getAll()
    expect(all).toHaveLength(2)
    expect(all.map(n => n.severity)).toEqual(['alert', 'action'])
  })

  /** Regression: the pair used to flip order when it straddled a millisecond
   * tick, because equal timestamps fell back to insertion order. */
  it('keeps newest-first order when notifications cross a millisecond boundary', () => {
    const m = monitor()
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'ci-autorepair', status: 'blocked' })
    const until = Date.now() + 2
    while (Date.now() < until) { /* busy-wait past a millisecond tick */ }
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'ci-autorepair', status: 'failed' })

    expect(m.getAll().map(n => n.severity)).toEqual(['alert', 'action'])
  })

  it('ignores progress states and ledger events', () => {
    const m = monitor()
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'k', status: 'running' })
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r1', kind: 'k', status: 'succeeded' })
    m.handleGoalRunEvent({ eventType: 'turn', runId: 'r1', kind: 'k' })
    expect(m.getAll()).toHaveLength(0)
  })

  it('notifies on awaiting_human with a decision prompt', () => {
    const m = monitor()
    m.handleGoalRunEvent({ eventType: 'run_status', runId: 'r2', kind: 'coverage-increase', status: 'awaiting_human' })
    const all = m.getAll()
    expect(all).toHaveLength(1)
    expect(all[0].title).toContain('needs a decision')
  })
})
