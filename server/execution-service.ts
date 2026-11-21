/**
 * Execution jobs: validation, queueing, dispatch and lifecycle
 * (docs/EXECUTION-API.md).
 *
 * Jobs are durable rows in ExecutionStore; this service owns everything that
 * moves them: a priority queue (interactive before background) with bounded
 * concurrency, deadlines, at most `maxAttempts` attempts for retryable
 * failures, cancellation that waits for the harness process to exit,
 * a background budget against the subscription's usage window, restart
 * recovery and the retention sweep.
 */

import { EventEmitter } from 'events'
import { checkSchemaSubset, validateAgainstSchema, canonicalJson, sha256Hex } from './execution-schema.js'
import { ExecutionStore, TERMINAL_STATUSES, type Job, type JobError, type JobRequest } from './execution-store.js'
import type { HarnessRunner, ProbeResult, RateLimitSnapshot } from './execution-codex-runner.js'

export interface ExecutionLimits {
  concurrency: number
  maxQueued: number
  maxAttempts: number
  /** Background jobs wait while the usage window is at or above this percent. */
  backgroundBudgetPercent: number
  retentionDays: number
  maxDeadlineMs: number
  maxPromptBytes: number
  maxSchemaBytes: number
  maxOutputBytes: number
}

export const DEFAULT_LIMITS: ExecutionLimits = {
  concurrency: 1,
  maxQueued: 100,
  maxAttempts: 2,
  backgroundBudgetPercent: 80,
  retentionDays: 7,
  maxDeadlineMs: 60 * 60 * 1000,
  maxPromptBytes: 256 * 1024,
  maxSchemaBytes: 32 * 1024,
  maxOutputBytes: 256 * 1024,
}

/** Tombstones (dedup records) are kept at least this long, whatever the payload retention. */
const DEDUP_WINDOW_MS = 7 * 24 * 60 * 60 * 1000
const PROBE_TTL_MS = 10 * 60 * 1000
const RATE_REFRESH_MS = 5 * 60 * 1000

export class ExecutionInputError extends Error {
  constructor(readonly code: 'INVALID_REQUEST' | 'UNSUPPORTED_CAPABILITY' | 'IDEMPOTENCY_CONFLICT' | 'QUEUE_FULL', message: string) {
    super(message)
  }
}

export interface SubmitInput {
  clientId: string
  allowedHarnesses: string[]
  /** Per-client cap on queued + running jobs. */
  clientMaxQueued?: number
  idempotencyKey: string
  body: unknown
}

export interface Capabilities {
  protocolVersion: 1
  harnesses: Record<string, {
    available: boolean
    version: string | null
    account: { type: string; planType: string | null } | null
    billingMode: string
    models: { id: string; isDefault: boolean }[]
    profiles: string[]
    outputTypes: string[]
    error: string | null
    probedAt: string | null
  }>
  schemaSubset: string[]
  capacity: { concurrency: number; queued: number; running: number; maxQueued: number }
  rateLimits: Record<string, RateLimitSnapshot | null>
  limits: { maxDeadlineMs: number; maxPromptBytes: number; maxSchemaBytes: number; maxOutputBytes: number }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

export class ExecutionService extends EventEmitter {
  readonly limits: ExecutionLimits
  private running = new Map<string, AbortController>()
  private inflight = new Set<Promise<void>>()
  private probes = new Map<string, ProbeResult>()
  private probing = new Map<string, Promise<ProbeResult>>()
  private rateLimits = new Map<string, RateLimitSnapshot>()
  /** Harness paused until this epoch ms after a quota error. */
  private pausedUntil = new Map<string, number>()
  private rateRefreshedAt = new Map<string, number>()
  private pumpTimer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private stopped = false

  constructor(
    private store: ExecutionStore,
    private runners: Partial<Record<string, HarnessRunner>>,
    limits: Partial<ExecutionLimits> = {},
  ) {
    super()
    this.setMaxListeners(0)
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Recover jobs interrupted by a restart, start the sweep, and dispatch. */
  start(): { requeued: number; failed: number } {
    let requeued = 0
    let failed = 0
    for (const job of this.store.listByStatus('running')) {
      const error: JobError = { code: 'EXECUTION_INTERRUPTED', message: 'Codekin restarted while the job was running', retryable: true, retryAfter: null }
      if (job.cancelRequestedAt) {
        this.store.finish(job.id, 'canceled', { error: null })
      } else if (job.attempts < this.limits.maxAttempts && Date.parse(job.deadlineAt) > Date.now()) {
        this.store.requeue(job.id, error)
        requeued++
      } else {
        this.store.finish(job.id, 'failed', { error })
        failed++
      }
    }
    this.sweep()
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 60 * 1000)
    this.sweepTimer.unref()
    this.schedulePump(0)
    return { requeued, failed }
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    if (this.sweepTimer) clearInterval(this.sweepTimer)
    // Running jobs stay 'running' in the store; start() recovers them on boot.
    for (const ac of this.running.values()) ac.abort()
    await Promise.race([
      Promise.allSettled([...this.inflight]),
      new Promise((resolve) => { setTimeout(resolve, 5000).unref() }),
    ])
  }

  sweep(now = new Date()): { payloadsCleared: number; rowsDeleted: number } {
    const payloadCutoff = new Date(now.getTime() - this.limits.retentionDays * 24 * 60 * 60 * 1000)
    const rowCutoff = new Date(now.getTime() - Math.max(DEDUP_WINDOW_MS, this.limits.retentionDays * 24 * 60 * 60 * 1000))
    return this.store.sweep(payloadCutoff, rowCutoff)
  }

  // -------------------------------------------------------------------------
  // Validation and submission
  // -------------------------------------------------------------------------

  /** Validate and normalize a request body; throws ExecutionInputError. */
  parseRequest(body: unknown, allowedHarnesses: string[]): JobRequest {
    if (!isObj(body)) throw new ExecutionInputError('INVALID_REQUEST', 'Body must be a JSON object')
    const reqStr = (k: string, max = 200): string => {
      const v = body[k]
      if (typeof v !== 'string' || v.trim() === '') throw new ExecutionInputError('INVALID_REQUEST', `"${k}" is required`)
      if (v.length > max) throw new ExecutionInputError('INVALID_REQUEST', `"${k}" is too long`)
      return v
    }
    const optStr = (k: string, max = 200): string | null => {
      const v = body[k]
      if (v === undefined || v === null) return null
      if (typeof v !== 'string' || v.length > max) throw new ExecutionInputError('INVALID_REQUEST', `"${k}" must be a string`)
      return v
    }
    const userRef = reqStr('userRef')
    const workload = reqStr('workload')
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(workload)) throw new ExecutionInputError('INVALID_REQUEST', '"workload" must be a dotted identifier')
    const harness = reqStr('harness')
    if (!allowedHarnesses.includes(harness)) throw new ExecutionInputError('UNSUPPORTED_CAPABILITY', `Harness "${harness}" is not allowed for this client`)
    if (!this.runners[harness]) throw new ExecutionInputError('UNSUPPORTED_CAPABILITY', `Harness "${harness}" is not available`)
    if (body.profile !== undefined && body.profile !== 'inference') throw new ExecutionInputError('UNSUPPORTED_CAPABILITY', 'Only the "inference" profile is supported')
    if (body.billingPolicy !== 'subscription-only') throw new ExecutionInputError('UNSUPPORTED_CAPABILITY', '"billingPolicy" must be "subscription-only"')
    const instructions = typeof body.instructions === 'string' ? body.instructions : ''
    const input = typeof body.input === 'string' ? body.input : ''
    if (!instructions.trim() || !input.trim()) throw new ExecutionInputError('INVALID_REQUEST', '"instructions" and "input" are required strings')
    if (Buffer.byteLength(instructions) + Buffer.byteLength(input) > this.limits.maxPromptBytes) {
      throw new ExecutionInputError('INVALID_REQUEST', `instructions + input exceed ${this.limits.maxPromptBytes} bytes`)
    }
    const priority = body.priority ?? 'background'
    if (priority !== 'interactive' && priority !== 'background') throw new ExecutionInputError('INVALID_REQUEST', '"priority" must be "interactive" or "background"')
    const deadlineMs = typeof body.deadlineAt === 'string' ? Date.parse(body.deadlineAt) : NaN
    if (!Number.isFinite(deadlineMs)) throw new ExecutionInputError('INVALID_REQUEST', '"deadlineAt" must be an ISO time')
    if (deadlineMs <= Date.now()) throw new ExecutionInputError('INVALID_REQUEST', '"deadlineAt" is in the past')
    if (deadlineMs - Date.now() > this.limits.maxDeadlineMs) throw new ExecutionInputError('INVALID_REQUEST', `"deadlineAt" is more than ${this.limits.maxDeadlineMs / 60000} minutes ahead`)

    const out = body.output
    let output: JobRequest['output']
    if (!isObj(out) || (out.type !== 'json' && out.type !== 'text')) throw new ExecutionInputError('INVALID_REQUEST', '"output.type" must be "json" or "text"')
    if (out.type === 'json') {
      const schemaName = typeof out.schemaName === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(out.schemaName) ? out.schemaName : null
      if (!schemaName) throw new ExecutionInputError('INVALID_REQUEST', '"output.schemaName" must match [A-Za-z0-9_-]{1,64}')
      if (!isObj(out.schema)) throw new ExecutionInputError('INVALID_REQUEST', '"output.schema" must be an object')
      if (Buffer.byteLength(JSON.stringify(out.schema)) > this.limits.maxSchemaBytes) throw new ExecutionInputError('INVALID_REQUEST', `Schema exceeds ${this.limits.maxSchemaBytes} bytes`)
      const problem = checkSchemaSubset(out.schema)
      if (problem) throw new ExecutionInputError('UNSUPPORTED_CAPABILITY', `Unsupported schema: ${problem}`)
      if (!(out.schema.type === 'object' || (Array.isArray(out.schema.type) && out.schema.type.includes('object')))) {
        throw new ExecutionInputError('UNSUPPORTED_CAPABILITY', 'Unsupported schema: the top level must be an object')
      }
      output = { type: 'json', schemaName, schema: out.schema }
    } else {
      output = { type: 'text' }
    }
    return {
      userRef, workload, harness,
      model: optStr('model'),
      effort: optStr('effort', 20),
      instructions, input, output, priority,
      deadlineAt: new Date(deadlineMs).toISOString(),
      billingPolicy: 'subscription-only',
    }
  }

  submit(input: SubmitInput): { job: Job; created: boolean } {
    if (!input.idempotencyKey || input.idempotencyKey.length > 200) {
      throw new ExecutionInputError('INVALID_REQUEST', 'Idempotency-Key header is required (at most 200 characters)')
    }
    const req = this.parseRequest(input.body, input.allowedHarnesses)
    // The hash ignores deadlineAt: a retry computes a fresh deadline for the same logical request.
    const hash = sha256Hex(canonicalJson({ ...req, deadlineAt: undefined }))
    const existing = this.store.findByKey(input.clientId, req.userRef, input.idempotencyKey)
    if (!existing) {
      // Capacity applies to new jobs only, so retries of accepted jobs never bounce.
      const counts = this.store.countByStatus()
      const clientCap = Math.min(input.clientMaxQueued ?? this.limits.maxQueued, this.limits.maxQueued)
      if (counts.queued + counts.running >= this.limits.maxQueued || this.store.countQueuedForClient(input.clientId) >= clientCap) {
        throw new ExecutionInputError('QUEUE_FULL', 'Queue is full; retry later')
      }
    }
    const res = this.store.create(input.clientId, input.idempotencyKey, hash, req)
    if (res.kind === 'conflict') throw new ExecutionInputError('IDEMPOTENCY_CONFLICT', 'This Idempotency-Key was used for a different request')
    if (res.kind === 'existing') return { job: res.job, created: false }
    this.schedulePump(0)
    return { job: res.job, created: true }
  }

  /** A job visible to this client and user, else null (never reveals others' jobs). */
  getFor(clientId: string, userRef: string | null, id: string): Job | null {
    const job = this.store.get(id)
    if (!job || job.clientId !== clientId) return null
    if (userRef !== null && job.userRef !== userRef) return null
    return job
  }

  /** Resolve when the job is terminal or `waitMs` elapses; returns the latest state. */
  async waitFor(id: string, waitMs: number, signal?: AbortSignal): Promise<Job | null> {
    const current = this.store.get(id)
    if (!current || TERMINAL_STATUSES.has(current.status) || waitMs <= 0 || signal?.aborted) return current
    await new Promise<void>((resolve) => {
      const onTerminal = (doneId: string) => { if (doneId === id) done() }
      const timer = setTimeout(() => { done() }, waitMs)
      const done = () => {
        clearTimeout(timer)
        this.off('terminal', onTerminal)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      this.on('terminal', onTerminal)
      signal?.addEventListener('abort', done, { once: true })
    })
    return this.store.get(id)
  }

  /** Request cancellation. Queued jobs end at once; running ones after their process exits. */
  cancel(id: string): Job | null {
    const job = this.store.get(id)
    if (!job) return null
    if (TERMINAL_STATUSES.has(job.status)) return job
    this.store.markCancelRequested(id)
    if (job.status === 'queued') {
      if (this.store.finish(id, 'canceled')) this.emit('terminal', id)
    } else {
      this.running.get(id)?.abort()
    }
    return this.store.get(id)
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async probe(harness: string, force = false): Promise<ProbeResult | null> {
    const runner = this.runners[harness]
    if (!runner) return null
    const cached = this.probes.get(harness)
    if (!force && cached && Date.now() - Date.parse(cached.probedAt) < PROBE_TTL_MS) return cached
    const inFlight = this.probing.get(harness)
    if (inFlight) return inFlight
    const p = runner.probe().then((r) => {
      this.probes.set(harness, r)
      if (r.rateLimits) this.rateLimits.set(harness, r.rateLimits)
      return r
    }).finally(() => this.probing.delete(harness))
    this.probing.set(harness, p)
    return p
  }

  async capabilities(allowedHarnesses: string[]): Promise<Capabilities> {
    const harnesses: Capabilities['harnesses'] = {}
    const rateLimits: Capabilities['rateLimits'] = {}
    for (const h of allowedHarnesses) {
      if (!this.runners[h]) continue
      const p = await this.probe(h)
      harnesses[h] = {
        available: !!p?.available,
        version: p?.version ?? null,
        account: p?.account ?? null,
        billingMode: p?.billingMode ?? 'unknown',
        models: p?.models ?? [],
        profiles: p?.inferenceProfile ? ['inference'] : [],
        outputTypes: p?.inferenceProfile ? ['json', 'text'] : [],
        error: p?.error ?? null,
        probedAt: p?.probedAt ?? null,
      }
      rateLimits[h] = this.rateLimits.get(h) ?? null
    }
    const counts = this.store.countByStatus()
    return {
      protocolVersion: 1,
      harnesses,
      schemaSubset: ['type', 'properties', 'required', 'additionalProperties:false', 'items', 'enum', 'anyOf', 'minimum', 'maximum', 'description', 'title'],
      capacity: { concurrency: this.limits.concurrency, queued: counts.queued, running: counts.running, maxQueued: this.limits.maxQueued },
      rateLimits,
      limits: {
        maxDeadlineMs: this.limits.maxDeadlineMs,
        maxPromptBytes: this.limits.maxPromptBytes,
        maxSchemaBytes: this.limits.maxSchemaBytes,
        maxOutputBytes: this.limits.maxOutputBytes,
      },
    }
  }

  /** Re-read a harness's usage window (at most every RATE_REFRESH_MS), then re-pump. */
  private refreshRateLimits(harness: string): void {
    const runner = this.runners[harness]
    const last = this.rateRefreshedAt.get(harness) ?? 0
    if (!runner?.readRateLimits || Date.now() - last < RATE_REFRESH_MS) return
    this.rateRefreshedAt.set(harness, Date.now())
    void runner.readRateLimits().then((rl) => {
      if (rl) this.rateLimits.set(harness, rl)
      this.schedulePump(0)
    }).catch(() => { /* keep the last snapshot */ })
  }

  // -------------------------------------------------------------------------
  // Dispatch
  // -------------------------------------------------------------------------

  private schedulePump(delayMs: number): void {
    if (this.stopped) return
    if (this.pumpTimer) clearTimeout(this.pumpTimer)
    this.pumpTimer = setTimeout(() => { this.pumpTimer = null; this.pump() }, delayMs)
    this.pumpTimer.unref()
  }

  /** Start queued jobs while capacity allows; expire overdue ones; note why the rest wait. */
  pump(): void {
    if (this.stopped) return
    const now = Date.now()
    let nextWake = Infinity
    for (const job of this.store.listQueued()) {
      const deadline = Date.parse(job.deadlineAt)
      if (deadline <= now) {
        if (this.store.finish(job.id, 'expired', { error: { code: 'DEADLINE_EXCEEDED', message: 'The deadline passed before the job could run', retryable: false, retryAfter: null } })) {
          this.emit('terminal', job.id)
        }
        continue
      }
      nextWake = Math.min(nextWake, deadline)
      const paused = this.pausedUntil.get(job.harness) ?? 0
      if (paused > now) {
        this.store.setWaitReason(job.id, 'quota')
        nextWake = Math.min(nextWake, paused)
        continue
      }
      const used = this.rateLimits.get(job.harness)?.usedPercent
      if (job.priority === 'background' && typeof used === 'number' && used >= this.limits.backgroundBudgetPercent) {
        this.store.setWaitReason(job.id, 'budget')
        // Usage only updates while jobs run; refresh it now and then so held jobs resume.
        nextWake = Math.min(nextWake, now + RATE_REFRESH_MS)
        this.refreshRateLimits(job.harness)
        continue
      }
      if (this.running.size >= this.limits.concurrency) {
        this.store.setWaitReason(job.id, 'capacity')
        continue
      }
      if (!this.store.markRunning(job.id)) continue
      const p = this.execute(job.id).catch((e: unknown) => { console.error(`[execution] job ${job.id} crashed:`, e) })
      this.inflight.add(p)
      void p.finally(() => this.inflight.delete(p))
    }
    if (Number.isFinite(nextWake)) this.schedulePump(Math.max(50, Math.min(nextWake - now + 10, 5 * 60 * 1000)))
  }

  private async execute(id: string): Promise<void> {
    const job = this.store.get(id)
    const req = this.store.getRequest(id)
    const runner = job ? this.runners[job.harness] : undefined
    if (!job || !req || !runner) {
      if (this.store.finish(id, 'failed', { error: { code: 'RUNTIME_UNAVAILABLE', message: 'Job payload or harness missing', retryable: false, retryAfter: null } })) this.emit('terminal', id)
      return
    }
    const ac = new AbortController()
    this.running.set(id, ac)
    try {
      const outcome = await runner.run({
        instructions: req.instructions,
        input: req.input,
        output: req.output,
        model: req.model,
        effort: req.effort,
        deadlineAt: Date.parse(req.deadlineAt),
      }, ac.signal, {
        onRateLimits: (rl) => this.rateLimits.set(job.harness, rl),
      })
      if (this.stopped) return // left 'running' (or cancel-requested) for restart recovery

      if (outcome.ok) {
        const checked = this.checkOutput(req, outcome.text)
        if (checked.ok) {
          if (this.store.finish(id, 'succeeded', { output: checked.value, raw: outcome.text, usage: outcome.usage, model: outcome.model, billingMode: outcome.billingMode })) {
            this.emit('terminal', id)
          }
          return
        }
        this.afterFailure(id, { code: 'INVALID_OUTPUT', message: checked.message, retryable: true, retryAfter: null }, outcome.billingMode, outcome.text)
        return
      }
      if (outcome.canceled || this.store.get(id)?.cancelRequestedAt) {
        if (this.store.finish(id, 'canceled', { billingMode: outcome.billingMode ?? null })) this.emit('terminal', id)
        return
      }
      if (outcome.error.code === 'QUOTA_EXHAUSTED') {
        const until = outcome.error.retryAfter ? Date.parse(outcome.error.retryAfter) : Date.now() + 15 * 60 * 1000
        this.pausedUntil.set(job.harness, until)
      }
      this.afterFailure(id, outcome.error, outcome.billingMode ?? null, null)
    } catch (e) {
      if (!this.stopped) this.afterFailure(id, { code: 'EXECUTION_INTERRUPTED', message: (e as Error).message, retryable: true, retryAfter: null }, null, null)
    } finally {
      this.running.delete(id)
      this.schedulePump(0)
    }
  }

  private afterFailure(id: string, error: JobError, billingMode: string | null, raw: string | null): void {
    const job = this.store.get(id)
    if (!job) return
    const deadlineLeft = Date.parse(job.deadlineAt) - Date.now()
    const retry = error.retryable
      && error.code !== 'QUOTA_EXHAUSTED'
      && job.attempts < this.limits.maxAttempts
      && deadlineLeft > 1000
    if (retry) {
      this.store.requeue(id, error)
      return
    }
    const status = error.code === 'DEADLINE_EXCEEDED' ? 'expired' : 'failed'
    if (this.store.finish(id, status, { error, billingMode, raw })) this.emit('terminal', id)
  }

  private checkOutput(req: JobRequest, text: string): { ok: true; value: unknown } | { ok: false; message: string } {
    if (Buffer.byteLength(text) > this.limits.maxOutputBytes) return { ok: false, message: `Output exceeds ${this.limits.maxOutputBytes} bytes` }
    if (req.output.type === 'text') {
      const trimmed = text.trim()
      return trimmed ? { ok: true, value: trimmed } : { ok: false, message: 'Empty output' }
    }
    let value: unknown
    try {
      value = JSON.parse(text)
    } catch {
      return { ok: false, message: 'Output is not valid JSON' }
    }
    const problem = validateAgainstSchema(req.output.schema, value)
    return problem ? { ok: false, message: `Output does not match the schema: ${problem}` } : { ok: true, value }
  }
}
