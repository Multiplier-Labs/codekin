/** Tests for the verifier runner — exercises verify-command exit-code capture and the git diff helpers against a real temp repo. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runVerifier, getDiffSummary, getChangedFiles } from './verifier-runner.js'
import { execGit } from './diff-manager.js'

describe('runVerifier', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'verifier-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('passes when every command exits 0', async () => {
    const result = await runVerifier({ cwd: dir, commands: ['exit 0', 'echo ok'] })
    expect(result.passed).toBe(true)
    expect(result.results).toHaveLength(2)
    expect(result.results.every((r) => r.exitCode === 0)).toBe(true)
  })

  it('fails and short-circuits on the first non-zero command', async () => {
    const result = await runVerifier({ cwd: dir, commands: ['exit 3', 'echo should-not-run'] })
    expect(result.passed).toBe(false)
    // short-circuit: the second command is never executed
    expect(result.results).toHaveLength(1)
    expect(result.results[0].exitCode).toBe(3)
    expect(result.results[0].timedOut).toBe(false)
  })

  it('captures a tail of command output', async () => {
    const result = await runVerifier({ cwd: dir, commands: ['echo first-line; echo second-line'] })
    expect(result.results[0].outputTail).toContain('first-line')
    expect(result.results[0].outputTail).toContain('second-line')
  })

  it('trims output to the requested number of tail lines', async () => {
    const result = await runVerifier({
      cwd: dir,
      commands: ['for i in 1 2 3 4 5; do echo line-$i; done'],
      tailLines: 2,
    })
    const lines = result.results[0].outputTail.split('\n')
    expect(lines).toHaveLength(2)
    expect(lines).toEqual(['line-4', 'line-5'])
  })
})

describe('git helpers', () => {
  let dir: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'verifier-git-'))
    await execGit(['init', '-q'], dir)
    await execGit(['config', 'user.email', 'test@example.com'], dir)
    await execGit(['config', 'user.name', 'Test'], dir)
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    await execGit(['add', 'a.txt'], dir)
    await execGit(['commit', '-q', '-m', 'init'], dir)
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('reports a clean tree as empty', async () => {
    expect(await getChangedFiles(dir)).toEqual([])
    expect(await getDiffSummary(dir)).toBe('')
  })

  it('detects a modified tracked file', async () => {
    appendFileSync(join(dir, 'a.txt'), 'world\n')
    expect(await getChangedFiles(dir)).toEqual(['a.txt'])
    expect(await getDiffSummary(dir)).toContain('a.txt')
  })
})
