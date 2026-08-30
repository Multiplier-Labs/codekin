/** Tests for the dependency-audit sweep — change gating, alert policy, state handling. Uses injected IO and a temp state file. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runDependencyAuditSweep, shouldAlert, parseAuditCounts, type AuditCounts, type DependencyAuditIo } from './dependency-audit.js'

const REPO = '/fake/repo'
const CLEAN: AuditCounts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 }
const BAD: AuditCounts = { ...CLEAN, high: 2, critical: 1 }

describe('shouldAlert', () => {
  it('alerts on first sight of actionable exposure and on changes, stays quiet otherwise', () => {
    expect(shouldAlert(undefined, BAD)).toBe(true)
    expect(shouldAlert(undefined, CLEAN)).toBe(false)
    expect(shouldAlert(BAD, BAD)).toBe(false)                       // unchanged
    expect(shouldAlert(BAD, { ...BAD, critical: 2 })).toBe(true)    // grew
    expect(shouldAlert(BAD, { ...CLEAN, high: 1 })).toBe(true)      // shrank but still exposed
    expect(shouldAlert(BAD, CLEAN)).toBe(false)                     // fully resolved — no alert
  })
})

describe('parseAuditCounts', () => {
  it('reads npm audit metadata and defaults missing severities to 0', () => {
    expect(parseAuditCounts(JSON.stringify({ metadata: { vulnerabilities: { high: 3 } } })))
      .toEqual({ info: 0, low: 0, moderate: 0, high: 3, critical: 0 })
    expect(parseAuditCounts('not json')).toBeNull()
    expect(parseAuditCounts('{}')).toBeNull()
  })
})

describe('runDependencyAuditSweep', () => {
  let dir: string
  let statePath: string
  let published: Array<{ kind: string; payload?: Record<string, unknown>; dedupeKey?: string }>

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dep-audit-'))
    statePath = join(dir, 'state.json')
    published = []
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function makeIo(overrides: Partial<DependencyAuditIo> = {}): Partial<DependencyAuditIo> {
    return {
      headSha: () => 'sha-1',
      changedFiles: () => ['src/app.ts'],
      hasLockfile: () => true,
      runNpmAudit: vi.fn(async () => BAD),
      ...overrides,
    }
  }

  const sweep = (io: Partial<DependencyAuditIo>) =>
    runDependencyAuditSweep({ publish: (i) => published.push(i), io, statePath, repoPaths: [REPO] })

  it('audits on first sight, publishes on actionable exposure, and persists state', async () => {
    const io = makeIo()
    await sweep(io)

    expect(io.runNpmAudit).toHaveBeenCalledTimes(1)
    expect(published).toHaveLength(1)
    expect(published[0].kind).toBe('dependency-audit')
    expect(published[0].dedupeKey).toBe(`dependency-audit::${REPO}::sha-1`)
    expect(published[0].payload).toMatchObject({ repoPath: REPO, counts: BAD })

    const state = JSON.parse(readFileSync(statePath, 'utf-8')) as Record<string, { sha: string }>
    expect(state[REPO].sha).toBe('sha-1')
  })

  it('skips entirely when HEAD has not moved', async () => {
    const io = makeIo()
    await sweep(io)
    await sweep(io)
    expect(io.runNpmAudit).toHaveBeenCalledTimes(1)
  })

  it('advances the sha without auditing when no manifest changed', async () => {
    const io = makeIo()
    await sweep(io)

    const io2 = makeIo({ headSha: () => 'sha-2', changedFiles: () => ['src/other.ts', 'README.md'] })
    await sweep(io2)
    expect(io2.runNpmAudit).not.toHaveBeenCalled()

    // And the new sha is recorded — the untouched-manifest commit is settled.
    const io3 = makeIo({ headSha: () => 'sha-2' })
    await sweep(io3)
    expect(io3.runNpmAudit).not.toHaveBeenCalled()
  })

  it('audits again when the lockfile changed, but stays quiet while counts are unchanged', async () => {
    const io = makeIo()
    await sweep(io)
    published = []

    const io2 = makeIo({ headSha: () => 'sha-2', changedFiles: () => ['package-lock.json'] })
    await sweep(io2)
    expect(io2.runNpmAudit).toHaveBeenCalledTimes(1)
    expect(published).toHaveLength(0) // same high+critical as before
  })

  it('errs toward auditing when the diff fails (rewritten history)', async () => {
    const io = makeIo()
    await sweep(io)

    const io2 = makeIo({ headSha: () => 'sha-2', changedFiles: () => null })
    await sweep(io2)
    expect(io2.runNpmAudit).toHaveBeenCalledTimes(1)
  })

  it('leaves state untouched when the audit fails, so the next sweep retries', async () => {
    const io = makeIo({ runNpmAudit: vi.fn(async () => null) })
    await sweep(io)

    const io2 = makeIo()
    await sweep(io2)
    expect(io2.runNpmAudit).toHaveBeenCalledTimes(1)
    expect(published).toHaveLength(1)
  })

  it('records the sha without auditing when there is no lockfile', async () => {
    const io = makeIo({ hasLockfile: () => false })
    await sweep(io)
    expect(io.runNpmAudit).not.toHaveBeenCalled()
    expect(published).toHaveLength(0)
  })
})
