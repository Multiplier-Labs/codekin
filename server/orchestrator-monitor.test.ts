/** Tests for the passive-repo notifier predicate — see #issue: alerts were
 * firing for repos with zero enabled workflows, recommending de-scheduling
 * workflows that didn't exist. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { hasEnabledWorkflowForRepo, discoverRepoPathsUnder } from './orchestrator-monitor.js'
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
