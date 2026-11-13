/** Tests for the origin-slug cache behind resolvePrReviewAutomation's default deps. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./workflow-config.js', () => ({
  loadWorkflowConfig: () => ({
    reviewRepos: [{ id: 'a', name: 'a', kind: 'pr-review', repoPath: '/repo', cronExpression: 'event', enabled: true }],
  }),
}))
vi.mock('./repo-activity.js', () => ({ repoSlugFromRemote: vi.fn() }))

import { repoSlugFromRemote } from './repo-activity.js'
import { resolvePrReviewAutomation, clearPrReviewSlugCache } from './pr-review-automation.js'

describe('PR Review origin slug cache', () => {
  beforeEach(() => {
    clearPrReviewSlugCache()
    vi.mocked(repoSlugFromRemote).mockReset()
  })
  afterEach(() => { vi.useRealTimers() })

  it('does not remember a failed lookup, so reviews resume once the origin is fixed', () => {
    vi.mocked(repoSlugFromRemote).mockReturnValue(null)
    expect(resolvePrReviewAutomation('acme/repo').kind).toBe('skip')
    vi.mocked(repoSlugFromRemote).mockReturnValue('acme/repo')
    expect(resolvePrReviewAutomation('acme/repo').kind).toBe('review')
  })

  it('caches a successful lookup, then re-reads it after the TTL', () => {
    vi.useFakeTimers()
    vi.mocked(repoSlugFromRemote).mockReturnValue('acme/repo')
    expect(resolvePrReviewAutomation('acme/repo').kind).toBe('review')
    expect(resolvePrReviewAutomation('acme/repo').kind).toBe('review')
    expect(repoSlugFromRemote).toHaveBeenCalledTimes(1)

    // The origin moves to a new name; the change is seen once the entry expires.
    vi.mocked(repoSlugFromRemote).mockReturnValue('acme/renamed')
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(resolvePrReviewAutomation('acme/repo').kind).toBe('skip')
    expect(resolvePrReviewAutomation('acme/renamed').kind).toBe('review')
  })
})
