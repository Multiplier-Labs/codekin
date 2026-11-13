/** Tests for resolvePrReviewAutomation: which PR Review automation governs a PR event. */
import { describe, it, expect } from 'vitest'
import { resolvePrReviewAutomation, type PrReviewDeps } from './pr-review-automation.js'
import type { ReviewRepoConfig, WorkflowConfig } from './workflow-config.js'

const SLUGS: Record<string, string | null> = {
  '/repos/widget': 'acme/widget',
  '/repos/gadget': 'acme/gadget',
  '/repos/no-remote': null,
}

function row(overrides: Partial<ReviewRepoConfig>): ReviewRepoConfig {
  return { id: 'r', name: 'r', repoPath: '/repos/widget', cronExpression: 'event', enabled: true, kind: 'pr-review', ...overrides }
}

function deps(config: WorkflowConfig, hold?: PrReviewDeps['holdReason']): PrReviewDeps {
  return { load: () => config, slugOf: (p) => SLUGS[p] ?? null, holdReason: hold }
}

describe('resolvePrReviewAutomation', () => {
  it('reviews every repo with defaults before any PR Review automation exists', () => {
    const config = { reviewRepos: [row({ kind: 'code-review.daily', cronExpression: '0 9 * * *' })] }
    expect(resolvePrReviewAutomation('acme/widget', deps(config))).toEqual({ kind: 'legacy' })
  })

  it('stops reviewing once the last PR Review automation is deleted', () => {
    const config = { reviewRepos: [], prReviewAutomationsAdopted: true }
    expect(resolvePrReviewAutomation('acme/widget', deps(config))).toEqual({
      kind: 'skip', reason: 'No PR Review automation for acme/widget',
    })
  })

  it('skips repos without a PR Review automation', () => {
    const config = { reviewRepos: [row({ repoPath: '/repos/gadget' })] }
    expect(resolvePrReviewAutomation('acme/widget', deps(config)).kind).toBe('skip')
  })

  it('skips a paused automation', () => {
    const config = { reviewRepos: [row({ enabled: false })] }
    expect(resolvePrReviewAutomation('acme/widget', deps(config))).toEqual({
      kind: 'skip', reason: 'The PR Review automation for acme/widget is paused',
    })
  })

  it("matches the repo case-insensitively and returns the automation's agent, model and prompt", () => {
    const config = { reviewRepos: [row({ id: 'w', model: 'gpt-6', provider: 'codex', customPrompt: '  Focus on SQL.  ' })] }
    expect(resolvePrReviewAutomation('Acme/Widget', deps(config))).toEqual({
      kind: 'review',
      settings: { automationId: 'w', model: 'gpt-6', provider: 'codex', customPrompt: 'Focus on SQL.' },
    })
  })

  it('leaves out settings the automation does not set', () => {
    const config = { reviewRepos: [row({ id: 'w', customPrompt: '   ' })] }
    expect(resolvePrReviewAutomation('acme/widget', deps(config))).toEqual({ kind: 'review', settings: { automationId: 'w' } })
  })

  it('prefers an enabled automation when the repo has several', () => {
    const config = { reviewRepos: [row({ id: 'off', enabled: false }), row({ id: 'on' })] }
    const decision = resolvePrReviewAutomation('acme/widget', deps(config))
    expect(decision.kind === 'review' && decision.settings.automationId).toBe('on')
  })

  it('skips while a maintenance plan holds the automation, and fails open if the check throws', () => {
    const config = { reviewRepos: [row({ id: 'w' })] }
    const held = resolvePrReviewAutomation('acme/widget', deps(config, () => 'maintenance paused — resumes with the plan'))
    expect(held).toEqual({ kind: 'skip', reason: 'The PR Review automation for acme/widget is held: maintenance paused — resumes with the plan' })
    const broken = resolvePrReviewAutomation('acme/widget', deps(config, () => { throw new Error('db') }))
    expect(broken.kind).toBe('review')
  })
})
