/**
 * Tests for the trigger dispatch loop — pre-dispatch gates (change detection,
 * single-flight, catch-up policy), per-tick stagger cap, trigger ledger, and
 * the engine heartbeat. Uses a real in-memory SQLite database because the
 * dispatcher's behavior spans several tables.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { WorkflowEngine } from './workflow-engine.js'

const REPO = '/fake/repo'
const CRON_EVERY_MINUTE = '* * * * *'

/** A time at which a freshly-upserted every-minute schedule is due. */
const dueAt = (msFromNow = 2 * 60_000) => new Date(Date.now() + msFromNow)

function settle(ms = 50) {
  return new Promise(r => setTimeout(r, ms))
}

describe('trigger dispatch', () => {
  let engine: WorkflowEngine

  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    engine = new WorkflowEngine(':memory:')
    engine.registerWorkflow({
      kind: 'test-wf',
      steps: [{ key: 'work', handler: async () => ({}) }],
    })
    engine.setHeadShaResolver(() => 'sha1')
    engine.upsertSchedule({
      id: 'sched-1',
      kind: 'test-wf',
      cronExpression: CRON_EVERY_MINUTE,
      input: { repoPath: REPO },
      enabled: true,
    })
  })

  afterEach(() => {
    engine.shutdown()
    vi.restoreAllMocks()
  })

  it('dispatches a due schedule and advances lastReviewedSha on success', async () => {
    engine.dispatchTick(dueAt())
    await settle()

    const runs = engine.listRuns({ kind: 'test-wf' })
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe('succeeded')
    expect(engine.getSchedule('sched-1')?.lastReviewedSha).toBe('sha1')

    const fired = engine.listTriggerLedger({ scheduleId: 'sched-1' }).filter(e => e.decision === 'fired')
    expect(fired).toHaveLength(1)
    expect(fired[0].headSha).toBe('sha1')
    expect(fired[0].runId).toBe(runs[0].id)
  })

  it('holds when HEAD is unchanged since the last successful run, and fires again when it moves', async () => {
    engine.dispatchTick(dueAt())
    await settle()
    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(1)

    // Same sha → held, no new run, reason recorded on the schedule and in the ledger.
    engine.dispatchTick(dueAt(4 * 60_000))
    await settle()
    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(1)
    const schedule = engine.getSchedule('sched-1')!
    expect(schedule.lastHeldReason).toBe('no new commits since last successful run')
    expect(schedule.heldCount).toBe(1)
    expect(engine.listTriggerLedger({ scheduleId: 'sched-1' })[0].decision).toBe('held')

    // New commit → gate opens.
    engine.setHeadShaResolver(() => 'sha2')
    engine.dispatchTick(dueAt(8 * 60_000))
    await settle()
    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(2)
  })

  it('does not advance lastReviewedSha when the run fails, so the commits are re-examined', async () => {
    engine.registerWorkflow({
      kind: 'test-wf',
      steps: [{ key: 'work', handler: async () => { throw new Error('boom') } }],
    })

    engine.dispatchTick(dueAt())
    await settle()

    expect(engine.listRuns({ kind: 'test-wf' })[0].status).toBe('failed')
    expect(engine.getSchedule('sched-1')?.lastReviewedSha).toBeNull()

    // Next fire re-dispatches — the change gate must not treat the failed sha as reviewed.
    engine.dispatchTick(dueAt(4 * 60_000))
    await settle()
    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(2)
  })

  it('holds while a previous run for the same repo is still active', async () => {
    let release!: () => void
    engine.registerWorkflow({
      kind: 'test-wf',
      steps: [{ key: 'work', handler: () => new Promise(r => { release = () => r({}) }) }],
    })

    const t1 = dueAt()
    engine.dispatchTick(t1)
    await settle()
    expect(engine.listRuns({ kind: 'test-wf', status: 'running' })).toHaveLength(1)

    // Second fire while the first run is still going → held with a retry, not stacked.
    const t2 = new Date(t1.getTime() + 2 * 60_000)
    engine.dispatchTick(t2)
    await settle()
    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(1)
    const schedule = engine.getSchedule('sched-1')!
    expect(schedule.lastHeldReason).toBe('previous run still active')
    expect(new Date(schedule.nextRunAt!).getTime()).toBe(t2.getTime() + WorkflowEngine.CONCURRENCY_RETRY_MS)

    release()
    await settle()
  })

  it('caps dispatches per tick and picks up the rest on the next tick', async () => {
    const shas = new Map<string, string>()
    engine.setHeadShaResolver(repoPath => {
      if (!shas.has(repoPath)) shas.set(repoPath, `sha-${repoPath}`)
      return shas.get(repoPath)!
    })
    for (let i = 2; i <= 5; i++) {
      engine.upsertSchedule({
        id: `sched-${i}`,
        kind: 'test-wf',
        cronExpression: CRON_EVERY_MINUTE,
        input: { repoPath: `${REPO}-${i}` },
        enabled: true,
      })
    }

    engine.dispatchTick(dueAt())
    await settle()
    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(WorkflowEngine.MAX_DISPATCH_PER_TICK)

    engine.dispatchTick(dueAt(3 * 60_000))
    await settle()
    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(5)
  })

  it("skips a missed fire window under catchUp 'skip' instead of firing late", async () => {
    engine.upsertSchedule({
      id: 'sched-1',
      kind: 'test-wf',
      cronExpression: CRON_EVERY_MINUTE,
      input: { repoPath: REPO },
      enabled: true,
      catchUp: 'skip',
    })

    // Overdue by well past the grace window (next fire was ~1 min out; tick 20 min later).
    engine.dispatchTick(dueAt(20 * 60_000))
    await settle()

    expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(0)
    expect(engine.getSchedule('sched-1')?.lastHeldReason).toBe('missed fire window (catch-up: skip)')
  })

  describe('activity gate', () => {
    it('holds dormant repos and re-opens when they wake', async () => {
      let tier: 'active' | 'cooling' | 'dormant' = 'dormant'
      engine.setActivityResolver(() => ({ tier }))

      engine.dispatchTick(dueAt())
      await settle()
      expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(0)
      expect(engine.getSchedule('sched-1')?.lastHeldReason).toBe('repo dormant — held until activity resumes')

      tier = 'active'
      engine.dispatchTick(dueAt(4 * 60_000))
      await settle()
      expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(1)
    })

    it('throttles cooling repos to the weekly interval', async () => {
      engine.setActivityResolver(() => ({ tier: 'cooling' }))

      // First fire: no lastRunAt yet → cooling does not block.
      engine.dispatchTick(dueAt())
      await settle()
      expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(1)

      // A day later: inside the weekly interval → held.
      engine.setHeadShaResolver(() => 'sha2')
      engine.dispatchTick(dueAt(24 * 60 * 60_000))
      await settle()
      expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(1)
      expect(engine.getSchedule('sched-1')?.lastHeldReason).toBe('repo cooling — throttled to weekly cadence')

      // Past the weekly interval → fires.
      engine.dispatchTick(dueAt(8 * 24 * 60 * 60_000))
      await settle()
      expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(2)
    })

    it('fails open when the resolver throws', async () => {
      engine.setActivityResolver(() => { throw new Error('index broken') })

      engine.dispatchTick(dueAt())
      await settle()
      expect(engine.listRuns({ kind: 'test-wf' })).toHaveLength(1)
    })
  })

  describe('durable signals', () => {
    it('delivers a signal to its handler and acks it as done', async () => {
      const seen: unknown[] = []
      engine.registerSignalHandler('test-signal', async (payload) => { seen.push(payload) })

      const { id, deduped } = engine.enqueueSignal({ kind: 'test-signal', payload: { n: 1 } })
      expect(deduped).toBe(false)

      engine.dispatchTick(dueAt(0))
      await settle()

      expect(seen).toEqual([{ n: 1 }])
      const signal = engine.listSignals().find(s => s.id === id)!
      expect(signal.status).toBe('done')
      expect(signal.attempts).toBe(1)
      const fired = engine.listTriggerLedger().find(e => e.kind === 'signal:test-signal')
      expect(fired?.decision).toBe('fired')
    })

    it('absorbs duplicate enqueues while a signal with the same dedupe key is pending', () => {
      const first = engine.enqueueSignal({ kind: 'test-signal', dedupeKey: 'k1' })
      const second = engine.enqueueSignal({ kind: 'test-signal', dedupeKey: 'k1' })
      expect(second).toEqual({ id: first.id, deduped: true })
      expect(engine.listSignals({ status: 'pending' })).toHaveLength(1)
    })

    it('redelivers after lease expiry when the handler rejects, then acks on success', async () => {
      let calls = 0
      engine.registerSignalHandler('flaky', async () => {
        calls++
        if (calls === 1) throw new Error('transient')
      })
      const { id } = engine.enqueueSignal({ kind: 'flaky' })

      const t0 = dueAt(0)
      engine.dispatchTick(t0)
      await settle()
      expect(engine.listSignals().find(s => s.id === id)?.status).toBe('processing')
      expect(engine.listSignals().find(s => s.id === id)?.error).toBe('transient')

      // Lease (5 min) expires → reclaimed and redelivered on the next tick.
      engine.dispatchTick(new Date(t0.getTime() + 6 * 60_000))
      await settle()
      const signal = engine.listSignals().find(s => s.id === id)!
      expect(calls).toBe(2)
      expect(signal.status).toBe('done')
      expect(signal.attempts).toBe(2)
    })

    it('fails a signal after the attempt cap instead of retrying forever', async () => {
      engine.registerSignalHandler('doomed', async () => { throw new Error('always') })
      const { id } = engine.enqueueSignal({ kind: 'doomed' })

      let t = dueAt(0)
      for (let i = 0; i < WorkflowEngine.SIGNAL_MAX_ATTEMPTS + 1; i++) {
        engine.dispatchTick(t)
        await settle()
        t = new Date(t.getTime() + WorkflowEngine.SIGNAL_LEASE_MS + 60_000)
      }

      const signal = engine.listSignals().find(s => s.id === id)!
      expect(signal.status).toBe('failed')
      expect(signal.attempts).toBe(WorkflowEngine.SIGNAL_MAX_ATTEMPTS)
    })

    it('expires an unconsumed signal after its TTL instead of firing it late', async () => {
      // No handler registered for this kind — it waits, then expires.
      const { id } = engine.enqueueSignal({ kind: 'orphan', ttlMs: 60_000 })

      const t0 = dueAt(0)
      engine.dispatchTick(t0)
      expect(engine.listSignals().find(s => s.id === id)?.status).toBe('pending')

      engine.dispatchTick(new Date(t0.getTime() + 2 * 60_000))
      expect(engine.listSignals().find(s => s.id === id)?.status).toBe('expired')
    })
  })

  describe('tick tasks', () => {
    it('runs a registered task at its interval, non-overlapping, and survives task errors', async () => {
      const runs: number[] = []
      engine.registerTickTask('probe', 5 * 60_000, () => { runs.push(1) })
      engine.registerTickTask('broken', 5 * 60_000, () => { throw new Error('task boom') })

      const t0 = dueAt(0)
      engine.dispatchTick(t0)
      await settle()
      expect(runs).toHaveLength(1)

      // One minute later: not due yet.
      engine.dispatchTick(new Date(t0.getTime() + 60_000))
      await settle()
      expect(runs).toHaveLength(1)

      // Past the interval: due again — and the broken task didn't kill the loop.
      engine.dispatchTick(new Date(t0.getTime() + 6 * 60_000))
      await settle()
      expect(runs).toHaveLength(2)
    })

    it('unregisterTickTask stops further runs', async () => {
      const runs: number[] = []
      engine.registerTickTask('temp', 60_000, () => { runs.push(1) })

      const t0 = dueAt(0)
      engine.dispatchTick(t0)
      await settle()
      expect(runs).toHaveLength(1)

      engine.unregisterTickTask('temp')
      engine.dispatchTick(new Date(t0.getTime() + 5 * 60_000))
      await settle()
      expect(runs).toHaveLength(1)
    })
  })

  it('writes a heartbeat on every tick', () => {
    const t1 = dueAt(0)
    engine.dispatchTick(t1)
    expect(engine.getEngineHealth()).toEqual({ lastTickAt: t1.toISOString(), tickCount: 1 })

    const t2 = new Date(t1.getTime() + 60_000)
    engine.dispatchTick(t2)
    expect(engine.getEngineHealth()).toEqual({ lastTickAt: t2.toISOString(), tickCount: 2 })
  })

  it('records manual triggers in the ledger and advances the sha anchor on success', async () => {
    const run = await engine.triggerSchedule('sched-1')
    await settle()

    expect(engine.getRun(run.id)?.status).toBe('succeeded')
    expect(engine.getSchedule('sched-1')?.lastReviewedSha).toBe('sha1')
    const entry = engine.listTriggerLedger({ scheduleId: 'sched-1' })[0]
    expect(entry.decision).toBe('fired')
    expect(entry.reason).toBe('manual trigger (gates bypassed)')
    expect(entry.runId).toBe(run.id)
  })

  it('keeps the stored catch-up policy when a later upsert omits it', () => {
    engine.upsertSchedule({
      id: 'sched-1', kind: 'test-wf', cronExpression: CRON_EVERY_MINUTE,
      input: { repoPath: REPO }, enabled: true, catchUp: 'skip',
    })
    // Config re-sync (no catchUp field) must not reset the policy.
    engine.upsertSchedule({
      id: 'sched-1', kind: 'test-wf', cronExpression: CRON_EVERY_MINUTE,
      input: { repoPath: REPO }, enabled: true,
    })
    expect(engine.getSchedule('sched-1')?.catchUp).toBe('skip')
  })
})
