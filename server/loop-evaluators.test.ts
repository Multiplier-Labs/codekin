import { describe, it, expect } from 'vitest'
import {
  runCommandEvaluator,
  failureFingerprint,
  normalizeForFingerprint,
  parseRubricVerdict,
  buildRubricPrompt,
  displayCommand,
} from './loop-evaluators.js'
import type { CommandEvaluatorConfig } from './loop-recipe.js'

function config(command: string | string[], overrides: Partial<CommandEvaluatorConfig> = {}): CommandEvaluatorConfig {
  return { id: 'tests', type: 'command', command, timeoutMs: 10_000, required: true, retryMaxAttempts: 1, ...overrides }
}

describe('runCommandEvaluator', () => {
  it('passes on exit 0 with output captured', async () => {
    const out = await runCommandEvaluator(config('echo hello && echo world'), '/tmp')
    expect(out.status).toBe('pass')
    expect(out.exitCode).toBe(0)
    expect(out.fingerprint).toBeNull()
    expect(out.fullOutput).toContain('hello')
    expect(out.outputTail).toContain('world')
    expect(out.retryable).toBe(false)
  })

  it('fails on nonzero exit, classified code, not retryable, fingerprinted', async () => {
    const out = await runCommandEvaluator(config('echo broken && exit 3'), '/tmp')
    expect(out.status).toBe('fail')
    expect(out.exitCode).toBe(3)
    expect(out.classification).toBe('code')
    expect(out.retryable).toBe(false)
    expect(out.fingerprint).toMatch(/^[0-9a-f]{64}$/)
    expect(out.summary).toContain('exited 3')
  })

  it('runs argv arrays without a shell', async () => {
    const out = await runCommandEvaluator(config(['printf', '%s', 'argv-ok && $(nope)']), '/tmp')
    expect(out.status).toBe('pass')
    // The shell metacharacters were passed through as a literal argument.
    expect(out.fullOutput).toBe('argv-ok && $(nope)')
  })

  it('classifies a timeout as a retryable environment error', async () => {
    const out = await runCommandEvaluator(config('sleep 5', { timeoutMs: 150 }), '/tmp')
    expect(out.status).toBe('error')
    expect(out.classification).toBe('environment')
    expect(out.retryable).toBe(true)
    expect(out.timedOut).toBe(true)
    expect(out.summary).toContain('timed out')
  })

  it('classifies a spawn failure as a retryable environment error', async () => {
    const out = await runCommandEvaluator(config(['definitely-not-a-real-binary-xyz']), '/tmp')
    expect(out.status).toBe('error')
    expect(out.classification).toBe('environment')
    expect(out.retryable).toBe(true)
    expect(out.summary).toContain('could not start')
  })
})

describe('fingerprinting', () => {
  it('is stable across duration/timestamp/tmp-path churn', () => {
    const a = failureFingerprint('tests', 1, 'FAIL x.test.ts took 4.2s at 2026-08-30T12:00:00Z in /tmp/dir-abc1')
    const b = failureFingerprint('tests', 1, 'FAIL x.test.ts took 9.9s at 2026-08-30T13:41:22Z in /tmp/dir-xyz9')
    expect(a).toBe(b)
  })

  it('differs by evaluator, exit code, and content', () => {
    const base = failureFingerprint('tests', 1, 'FAIL a')
    expect(failureFingerprint('lint', 1, 'FAIL a')).not.toBe(base)
    expect(failureFingerprint('tests', 2, 'FAIL a')).not.toBe(base)
    expect(failureFingerprint('tests', 1, 'FAIL b')).not.toBe(base)
  })

  it('normalization collapses whitespace and volatile tokens', () => {
    expect(normalizeForFingerprint('took  4.2s   at\n2026-01-01T00:00:00Z')).toBe('took <dur> at <ts>')
  })
})

describe('parseRubricVerdict', () => {
  it('parses each verdict, last occurrence wins, reason captured', () => {
    expect(parseRubricVerdict('… VERDICT: approve')).toEqual({ verdict: 'approve' })
    expect(parseRubricVerdict('End with VERDICT: approve.\nActually: VERDICT: request_changes\nREASON: tests weakened')).toEqual({
      verdict: 'request_changes',
      reason: 'tests weakened',
    })
    expect(parseRubricVerdict('VERDICT: escalate\nREASON: risky migration')).toEqual({ verdict: 'escalate', reason: 'risky migration' })
  })

  it('returns null when no marker is present', () => {
    expect(parseRubricVerdict('looks good to me!')).toBeNull()
  })
})

describe('buildRubricPrompt', () => {
  it('includes goal, passed commands, instructions, and truncates huge diffs', () => {
    const prompt = buildRubricPrompt({
      recipeName: 'ci-repair',
      goal: 'Fix CI',
      passedCommands: ['npm test'],
      diff: 'x'.repeat(70_000),
      instructions: 'Watch for weakened tests.',
    })
    expect(prompt).toContain('Fix CI')
    expect(prompt).toContain('- `npm test`')
    expect(prompt).toContain('Watch for weakened tests.')
    expect(prompt).toContain('[diff truncated]')
    expect(prompt.length).toBeLessThan(65_000)
  })
})

describe('displayCommand', () => {
  it('joins argv arrays and passes strings through', () => {
    expect(displayCommand(['npm', 'run', 'lint'])).toBe('npm run lint')
    expect(displayCommand('npm test')).toBe('npm test')
  })
})
