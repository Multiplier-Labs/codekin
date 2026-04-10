/** Tests for buildPrReviewPrompt — verifies PR context rendering and custom prompt resolution. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => ''),
  }
})

import { buildPrReviewPrompt } from './webhook-pr-prompt.js'
import { REVIEW_COMMENT_MARKER } from './webhook-pr-github.js'
import { existsSync, readFileSync } from 'fs'
import type { PullRequestContext } from './webhook-types.js'
import type { PrCacheData } from './webhook-pr-cache.js'

function makeContext(overrides: Partial<PullRequestContext> = {}): PullRequestContext {
  return {
    repo: 'owner/repo',
    prNumber: 42,
    prTitle: 'Fix authentication bug',
    prBody: 'This PR fixes the login flow when using SSO.',
    prUrl: 'https://github.com/owner/repo/pull/42',
    author: 'octocat',
    headBranch: 'fix-auth',
    baseBranch: 'main',
    headSha: 'abc1234567890',
    baseSha: 'def5678901234',
    action: 'opened',
    changedFiles: 3,
    additions: 25,
    deletions: 10,
    diff: 'diff --git a/src/auth.ts\n+fixed line\n-broken line',
    fileList: 'src/auth.ts (modified, +20/-8)\nsrc/auth.test.ts (modified, +5/-2)',
    commitMessages: '- abc1234: fix: resolve auth bug',
    reviewComments: '',
    reviews: '',
    ...overrides,
  }
}

describe('buildPrReviewPrompt', () => {
  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('full context produces all sections', () => {
    const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')

    expect(prompt).toContain('A pull request needs code review')
    expect(prompt).toContain('**Repository**: owner/repo')
    expect(prompt).toContain('**PR**: #42 — Fix authentication bug')
    expect(prompt).toContain('**Author**: octocat')
    expect(prompt).toContain('**Branch**: fix-auth → main')
    expect(prompt).toContain('3 files changed, +25/-10')
    expect(prompt).toContain('**Head**: abc1234')
    expect(prompt).toContain('## PR Description')
    expect(prompt).toContain('fixes the login flow')
    expect(prompt).toContain('## Changed Files')
    expect(prompt).toContain('src/auth.ts (modified, +20/-8)')
    expect(prompt).toContain('## Commits')
    expect(prompt).toContain('abc1234: fix: resolve auth bug')
    expect(prompt).toContain('## Diff')
    expect(prompt).toContain('+fixed line')
    expect(prompt).toContain('## Instructions')
  })

  it('opened action produces comprehensive review instructions', () => {
    const prompt = buildPrReviewPrompt(makeContext({ action: 'opened' }), '/tmp/workspace')
    expect(prompt).toContain('comprehensive code review')
  })

  it('reopened action mentions fresh review', () => {
    const prompt = buildPrReviewPrompt(makeContext({ action: 'reopened' }), '/tmp/workspace')
    expect(prompt).toContain('reopened')
    expect(prompt).toContain('fresh comprehensive code review')
  })

  it('synchronize action mentions previous head', () => {
    const prompt = buildPrReviewPrompt(
      makeContext({ action: 'synchronize', beforeSha: 'old1234567890' }),
      '/tmp/workspace',
    )
    expect(prompt).toContain('updated with new commits')
    expect(prompt).toContain('old1234')
    expect(prompt).toContain('abc1234')
  })

  it('synchronize without beforeSha falls back to comprehensive review', () => {
    const prompt = buildPrReviewPrompt(
      makeContext({ action: 'synchronize', beforeSha: undefined }),
      '/tmp/workspace',
    )
    expect(prompt).toContain('comprehensive code review')
  })

  it('missing PR body omits description section', () => {
    const prompt = buildPrReviewPrompt(makeContext({ prBody: '' }), '/tmp/workspace')
    expect(prompt).not.toContain('## PR Description')
  })

  it('empty diff shows "No diff available"', () => {
    const prompt = buildPrReviewPrompt(makeContext({ diff: '' }), '/tmp/workspace')
    expect(prompt).toContain('No diff available')
  })

  it('empty file list omits changed files section', () => {
    const prompt = buildPrReviewPrompt(makeContext({ fileList: '' }), '/tmp/workspace')
    expect(prompt).not.toContain('## Changed Files')
  })

  it('empty commit messages omits commits section', () => {
    const prompt = buildPrReviewPrompt(makeContext({ commitMessages: '' }), '/tmp/workspace')
    expect(prompt).not.toContain('## Commits')
  })

  it('includes existing review comments when present', () => {
    const prompt = buildPrReviewPrompt(makeContext({
      reviewComments: '- reviewer1 on src/auth.ts:10: Fix the null check here',
      reviews: '- reviewer1 (COMMENTED): Needs a few fixes',
    }), '/tmp/workspace')
    expect(prompt).toContain('## Existing Reviews')
    expect(prompt).toContain('### Review Summaries')
    expect(prompt).toContain('reviewer1 (COMMENTED)')
    expect(prompt).toContain('### Inline Comments')
    expect(prompt).toContain('Fix the null check here')
  })

  it('omits existing reviews section when no comments exist', () => {
    const prompt = buildPrReviewPrompt(makeContext({ reviewComments: '', reviews: '' }), '/tmp/workspace')
    expect(prompt).not.toContain('## Existing Reviews')
  })

  describe('custom prompt resolution', () => {
    it('uses repo-level custom prompt when available', () => {
      vi.mocked(existsSync).mockImplementation((p: Parameters<typeof existsSync>[0]) =>
        String(p).includes('/tmp/workspace/.codekin/pr-review-prompt.md'),
      )
      vi.mocked(readFileSync).mockReturnValue('Custom repo review instructions here')

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('Custom repo review instructions here')
      // Should NOT contain default instructions
      expect(prompt).not.toContain('comprehensive code review')
    })

    it('uses global custom prompt when repo-level not found', () => {
      vi.mocked(existsSync).mockImplementation((p: Parameters<typeof existsSync>[0]) =>
        String(p).includes('.codekin/pr-review-prompt.md') && !String(p).includes('/tmp/workspace'),
      )
      vi.mocked(readFileSync).mockReturnValue('Global custom instructions')

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('Global custom instructions')
    })

    it('falls back to default when no custom prompt exists', () => {
      vi.mocked(existsSync).mockReturnValue(false)

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('comprehensive code review')
      expect(prompt).toContain('Code correctness')
    })

    it('repo-level takes precedence over global', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockImplementation((p: Parameters<typeof readFileSync>[0]) => {
        if (String(p).includes('/tmp/workspace')) return 'Repo prompt wins'
        return 'Global prompt loses'
      })

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('Repo prompt wins')
      expect(prompt).not.toContain('Global prompt loses')
    })

    it('skips empty custom prompt file and falls back', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('   \n  ')

      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      // Should fall back to default since file was whitespace-only
      expect(prompt).toContain('comprehensive code review')
    })
  })

  describe('prior review context (cache)', () => {
    const mockCache: PrCacheData = {
      prNumber: 42,
      repo: 'owner/repo',
      lastReviewedSha: 'prev123',
      timestamp: '2026-04-02T10:00:00.000Z',
      priorReviewSummary: 'PR adds SSO authentication support',
      codebaseContext: 'Auth module at src/auth/, uses JWT tokens',
      reviewFindings: 'Found null check issue in auth.ts line 42',
    }

    it('includes prior context section when cache provided', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace', { priorCache: mockCache })
      expect(prompt).toContain('## Prior Review Context')
      expect(prompt).toContain('prev123')
      expect(prompt).toContain('2026-04-02T10:00:00.000Z')
    })

    it('includes all cache fields in prior context', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace', { priorCache: mockCache })
      expect(prompt).toContain('### Codebase Familiarity')
      expect(prompt).toContain('Auth module at src/auth/, uses JWT tokens')
      expect(prompt).toContain('### Previous Review Findings')
      expect(prompt).toContain('Found null check issue in auth.ts line 42')
      expect(prompt).toContain('### Previous Review Summary')
      expect(prompt).toContain('PR adds SSO authentication support')
    })

    it('omits prior context section when no cache', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).not.toContain('## Prior Review Context')
    })

    it('includes note about fresh diff', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace', { priorCache: mockCache })
      expect(prompt).toContain('diff and comments below are fresh')
    })
  })

  describe('cache-writing instructions', () => {
    it('includes cache-writing instructions with correct path', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace', {
        cachePath: '/home/user/.codekin/pr-cache/owner/repo/pr-42.json',
      })
      expect(prompt).toContain('## Post-Review: Save Context')
      expect(prompt).toContain('/home/user/.codekin/pr-cache/owner/repo/pr-42.json')
      expect(prompt).toContain('Write tool')
    })

    it('omits cache-writing instructions when no cachePath', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).not.toContain('## Post-Review: Save Context')
    })
  })

  describe('intermediate file path overrides', () => {
    it('includes PR-specific draft and codex review paths', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('pr-42-draft-review.md')
      expect(prompt).toContain('pr-42-codex-review.md')
      expect(prompt).toContain('/tmp/workspace/pr-42-draft-review.md')
    })

    it('warns against writing to git-tracked directories', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('Do NOT write review files to the `docs/` directory')
    })

    it('includes overridden codex command with correct paths', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('codex exec - --skip-git-repo-check -o /tmp/workspace/pr-42-codex-review.md < /tmp/workspace/pr-42-draft-review.md')
    })
  })

  describe('comment posting instructions', () => {
    it('includes update instructions when existingCommentId provided', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace', {
        existingCommentId: 12345,
      })
      expect(prompt).toContain('## Posting Your Review Summary')
      expect(prompt).toContain('comment ID: 12345')
      expect(prompt).toContain('Update it instead of creating a new comment')
      expect(prompt).toContain('PATCH')
      expect(prompt).toContain('-F body=@/tmp/workspace/pr-42-review-body.md')
      expect(prompt).toContain(`issues/comments/12345`)
    })

    it('includes create instructions when no existing comment', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('## Posting Your Review Summary')
      expect(prompt).toContain('new comment')
      expect(prompt).toContain('-F body=@/tmp/workspace/pr-42-review-body.md')
      expect(prompt).toContain(`issues/${42}/comments`)
    })

    it('uses a PR-specific review body path to avoid collisions', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain('/tmp/workspace/pr-42-review-body.md')
      expect(prompt).not.toContain('/tmp/workspace/review-body.md')
    })

    it('always includes marker requirement in update instructions', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace', {
        existingCommentId: 12345,
      })
      expect(prompt).toContain(REVIEW_COMMENT_MARKER)
    })

    it('always includes marker requirement in create instructions', () => {
      const prompt = buildPrReviewPrompt(makeContext(), '/tmp/workspace')
      expect(prompt).toContain(REVIEW_COMMENT_MARKER)
    })
  })
})
