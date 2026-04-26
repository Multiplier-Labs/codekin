/** Tests for the passive-repo notifier predicate — see #issue: alerts were
 * firing for repos with zero enabled workflows, recommending de-scheduling
 * workflows that didn't exist. */
import { describe, it, expect } from 'vitest'
import { hasEnabledWorkflowForRepo } from './orchestrator-monitor.js'
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
