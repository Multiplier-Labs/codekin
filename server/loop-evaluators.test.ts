import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  runCommandEvaluator,
  runTestReportEvaluator,
  parseVitestOutput,
  parseTapOutput,
  parseJunitXml,
  analyzeDiffPolicy,
  checkArtifactRequirement,
  failureFingerprint,
  normalizeForFingerprint,
  parseRubricVerdict,
  buildRubricPrompt,
  displayCommand,
} from './loop-evaluators.js'
import type { ArtifactEvaluatorConfig, CommandEvaluatorConfig, DiffPolicyEvaluatorConfig, TestReportEvaluatorConfig } from './loop-recipe.js'

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

describe('test report parsers', () => {
  it('vitest: failing test lines and summary counts', () => {
    const out = [
      ' ✓ src/a.test.ts > adds numbers',
      ' × src/b.test.ts > handles zero 12ms',
      ' × src/b.test.ts > handles negatives',
      ' Tests  2 failed | 40 passed (42)',
    ].join('\n')
    const report = parseVitestOutput(out)
    expect(report.failing).toEqual(['src/b.test.ts > handles zero', 'src/b.test.ts > handles negatives'])
    expect(report.failedCount).toBe(2)
    expect(report.passedCount).toBe(40)
  })

  it('tap: not-ok lines with names', () => {
    const report = parseTapOutput(['1..3', 'ok 1 - first', 'not ok 2 - second thing', 'ok 3 - third'].join('\n'))
    expect(report.failing).toEqual(['second thing'])
    expect(report.passedCount).toBe(2)
  })

  it('junit-xml: failure/error testcases with classnames', () => {
    const xml = `<testsuite>
      <testcase classname="Suite" name="works"/>
      <testcase classname="Suite" name="breaks"><failure message="nope"/></testcase>
      <testcase name="errors"><error/></testcase>
    </testsuite>`
    const report = parseJunitXml(xml)
    expect(report.failing).toEqual(['Suite > breaks', 'errors'])
    expect(report.passedCount).toBe(1)
  })
})

describe('runTestReportEvaluator', () => {
  function trConfig(command: string, overrides: Partial<TestReportEvaluatorConfig> = {}): TestReportEvaluatorConfig {
    return { id: 'tests', type: 'test-report', command, parser: 'vitest', timeoutMs: 10_000, required: true, retryMaxAttempts: 1, ...overrides }
  }

  it('names failing tests in summary/tail and fingerprints by identity, not output noise', async () => {
    const script = `printf ' × src/x.test.ts > flaky one 42ms\\n Tests  1 failed | 3 passed (4)\\n'; exit 1`
    const a = await runTestReportEvaluator(trConfig(script), '/tmp')
    const b = await runTestReportEvaluator(trConfig(script.replace('42ms', '99ms')), '/tmp')
    expect(a.status).toBe('fail')
    expect(a.classification).toBe('test')
    expect(a.summary).toContain('flaky one')
    expect(a.outputTail).toContain('- src/x.test.ts > flaky one')
    expect(a.fingerprint).toBe(b.fingerprint) // identity-based, duration-insensitive
  })

  it('passes with counts on exit 0 and no failures', async () => {
    const out = await runTestReportEvaluator(trConfig(`printf ' ✓ ok\\n Tests  4 passed (4)\\n'`), '/tmp')
    expect(out.status).toBe('pass')
    expect(out.summary).toContain('(4 tests)')
  })

  it('junit-xml: exit 0 with a missing report is a retryable environment error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-tr-'))
    try {
      const out = await runTestReportEvaluator(trConfig('true', { parser: 'junit-xml', reportPath: 'report.xml' }), dir)
      expect(out.status).toBe('error')
      expect(out.retryable).toBe(true)
      expect(out.summary).toContain('no report')

      writeFileSync(join(dir, 'report.xml'), '<testsuite><testcase name="a"><failure/></testcase></testsuite>')
      const parsed = await runTestReportEvaluator(trConfig('true', { parser: 'junit-xml', reportPath: 'report.xml' }), dir)
      expect(parsed.status).toBe('fail')
      expect(parsed.summary).toContain('a')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('analyzeDiffPolicy', () => {
  const config: DiffPolicyEvaluatorConfig = {
    id: 'scope',
    type: 'diff-policy',
    maxChangedFiles: 2,
    maxChangedLines: 4,
    forbidPaths: ['dist/**'],
    noTestWeakening: true,
    secretScan: true,
    required: true,
  }

  it('flags size caps and forbidden paths', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '+a', '+b', '+c', '-d', '-e'].join('\n')
    const violations = analyzeDiffPolicy(config, diff, ['x.ts', 'y.ts', 'dist/bundle.js'])
    expect(violations.map((v) => v.rule)).toEqual(['max-changed-files', 'max-changed-lines', 'forbidden-path'])
  })

  it('flags test weakening: skips added in test files and deleted test files', () => {
    const diff = [
      'diff --git a/src/old.test.ts b/src/old.test.ts',
      'deleted file mode 100644',
      '--- a/src/old.test.ts',
      '+++ /dev/null',
      '-it("was a test", () => {})',
      '--- a/src/keep.test.ts',
      '+++ b/src/keep.test.ts',
      '+it.skip("now skipped", () => {})',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '+const notATest = it_skip',
    ].join('\n')
    const violations = analyzeDiffPolicy({ ...config, maxChangedFiles: undefined, maxChangedLines: undefined, forbidPaths: [] }, diff, [])
    expect(violations.map((v) => v.rule)).toEqual(['test-weakening', 'test-weakening'])
    expect(violations[0].detail).toContain('deleted')
    expect(violations[1].detail).toContain('now skipped')
  })

  it('flags likely secrets in added lines only', () => {
    const diff = [
      '--- a/config.ts',
      '+++ b/config.ts',
      '+const key = "AKIAIOSFODNN7EXAMPLE"',
      '-const old = "AKIAIOSFODNN7REMOVED"',
    ].join('\n')
    const violations = analyzeDiffPolicy({ ...config, maxChangedFiles: undefined, maxChangedLines: undefined, forbidPaths: [] }, diff, [])
    expect(violations).toHaveLength(1)
    expect(violations[0]).toMatchObject({ rule: 'secret' })
    expect(violations[0].detail).toContain('AWS')
  })

  it('a clean small diff yields no violations', () => {
    const diff = ['--- a/x.ts', '+++ b/x.ts', '+const a = 1'].join('\n')
    expect(analyzeDiffPolicy(config, diff, ['x.ts'])).toEqual([])
  })
})

describe('checkArtifactRequirement', () => {
  function artConfig(path: string, minBytes = 1): ArtifactEvaluatorConfig {
    return { id: 'report', type: 'artifact', path, minBytes, required: true }
  }

  it('finds files by glob, enforces the size floor, ignores node_modules', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-art-'))
    try {
      mkdirSync(join(dir, 'reports'), { recursive: true })
      mkdirSync(join(dir, 'node_modules', 'reports'), { recursive: true })
      writeFileSync(join(dir, 'reports', 'out.md'), '# hello report')
      writeFileSync(join(dir, 'node_modules', 'reports', 'decoy.md'), 'x')

      expect(checkArtifactRequirement(artConfig('reports/*.md'), dir).ok).toBe(true)
      expect(checkArtifactRequirement(artConfig('reports/*.md', 10_000), dir)).toMatchObject({ ok: false })
      expect(checkArtifactRequirement(artConfig('missing/**'), dir)).toMatchObject({ ok: false })
      expect(checkArtifactRequirement(artConfig('node_modules/**'), dir).ok).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('displayCommand', () => {
  it('joins argv arrays and passes strings through', () => {
    expect(displayCommand(['npm', 'run', 'lint'])).toBe('npm run lint')
    expect(displayCommand('npm test')).toBe('npm test')
  })
})
