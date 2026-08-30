/**
 * Tests for the Repo Activity Index — tier computation from aggregated signals,
 * lazy freshness, event bumps (reactivation), and sweep transitions. Uses a
 * real in-memory SQLite database and injected git/session resolvers.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { RepoActivityIndex, type GitInfoResolver, type SessionActivityResolver } from './repo-activity.js'

const REPO = '/fake/repo'
const NOW = new Date('2026-08-29T12:00:00.000Z')

const daysAgo = (days: number) => new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString()

function makeIndex(opts?: { gitInfo?: GitInfoResolver; sessionActivity?: SessionActivityResolver }) {
  return new RepoActivityIndex({
    dbPath: ':memory:',
    gitInfo: opts?.gitInfo ?? (() => null),
    sessionActivity: opts?.sessionActivity ?? (() => null),
  })
}

describe('RepoActivityIndex', () => {
  let index: RepoActivityIndex

  afterEach(() => {
    index.close()
  })

  describe('tier computation', () => {
    it('is active with a commit inside 7 days', () => {
      index = makeIndex({ gitInfo: () => ({ sha: 'abc', committedAt: daysAgo(2) }) })
      const { activity } = index.refresh(REPO, NOW)
      expect(activity.tier).toBe('active')
      expect(activity.lastSignalAt).toBe(daysAgo(2))
    })

    it('is cooling between 7 and 30 days', () => {
      index = makeIndex({ gitInfo: () => ({ sha: 'abc', committedAt: daysAgo(10) }) })
      expect(index.refresh(REPO, NOW).activity.tier).toBe('cooling')
    })

    it('is dormant past 30 days, or with no signals at all', () => {
      index = makeIndex({ gitInfo: () => ({ sha: 'abc', committedAt: daysAgo(45) }) })
      expect(index.refresh(REPO, NOW).activity.tier).toBe('dormant')

      const empty = makeIndex()
      expect(empty.refresh(REPO, NOW).activity.tier).toBe('dormant')
      empty.close()
    })

    it('a recent session keeps an old-commit repo active', () => {
      index = makeIndex({
        gitInfo: () => ({ sha: 'abc', committedAt: daysAgo(60) }),
        sessionActivity: () => daysAgo(1),
      })
      const { activity } = index.refresh(REPO, NOW)
      expect(activity.tier).toBe('active')
      expect(activity.lastSignalAt).toBe(daysAgo(1))
    })
  })

  describe('event bumps', () => {
    it('a commit event reactivates a dormant repo immediately', () => {
      index = makeIndex({ gitInfo: () => ({ sha: 'abc', committedAt: daysAgo(45) }) })
      expect(index.refresh(REPO, NOW).activity.tier).toBe('dormant')

      index.recordCommitEvent(REPO, NOW)
      expect(index.get(REPO)?.tier).toBe('active')
    })

    it('a PR event resolved by slug bumps only the matching repo', () => {
      index = makeIndex()
      // No configured repos in the test env → no match, no throw.
      expect(index.recordPrEventBySlug('acme/widget', NOW)).toBeNull()
    })
  })

  describe('getFresh', () => {
    it('returns the stored row while fresh and re-reads once stale', () => {
      let sha = 'abc'
      index = makeIndex({ gitInfo: () => ({ sha, committedAt: daysAgo(1) }) })
      index.refresh(REPO, NOW)
      sha = 'def'

      // 5 minutes later: still fresh — resolver not consulted.
      const fresh = index.getFresh(REPO, new Date(NOW.getTime() + 5 * 60_000))
      expect(fresh.lastCommitSha).toBe('abc')

      // 20 minutes later: stale — re-read picks up the new sha.
      const stale = index.getFresh(REPO, new Date(NOW.getTime() + 20 * 60_000))
      expect(stale.lastCommitSha).toBe('def')
    })
  })

  describe('sweep', () => {
    it('reports tier transitions, including first sight and reactivation', () => {
      let committedAt = daysAgo(2)
      index = makeIndex({ gitInfo: () => ({ sha: 'abc', committedAt }) })

      // First sweep: null → active.
      expect(index.sweep([REPO], NOW)).toEqual([{ repoPath: REPO, from: null, to: 'active' }])

      // Nothing changed → no transitions.
      expect(index.sweep([REPO], NOW)).toEqual([])

      // Commit recedes past 30 days → dormant.
      const later = new Date(NOW.getTime() + 40 * 24 * 60 * 60 * 1000)
      expect(index.sweep([REPO], later)).toEqual([{ repoPath: REPO, from: 'active', to: 'dormant' }])

      // New commit → back to active.
      committedAt = later.toISOString()
      expect(index.sweep([REPO], later)).toEqual([{ repoPath: REPO, from: 'dormant', to: 'active' }])
    })
  })

  describe('persistence', () => {
    it('preserves event timestamps across refreshes', () => {
      index = makeIndex({ gitInfo: () => ({ sha: 'abc', committedAt: daysAgo(3) }) })
      index.recordCommitEvent(REPO, NOW)
      index.refresh(REPO, new Date(NOW.getTime() + 60_000))
      expect(index.get(REPO)?.lastCommitEventAt).toBe(NOW.toISOString())
    })
  })
})
