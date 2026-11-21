import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { ExecutionStore, type Job } from './execution-store.js'
import { ExecutionService, ExecutionInputError } from './execution-service.js'
import type { HarnessRunner, ProbeResult, RunOutcome, RunSpec, RateLimitSnapshot } from './execution-codex-runner.js'

/** A runner whose outcomes the test scripts; `hold` keeps a run going until released or aborted. */
class FakeRunner implements HarnessRunner {
  readonly harness = 'codex'
  outcomes: (RunOutcome | 'hold')[] = []
  calls: RunSpec[] = []
  usedPercent: number | null = 10
  private releases: (() => void)[] = []

  async run(spec: RunSpec, signal: AbortSignal, hooks: { onRateLimits?: (rl: RateLimitSnapshot) => void } = {}): Promise<RunOutcome> {
    this.calls.push(spec)
    hooks.onRateLimits?.(this.rl())
    const next = this.outcomes.shift() ?? { ok: true, text: '{"ok":true}', model: 'm', usage: null, billingMode: 'subscription' }
    if (next !== 'hold') return next
    return new Promise((resolve) => {
      const done = () => resolve({ ok: false, canceled: true, error: { code: 'EXECUTION_INTERRUPTED', message: 'Canceled', retryable: false, retryAfter: null } })
      signal.addEventListener('abort', done, { once: true })
      this.releases.push(() => resolve({ ok: true, text: '{"ok":true}', model: 'm', usage: null, billingMode: 'subscription' }))
    })
  }

  release(): void { this.releases.shift()?.() }

  rl(): RateLimitSnapshot {
    return { usedPercent: this.usedPercent, windowDurationMins: 10080, resetsAt: null, planType: 'plus', hasCredits: false, limitReached: null, at: new Date().toISOString() }
  }

  async readRateLimits(): Promise<RateLimitSnapshot> { return this.rl() }

  async probe(): Promise<ProbeResult> {
    return { available: true, version: '1', account: { type: 'chatgpt', planType: 'plus' }, billingMode: 'subscription', models: [{ id: 'm', isDefault: true }], inferenceProfile: true, rateLimits: this.rl(), error: null, probedAt: new Date().toISOString() }
  }
}

const schema = { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } }

function body(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userRef: 'u1', workload: 'inbox.screen', harness: 'codex', instructions: 'Classify', input: 'mail',
    output: { type: 'json', schemaName: 'probe', schema },
    priority: 'background', deadlineAt: new Date(Date.now() + 60_000).toISOString(), billingPolicy: 'subscription-only',
    ...over,
  }
}

let store: ExecutionStore
let runner: FakeRunner
let service: ExecutionService

async function until(fn: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

function submit(key: string, over: Record<string, unknown> = {}): Job {
  return service.submit({ clientId: 'app', allowedHarnesses: ['codex'], idempotencyKey: key, body: body(over) }).job
}

const status = (id: string) => store.get(id)!.status

beforeEach(() => {
  store = new ExecutionStore(':memory:')
  runner = new FakeRunner()
  service = new ExecutionService(store, { codex: runner }, { concurrency: 1 })
  service.start()
})

afterEach(async () => {
  await service.stop()
  store.close()
})

describe('submission', () => {
  it('runs a JSON job to a validated result', async () => {
    const job = submit('k1')
    const done = await service.waitFor(job.id, 3000)
    expect(done).toMatchObject({ status: 'succeeded', output: { ok: true }, attempts: 1, billingMode: 'subscription' })
  })

  it('deduplicates by key and rejects a different payload under the same key', async () => {
    const a = service.submit({ clientId: 'app', allowedHarnesses: ['codex'], idempotencyKey: 'k', body: body() })
    // A retry computes a new deadline; it is still the same logical request.
    const b = service.submit({ clientId: 'app', allowedHarnesses: ['codex'], idempotencyKey: 'k', body: body({ deadlineAt: new Date(Date.now() + 90_000).toISOString() }) })
    expect(a.created).toBe(true)
    expect(b).toMatchObject({ created: false, job: { id: a.job.id } })
    expect(() => submit('k', { input: 'other mail' })).toThrow(/different request/)
    await service.waitFor(a.job.id, 3000)
    expect(runner.calls).toHaveLength(1)
  })

  it('scopes keys per client and user', () => {
    const a = submit('same')
    const b = submit('same', { userRef: 'u2' })
    const c = service.submit({ clientId: 'other', allowedHarnesses: ['codex'], idempotencyKey: 'same', body: body() }).job
    expect(new Set([a.id, b.id, c.id]).size).toBe(3)
    expect(service.getFor('other', null, a.id)).toBeNull()
    expect(service.getFor('app', 'u2', a.id)).toBeNull()
    expect(service.getFor('app', 'u1', a.id)?.id).toBe(a.id)
  })

  it.each([
    [{ harness: 'claude' }, /not allowed/],
    [{ billingPolicy: 'any' }, /subscription-only/],
    [{ profile: 'chat' }, /inference/],
    [{ deadlineAt: new Date(Date.now() - 1000).toISOString() }, /past/],
    [{ deadlineAt: new Date(Date.now() + 2 * 3600_000).toISOString() }, /minutes ahead/],
    [{ output: { type: 'json', schemaName: 's', schema: { type: 'object', properties: {} } } }, /additionalProperties/],
    [{ output: { type: 'json', schemaName: 's', schema: { type: 'string' } } }, /top level/],
    [{ input: 'x'.repeat(300 * 1024) }, /exceed/],
  ])('refuses invalid requests %#', (over, message) => {
    expect(() => submit('bad', over)).toThrow(message)
  })

  it('refuses new jobs when the queue is full, but still returns accepted ones', async () => {
    await service.stop()
    service = new ExecutionService(store, { codex: runner }, { maxQueued: 2 })
    // Not started: jobs stay queued.
    const first = submit('a')
    submit('b')
    expect(() => submit('c')).toThrow(ExecutionInputError)
    expect(submit('a').id).toBe(first.id)
  })
})

describe('outcomes', () => {
  it('retries invalid output once, then fails with INVALID_OUTPUT', async () => {
    const bad: RunOutcome = { ok: true, text: '{"ok":"yes"}', model: 'm', usage: null, billingMode: 'subscription' }
    runner.outcomes = [bad, bad]
    const job = submit('k')
    const done = await service.waitFor(job.id, 3000)
    expect(done).toMatchObject({ status: 'failed', attempts: 2, error: { code: 'INVALID_OUTPUT' }, output: null })
  })

  it('recovers when the second attempt is valid', async () => {
    runner.outcomes = [{ ok: true, text: 'not json', model: 'm', usage: null, billingMode: 'subscription' }]
    const done = await service.waitFor(submit('k').id, 3000)
    expect(done).toMatchObject({ status: 'succeeded', attempts: 2 })
  })

  it('fails empty text output', async () => {
    runner.outcomes = [
      { ok: true, text: '   ', model: 'm', usage: null, billingMode: 'subscription' },
      { ok: true, text: '', model: 'm', usage: null, billingMode: 'subscription' },
    ]
    const done = await service.waitFor(submit('k', { output: { type: 'text' } }).id, 3000)
    expect(done).toMatchObject({ status: 'failed', error: { code: 'INVALID_OUTPUT', message: 'Empty output' } })
  })

  it('does not retry non-retryable errors', async () => {
    runner.outcomes = [{ ok: false, error: { code: 'UNSUPPORTED_CAPABILITY', message: 'guard', retryable: false, retryAfter: null } }]
    const done = await service.waitFor(submit('k').id, 3000)
    expect(done).toMatchObject({ status: 'failed', attempts: 1, error: { code: 'UNSUPPORTED_CAPABILITY' } })
  })

  it('pauses the harness on quota exhaustion until the reported reset', async () => {
    const resetsAt = new Date(Date.now() + 3600_000).toISOString()
    runner.outcomes = [{ ok: false, error: { code: 'QUOTA_EXHAUSTED', message: 'limit', retryable: true, retryAfter: resetsAt } }]
    const first = await service.waitFor(submit('k1').id, 3000)
    expect(first).toMatchObject({ status: 'failed', error: { code: 'QUOTA_EXHAUSTED', retryAfter: resetsAt } })
    const second = submit('k2')
    await until(() => store.get(second.id)!.waitReason === 'quota')
    expect(status(second.id)).toBe('queued')
    expect(runner.calls).toHaveLength(1)
  })

  it('expires queued jobs whose deadline passes', async () => {
    runner.outcomes = ['hold']
    const blocker = submit('a')
    await until(() => status(blocker.id) === 'running')
    const late = submit('b', { deadlineAt: new Date(Date.now() + 300).toISOString() })
    const done = await service.waitFor(late.id, 3000)
    expect(done).toMatchObject({ status: 'expired', error: { code: 'DEADLINE_EXCEEDED' } })
    runner.release()
  })
})

describe('scheduling', () => {
  it('runs interactive jobs before older background jobs', async () => {
    runner.outcomes = ['hold']
    const blocker = submit('a')
    await until(() => status(blocker.id) === 'running')
    const bg = submit('bg')
    const fg = submit('fg', { priority: 'interactive', input: 'urgent' })
    await until(() => store.get(bg.id)!.waitReason === 'capacity')
    runner.release()
    await service.waitFor(bg.id, 3000)
    expect(runner.calls.map(c => c.input)).toEqual(['mail', 'urgent', 'mail'])
    expect(store.get(fg.id)!.status).toBe('succeeded')
  })

  it('holds background jobs over the budget while interactive ones run', async () => {
    runner.usedPercent = 85
    await service.probe('codex', true) // learn the usage window
    const bg = submit('bg')
    const fg = submit('fg', { priority: 'interactive' })
    await service.waitFor(fg.id, 3000)
    expect(status(fg.id)).toBe('succeeded')
    await until(() => store.get(bg.id)!.waitReason === 'budget')
    expect(status(bg.id)).toBe('queued')
  })
})

describe('cancellation', () => {
  it('cancels a queued job at once', async () => {
    runner.outcomes = ['hold']
    const blocker = submit('a')
    await until(() => status(blocker.id) === 'running')
    const queued = submit('b')
    expect(service.cancel(queued.id)?.status).toBe('canceled')
    runner.release()
  })

  it('cancels a running job only after its process stopped, and never applies output', async () => {
    runner.outcomes = ['hold']
    const job = submit('a')
    await until(() => status(job.id) === 'running')
    const after = service.cancel(job.id)
    // The fake run resolves on abort; the store moves to canceled once it has.
    expect(after?.cancelRequestedAt).not.toBeNull()
    const done = await service.waitFor(job.id, 3000)
    expect(done).toMatchObject({ status: 'canceled', output: null })
    expect(service.cancel(job.id)?.status).toBe('canceled') // idempotent
  })

  it('lets a result committed first win over a later cancel', async () => {
    const job = submit('a')
    await service.waitFor(job.id, 3000)
    expect(service.cancel(job.id)?.status).toBe('succeeded')
  })
})

describe('restart recovery and retention', () => {
  it('requeues interrupted jobs with attempts left and fails the rest', async () => {
    await service.stop()
    const fresh = new ExecutionService(store, { codex: runner })
    const a = fresh.submit({ clientId: 'app', allowedHarnesses: ['codex'], idempotencyKey: 'a', body: body() }).job
    const b = fresh.submit({ clientId: 'app', allowedHarnesses: ['codex'], idempotencyKey: 'b', body: body() }).job
    store.markRunning(a.id)
    store.markRunning(b.id)
    store.requeue(b.id, null)
    store.markRunning(b.id) // b used both attempts
    service = new ExecutionService(store, { codex: runner })
    const r = service.start()
    expect(r).toEqual({ requeued: 1, failed: 1 })
    expect(store.get(b.id)).toMatchObject({ status: 'failed', error: { code: 'EXECUTION_INTERRUPTED' } })
    expect((await service.waitFor(a.id, 3000))?.status).toBe('succeeded')
  })

  it('clears payloads after the retention period but keeps the dedup record', async () => {
    const job = submit('k')
    await service.waitFor(job.id, 3000)
    const later = new Date(Date.now() + 8 * 24 * 3600_000)
    // 8 days on: past both payload retention and the 7-day dedup window → row gone.
    expect(service.sweep(later)).toEqual({ payloadsCleared: 1, rowsDeleted: 1 })

    const job2 = submit('k2')
    await service.waitFor(job2.id, 3000)
    await service.stop()
    service = new ExecutionService(store, { codex: runner }, { retentionDays: 1 })
    expect(service.sweep(new Date(Date.now() + 2 * 24 * 3600_000))).toEqual({ payloadsCleared: 1, rowsDeleted: 0 })
    expect(store.get(job2.id)).toMatchObject({ payloadExpired: true, output: null, status: 'succeeded' })
    // The key still deduplicates.
    expect(service.submit({ clientId: 'app', allowedHarnesses: ['codex'], idempotencyKey: 'k2', body: body() }).job.id).toBe(job2.id)
  })
})

describe('capabilities', () => {
  it('advertises the probed profile, billing mode and capacity', async () => {
    const caps = await service.capabilities(['codex'])
    expect(caps).toMatchObject({
      protocolVersion: 1,
      harnesses: { codex: { available: true, billingMode: 'subscription', profiles: ['inference'], outputTypes: ['json', 'text'] } },
      capacity: { concurrency: 1 },
    })
    expect(JSON.stringify(caps)).not.toMatch(/@/)
  })
})
