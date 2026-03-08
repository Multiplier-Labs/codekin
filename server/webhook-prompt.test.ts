import { describe, it, expect } from 'vitest'
import { buildPrompt } from './webhook-prompt.js'
import type { FailureContext } from './webhook-types.js'

function makeContext(overrides: Partial<FailureContext> = {}): FailureContext {
  return {
    repo: 'owner/repo',
    repoName: 'repo',
    branch: 'main',
    headSha: 'abc1234567890',
    workflowName: 'CI',
    runId: 100,
    runNumber: 42,
    runAttempt: 1,
    actor: 'octocat',
    event: 'push',
    htmlUrl: 'https://github.com/owner/repo/actions/runs/100',
    failedLogs: 'Error: test failed\n  at test.js:10\n  at runner.js:5',
    annotations: [
      { path: 'src/index.ts', startLine: 10, endLine: 10, message: 'Type error', annotationLevel: 'failure' },
    ],
    jobs: [
      { id: 1, name: 'build', conclusion: 'failure', steps: [] },
      { id: 2, name: 'test', conclusion: 'failure', steps: [] },
    ],
    pullRequest: { number: 7, title: 'Fix the thing' },
    commitMessage: 'attempt to fix CI',
    ...overrides,
  }
}

describe('buildPrompt', () => {
  it('full context produces all sections', () => {
    const ctx = makeContext()
    const prompt = buildPrompt(ctx)

    expect(prompt).toContain('A GitHub Actions workflow has failed')
    expect(prompt).toContain('**Repository**: owner/repo')
    expect(prompt).toContain('**Branch**: main')
    expect(prompt).toContain('**Workflow**: CI (run #42)')
    expect(prompt).toContain('**Failed jobs**: build, test')
    expect(prompt).toContain('**Trigger**: push by octocat')
    expect(prompt).toContain('**Commit**: abc1234 — "attempt to fix CI"')
    expect(prompt).toContain('**Pull Request**: #7 — "Fix the thing"')
    expect(prompt).toContain('## Error Logs')
    expect(prompt).toContain('Error: test failed')
    expect(prompt).toContain('## Annotations')
    expect(prompt).toContain('src/index.ts:10 — Type error')
    expect(prompt).toContain('## Instructions')
    expect(prompt).toContain('Commit the changes')
    expect(prompt).toContain('Push the commit')
    expect(prompt).toContain('Add a brief comment on PR #7')
  })

  it('missing PR omits PR line and suggests creating one', () => {
    const ctx = makeContext({ pullRequest: undefined })
    const prompt = buildPrompt(ctx)

    expect(prompt).not.toContain('**Pull Request**')
    expect(prompt).not.toContain('Add a brief comment on PR')
    expect(prompt).toContain('create a pull request')
  })

  it('empty annotations omits annotations section', () => {
    const ctx = makeContext({ annotations: [] })
    const prompt = buildPrompt(ctx)

    expect(prompt).not.toContain('## Annotations')
  })

  it('empty logs shows "No logs available"', () => {
    const ctx = makeContext({ failedLogs: '' })
    const prompt = buildPrompt(ctx)

    expect(prompt).toContain('No logs available')
  })

  it('whitespace-only logs shows "No logs available"', () => {
    const ctx = makeContext({ failedLogs: '   \n  \n  ' })
    const prompt = buildPrompt(ctx)

    expect(prompt).toContain('No logs available')
  })

  it('log truncation keeps last N lines', () => {
    const logLines = Array.from({ length: 300 }, (_, i) => `line ${i + 1}`)
    const ctx = makeContext({ failedLogs: logLines.join('\n') })
    const prompt = buildPrompt(ctx, 50)

    // Should contain the last 50 lines
    expect(prompt).toContain('line 251')
    expect(prompt).toContain('line 300')
    // Should NOT contain the first lines
    expect(prompt).not.toContain('line 1\n')
    expect(prompt).not.toContain('line 250\n')
  })

  it('logs within limit are not truncated', () => {
    const logLines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`)
    const ctx = makeContext({ failedLogs: logLines.join('\n') })
    const prompt = buildPrompt(ctx, 200)

    expect(prompt).toContain('line 1')
    expect(prompt).toContain('line 10')
  })

  it('missing commitMessage omits the message quote', () => {
    const ctx = makeContext({ commitMessage: undefined })
    const prompt = buildPrompt(ctx)

    // Should have the commit sha but no quoted message
    expect(prompt).toContain('**Commit**: abc1234')
    expect(prompt).not.toContain('**Commit**: abc1234 —')
  })

  it('empty jobs array shows "Unknown"', () => {
    const ctx = makeContext({ jobs: [] })
    const prompt = buildPrompt(ctx)

    expect(prompt).toContain('**Failed jobs**: Unknown')
  })

  it('PR without title omits title quote', () => {
    const ctx = makeContext({ pullRequest: { number: 12 } })
    const prompt = buildPrompt(ctx)

    expect(prompt).toContain('**Pull Request**: #12')
    expect(prompt).not.toContain('**Pull Request**: #12 —')
  })
})
