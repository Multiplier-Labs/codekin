/** Tests for abuse signals: the policy file, each rule, the review queue and throttling. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import type Database from 'better-sqlite3'
import { openControlPlaneDb, upsertUserFromGithub, BOOTSTRAP_WORKSPACE_ID } from './control-plane-db.js'
import { listAuditEvents } from './audit.js'
import {
  isWellFormedStreamData,
  listAbuseFlags,
  parseAbusePolicy,
  recordFinding,
  resolveAbuseFlag,
  RulePolicy,
  throttledWorkspaces,
} from './abuse-signals.js'
import type { MachineTrafficSummary } from './abuse-signals.js'
import { UsageMeter } from './usage-meter.js'
import { UNLIMITED } from './quotas.js'

const quiet: MachineTrafficSummary = {
  machineId: 'm1', workspaceId: 'ws', connectorVersion: '0.10.5', windowSeconds: 600,
  frames: 1000, bytes: 1_000_000, streamFrames: 800, malformedStreamFrames: 0, largeFrames: 0, sessionsAdvertised: 2,
}

describe('policy file', () => {
  it.each([
    [{ nope: 1 }, 'unknown key "nope"'],
    [{ malformedStreamFrames: { minFrames: 0, ratio: 0.01, action: 'flag' } }, 'minFrames'],
    [{ malformedStreamFrames: { minFrames: 10, ratio: 0.01, action: 'ban' } }, 'one of flag, throttle'],
    [{ sustainedThroughput: { bytesPerSecond: 100, windows: 1.5, action: 'flag' } }, 'windows'],
    [{ windowMinutes: 0 }, 'windowMinutes'],
  ])('rejects %j', (json, message) => {
    expect(() => parseAbusePolicy(json)).toThrow(message)
  })

  it('only inspects stream frames and counts large frames when a rule needs it', () => {
    const none = new RulePolicy(parseAbusePolicy({}))
    expect(none.inspectStreamFrames).toBe(false)
    expect(none.largeFrameBytes).toBe(0)
    expect(none.windowMs).toBe(600_000)
    expect(none.evaluate(quiet)).toEqual([])
  })
})

describe('rules', () => {
  const policy = () => new RulePolicy(parseAbusePolicy({
    windowMinutes: 10,
    malformedStreamFrames: { minFrames: 100, ratio: 0.01, action: 'flag' },
    largeFrames: { minFrames: 100, ratio: 0.5, frameBytes: 4_000_000, action: 'flag' },
    sustainedThroughput: { bytesPerSecond: 1_000_000, windows: 2, action: 'throttle' },
    trafficWithoutSessions: { bytes: 10_000_000, action: 'flag' },
  }))

  it('stays quiet for ordinary traffic', () => {
    expect(policy().evaluate(quiet)).toEqual([])
  })

  it('flags a machine whose stream frames are not Codekin frames', () => {
    expect(policy().evaluate({ ...quiet, malformedStreamFrames: 9 })[0]).toMatchObject({ signal: 'malformedStreamFrames', action: 'flag' })
    // Too few frames to judge.
    expect(policy().evaluate({ ...quiet, streamFrames: 50, malformedStreamFrames: 50 })).toEqual([])
  })

  it('flags mostly near-maximum frames', () => {
    expect(policy().evaluate({ ...quiet, largeFrames: 600 }).map(f => f.signal)).toEqual(['largeFrames'])
  })

  it('throttles only throughput sustained over consecutive windows', () => {
    const p = policy()
    const busy = { ...quiet, bytes: 1_200_000 * 600 }
    expect(p.evaluate(busy)).toEqual([])
    expect(p.evaluate(busy)).toMatchObject([{ signal: 'sustainedThroughput', action: 'throttle', detail: { windows: 2 } }])
    expect(p.evaluate(quiet)).toEqual([])
    expect(p.evaluate(busy)).toEqual([])
  })

  it('flags heavy traffic from a machine that says it runs no sessions', () => {
    expect(policy().evaluate({ ...quiet, bytes: 20_000_000, sessionsAdvertised: 0 }).map(f => f.signal)).toEqual(['trafficWithoutSessions'])
    expect(policy().evaluate({ ...quiet, bytes: 20_000_000, sessionsAdvertised: null })).toEqual([])
  })
})

describe('isWellFormedStreamData', () => {
  it.each([
    ['{"type":"output","data":"x"}', true],
    ['{"data":"x"}', false],
    ['{"type":7}', false],
    ['[1,2]', false],
    ['GET / HTTP/1.1', false],
    ['{not json', false],
    [42, false],
  ])('%j → %s', (data, ok) => {
    expect(isWellFormedStreamData(data)).toBe(ok)
  })
})

describe('review queue', () => {
  let db: Database.Database
  let operatorId: string

  beforeEach(() => {
    db = openControlPlaneDb(':memory:')
    operatorId = upsertUserFromGithub(db, { id: 1, login: 'op', name: null, email: null, avatarUrl: null }, { ownerGithubId: 1, allowedGithubIds: [] }).id
    db.prepare(`INSERT INTO machines (id, workspace_id, owner_user_id, display_name) VALUES ('m1', ?, ?, 'box')`).run(BOOTSTRAP_WORKSPACE_ID, operatorId)
  })
  afterEach(() => { db.close() })

  it('keeps one open flag per machine and signal, audits it, and lists it with names', () => {
    const finding = { signal: 'largeFrames', action: 'flag' as const, detail: { frames: 200 } }
    const id = recordFinding(db, 'm1', finding)
    expect(id).not.toBeNull()
    expect(recordFinding(db, 'm1', finding)).toBeNull()
    const [flag] = listAbuseFlags(db)
    expect(flag).toMatchObject({ id, machineName: 'box', ownerLogin: 'op', signal: 'largeFrames', detail: { frames: 200 } })
    expect(listAuditEvents(db, {}).some(e => e.kind === 'abuse_flagged')).toBe(true)
  })

  it('resolving closes the flag, frees the signal to fire again, and lifts its throttle', () => {
    const id = recordFinding(db, 'm1', { signal: 'sustainedThroughput', action: 'throttle', detail: {} })!
    expect(throttledWorkspaces(db)).toEqual(new Set([BOOTSTRAP_WORKSPACE_ID]))
    expect(resolveAbuseFlag(db, id, operatorId, 'backup job, fine')).toMatchObject({ id, resolutionNote: 'backup job, fine' })
    expect(resolveAbuseFlag(db, id, operatorId, 'again')).toBeNull()
    expect(listAbuseFlags(db)).toEqual([])
    expect(listAbuseFlags(db, 'all')).toHaveLength(1)
    expect(throttledWorkspaces(db).size).toBe(0)
    expect(recordFinding(db, 'm1', { signal: 'sustainedThroughput', action: 'throttle', detail: {} })).not.toBeNull()
  })

  it('a throttle flag slows its workspace in the usage meter even without a daily quota', () => {
    const meter = new UsageMeter(db, UNLIMITED, { flushIntervalMs: 3_600_000, log: () => {} })
    const source = {}
    expect(meter.record('ws', 'm2b', 200_000, source)).toBe(0)
    meter.setForcedThrottle(new Set(['ws']))
    expect(meter.record('ws', 'm2b', 200_000, source)).toBeGreaterThan(0)
    meter.setForcedThrottle(new Set())
    expect(meter.record('ws', 'm2b', 200_000, {})).toBe(0)
    meter.close()
  })
})
