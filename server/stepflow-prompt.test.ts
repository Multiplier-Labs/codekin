import { describe, expect, it } from 'vitest'
import { buildStepflowPrompt } from './stepflow-prompt.js'
import type { StepflowSessionRequest } from './stepflow-types.js'

function makeRequest(overrides: Partial<StepflowSessionRequest> = {}): StepflowSessionRequest {
  return {
    repo: 'acme/widget',
    cloneUrl: 'https://github.com/acme/widget.git',
    branch: 'main',
    headSha: '0123456789abcdef0123456789abcdef01234567',
    taskDescription: 'Fix the failing CI lint errors.',
    ...overrides,
  }
}

describe('buildStepflowPrompt', () => {
  it('always includes Task, Repository Info, and Instructions sections', () => {
    const out = buildStepflowPrompt(makeRequest(), 'run-abcdefgh1234', 'code.fix')

    expect(out).toContain('## Task')
    expect(out).toContain('Fix the failing CI lint errors.')
    expect(out).toContain('## Repository Info')
    expect(out).toContain('- **Repository**: acme/widget')
    expect(out).toContain('- **Branch**: main')
    expect(out).toContain('- **Commit**: 0123456')
    expect(out).toContain('## Instructions')
    expect(out).toContain('operate autonomously')
  })

  it('truncates the head SHA to seven characters', () => {
    const out = buildStepflowPrompt(makeRequest({ headSha: 'deadbeefcafe' }), 'r1', 'code.fix')
    expect(out).toContain('- **Commit**: deadbee')
    expect(out).not.toContain('deadbeefcafe')
  })

  it('omits the Context section when taskContext is undefined', () => {
    const out = buildStepflowPrompt(makeRequest(), 'r1', 'code.fix')
    expect(out).not.toContain('## Context')
  })

  it('includes the Context section when taskContext is provided', () => {
    const out = buildStepflowPrompt(
      makeRequest({ taskContext: 'Background detail.' }),
      'r1',
      'code.fix',
    )
    expect(out).toContain('## Context')
    expect(out).toContain('Background detail.')
  })

  it('renders PR number with title when both provided', () => {
    const out = buildStepflowPrompt(
      makeRequest({ prNumber: 42, prTitle: 'Add feature' }),
      'r1',
      'code.fix',
    )
    expect(out).toContain('- **Pull Request**: #42 — "Add feature"')
  })

  it('renders PR number without title when title omitted', () => {
    const out = buildStepflowPrompt(makeRequest({ prNumber: 42 }), 'r1', 'code.fix')
    expect(out).toContain('- **Pull Request**: #42')
    expect(out).not.toContain('- **Pull Request**: #42 — ')
  })

  it('adds the PR-comment instruction when prNumber is set', () => {
    const out = buildStepflowPrompt(makeRequest({ prNumber: 7 }), 'r1', 'code.fix')
    expect(out).toContain('Add a brief comment on PR #7')
  })

  it('omits the PR-comment instruction when no prNumber', () => {
    const out = buildStepflowPrompt(makeRequest(), 'r1', 'code.fix')
    expect(out).not.toMatch(/Add a brief comment on PR/)
  })

  it('renders issue number with and without title', () => {
    const withTitle = buildStepflowPrompt(
      makeRequest({ issueNumber: 99, issueTitle: 'Bug' }),
      'r1',
      'code.fix',
    )
    expect(withTitle).toContain('- **Issue**: #99 — "Bug"')

    const noTitle = buildStepflowPrompt(makeRequest({ issueNumber: 99 }), 'r1', 'code.fix')
    expect(noTitle).toContain('- **Issue**: #99')
    expect(noTitle).not.toContain('- **Issue**: #99 — ')
  })

  it('includes a traceability footer with kind and runId', () => {
    const out = buildStepflowPrompt(makeRequest(), 'run-xyz', 'code.fix')
    expect(out).toContain('_Triggered by Stepflow workflow `code.fix` (run `run-xyz`)._')
  })

  describe('report output section', () => {
    it.each([
      ['code.review', '.codekin/reports/code-review'],
      ['security.audit', '.codekin/reports/security'],
      ['complexity.analysis', '.codekin/reports/complexity'],
      ['complexity.report', '.codekin/reports/complexity'],
      ['coverage.assessment', '.codekin/reports/coverage'],
      ['coverage.analysis', '.codekin/reports/coverage'],
      ['comment.assessment', '.codekin/reports/comments'],
      ['dependency.health', '.codekin/reports/dependencies'],
    ])('emits Report Output section for %s → %s', (kind, dir) => {
      const out = buildStepflowPrompt(makeRequest(), 'run-12345678ext', kind)
      expect(out).toContain('## Report Output')
      expect(out).toContain(`This is a **${kind}** workflow.`)
      expect(out).toContain(dir)
    })

    it('uses the truncated runId in the report filename', () => {
      const out = buildStepflowPrompt(makeRequest(), 'run-12345678ext', 'code.review')
      expect(out).toMatch(/\d{4}-\d{2}-\d{2}_acme-widget-run-1234\.md/)
    })

    it('replaces the slash in repo name with a dash for filename', () => {
      const out = buildStepflowPrompt(
        makeRequest({ repo: 'org/sub/proj' }),
        'run-aaaaaaaaaa',
        'code.review',
      )
      // Only the first '/' is replaced — that's the documented behavior.
      expect(out).toMatch(/_org-sub\/proj-/)
    })

    it('reminds Claude not to commit the report on the current branch', () => {
      const out = buildStepflowPrompt(makeRequest(), 'r1', 'security.audit')
      expect(out).toContain('Do NOT commit this report on the current branch')
    })

    it('omits the Report Output section for non-report kinds', () => {
      const out = buildStepflowPrompt(makeRequest(), 'r1', 'code.fix')
      expect(out).not.toContain('## Report Output')
    })
  })

  it('preserves section order: Task, (Context), Repository Info, Instructions, (Report Output)', () => {
    const out = buildStepflowPrompt(
      makeRequest({ taskContext: 'ctx', prNumber: 1 }),
      'run-abcdefgh',
      'code.review',
    )
    const taskIdx = out.indexOf('## Task')
    const ctxIdx = out.indexOf('## Context')
    const repoIdx = out.indexOf('## Repository Info')
    const instrIdx = out.indexOf('## Instructions')
    const reportIdx = out.indexOf('## Report Output')

    expect(taskIdx).toBeLessThan(ctxIdx)
    expect(ctxIdx).toBeLessThan(repoIdx)
    expect(repoIdx).toBeLessThan(instrIdx)
    expect(instrIdx).toBeLessThan(reportIdx)
  })
})
