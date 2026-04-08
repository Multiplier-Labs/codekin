/** Tests for PR-specific GitHub API helpers — verifies diff/files/commits fetching and graceful degradation. */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { fetchPrDiff, fetchPrFiles, fetchPrCommits, fetchPrReviewComments, fetchPrReviews, fetchExistingReviewComment, REVIEW_COMMENT_MARKER, _setGhRunner, _resetGhRunner } from './webhook-pr-github.js'

describe('fetchPrDiff', () => {
  afterEach(() => {
    _resetGhRunner()
  })

  it('returns the diff for a PR', async () => {
    _setGhRunner(async () => 'diff --git a/file.ts\n+added line\n-removed line')
    const result = await fetchPrDiff('owner/repo', 42)
    expect(result.diff).toContain('+added line')
    expect(result.diff).toContain('-removed line')
    expect(result.truncated).toBe(false)
  })

  it('truncates diffs larger than 100KB', async () => {
    const largeDiff = 'x'.repeat(150_000)
    _setGhRunner(async () => largeDiff)
    const result = await fetchPrDiff('owner/repo', 42)
    expect(result.truncated).toBe(true)
    expect(result.diff.length).toBeLessThan(largeDiff.length)
    expect(result.diff).toContain('diff truncated')
  })

  it('returns empty string on error', async () => {
    _setGhRunner(async () => { throw new Error('network error') })
    const result = await fetchPrDiff('owner/repo', 42)
    expect(result.diff).toBe('')
    expect(result.truncated).toBe(false)
  })

  it('passes correct API path and Accept header', async () => {
    let capturedArgs: string[] = []
    _setGhRunner(async (args) => { capturedArgs = args; return 'some diff' })
    await fetchPrDiff('owner/repo', 7)
    expect(capturedArgs).toContain('/repos/owner/repo/pulls/7')
    expect(capturedArgs).toContain('Accept: application/vnd.github.diff')
  })
})

describe('fetchPrFiles', () => {
  afterEach(() => {
    _resetGhRunner()
  })

  it('returns formatted file list', async () => {
    _setGhRunner(async () => JSON.stringify([
      { filename: 'src/index.ts', status: 'modified', additions: 10, deletions: 3 },
      { filename: 'README.md', status: 'added', additions: 5, deletions: 0 },
    ]))
    const result = await fetchPrFiles('owner/repo', 42)
    expect(result).toContain('src/index.ts (modified, +10/-3)')
    expect(result).toContain('README.md (added, +5/-0)')
  })

  it('returns empty string for empty file list', async () => {
    _setGhRunner(async () => '[]')
    const result = await fetchPrFiles('owner/repo', 42)
    expect(result).toBe('')
  })

  it('returns empty string on error', async () => {
    _setGhRunner(async () => { throw new Error('api error') })
    const result = await fetchPrFiles('owner/repo', 42)
    expect(result).toBe('')
  })
})

describe('fetchPrCommits', () => {
  afterEach(() => {
    _resetGhRunner()
  })

  it('returns formatted commit list', async () => {
    _setGhRunner(async () => JSON.stringify([
      { sha: 'abc1234567890', commit: { message: 'fix: resolve auth bug\n\nMore details here' } },
      { sha: 'def5678901234', commit: { message: 'test: add coverage' } },
    ]))
    const result = await fetchPrCommits('owner/repo', 42)
    expect(result).toContain('- abc1234: fix: resolve auth bug')
    expect(result).toContain('- def5678: test: add coverage')
    // Multi-line commit message should only show first line
    expect(result).not.toContain('More details here')
  })

  it('returns empty string for empty commits', async () => {
    _setGhRunner(async () => '[]')
    const result = await fetchPrCommits('owner/repo', 42)
    expect(result).toBe('')
  })

  it('returns empty string on error', async () => {
    _setGhRunner(async () => { throw new Error('api error') })
    const result = await fetchPrCommits('owner/repo', 42)
    expect(result).toBe('')
  })
})

describe('fetchPrReviewComments', () => {
  afterEach(() => {
    _resetGhRunner()
  })

  it('returns formatted inline comments', async () => {
    _setGhRunner(async () => JSON.stringify([
      { path: 'src/auth.ts', line: 10, body: 'Fix the null check here', user: { login: 'reviewer1' } },
      { path: 'src/auth.ts', line: null, body: 'General comment on file', user: { login: 'reviewer2' } },
    ]))
    const result = await fetchPrReviewComments('owner/repo', 42)
    expect(result).toContain('reviewer1 on src/auth.ts:10: Fix the null check here')
    expect(result).toContain('reviewer2 on src/auth.ts: General comment on file')
  })

  it('returns empty string for no comments', async () => {
    _setGhRunner(async () => '[]')
    const result = await fetchPrReviewComments('owner/repo', 42)
    expect(result).toBe('')
  })

  it('returns empty string on error', async () => {
    _setGhRunner(async () => { throw new Error('api error') })
    const result = await fetchPrReviewComments('owner/repo', 42)
    expect(result).toBe('')
  })
})

describe('fetchPrReviews', () => {
  afterEach(() => {
    _resetGhRunner()
  })

  it('returns formatted review summaries', async () => {
    _setGhRunner(async () => JSON.stringify([
      { state: 'COMMENTED', body: 'Looks good overall', user: { login: 'reviewer1' } },
      { state: 'CHANGES_REQUESTED', body: 'Needs fixes', user: { login: 'reviewer2' } },
    ]))
    const result = await fetchPrReviews('owner/repo', 42)
    expect(result).toContain('reviewer1 (COMMENTED): Looks good overall')
    expect(result).toContain('reviewer2 (CHANGES_REQUESTED): Needs fixes')
  })

  it('filters out PENDING reviews', async () => {
    _setGhRunner(async () => JSON.stringify([
      { state: 'PENDING', body: 'Draft', user: { login: 'reviewer1' } },
      { state: 'APPROVED', body: null, user: { login: 'reviewer2' } },
    ]))
    const result = await fetchPrReviews('owner/repo', 42)
    expect(result).not.toContain('PENDING')
    expect(result).toContain('reviewer2 (APPROVED): (no summary)')
  })

  it('returns empty string for no reviews', async () => {
    _setGhRunner(async () => '[]')
    const result = await fetchPrReviews('owner/repo', 42)
    expect(result).toBe('')
  })

  it('returns empty string on error', async () => {
    _setGhRunner(async () => { throw new Error('api error') })
    const result = await fetchPrReviews('owner/repo', 42)
    expect(result).toBe('')
  })
})

describe('fetchExistingReviewComment', () => {
  afterEach(() => {
    _resetGhRunner()
  })

  it('returns comment ID when marker is found', async () => {
    _setGhRunner(async () => JSON.stringify([
      { id: 100, body: 'Some other comment' },
      { id: 200, body: `${REVIEW_COMMENT_MARKER}\n## Review Summary\nLooks good` },
    ]))
    const result = await fetchExistingReviewComment('owner/repo', 42)
    expect(result).toBe(200)
  })

  it('returns undefined when no marker found', async () => {
    _setGhRunner(async () => JSON.stringify([
      { id: 100, body: 'Regular comment' },
      { id: 200, body: 'Another comment' },
    ]))
    const result = await fetchExistingReviewComment('owner/repo', 42)
    expect(result).toBeUndefined()
  })

  it('returns the most recent matching comment', async () => {
    _setGhRunner(async () => JSON.stringify([
      { id: 100, body: `${REVIEW_COMMENT_MARKER}\nOld review` },
      { id: 200, body: 'Unrelated comment' },
      { id: 300, body: `${REVIEW_COMMENT_MARKER}\nNew review` },
    ]))
    const result = await fetchExistingReviewComment('owner/repo', 42)
    expect(result).toBe(300)
  })

  it('returns undefined on API error', async () => {
    _setGhRunner(async () => { throw new Error('api error') })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const result = await fetchExistingReviewComment('owner/repo', 42)
    expect(result).toBeUndefined()
    expect(warnSpy).toHaveBeenCalled()
  })

  it('returns undefined for empty comment list', async () => {
    _setGhRunner(async () => '[]')
    const result = await fetchExistingReviewComment('owner/repo', 42)
    expect(result).toBeUndefined()
  })
})
