/**
 * Repo automation configuration service
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §10).
 *
 * A repo automation is one entry in workflow-config.json: a workflow kind run
 * in a repo on a cron schedule or on an event. The Automations UI and Joe's
 * MCP tools both change automations through this service, so the rules are
 * enforced in one place:
 *
 * - Every change bumps the entry's `revision`; a writer passing a stale
 *   `expectedRevision` gets a conflict instead of overwriting newer config.
 * - A change carrying an idempotency key is applied once; a retry returns
 *   the recorded result.
 * - Every change is recorded with actor, reason, before/after and origin.
 * - Derived cron schedules and commit hooks are re-synced after each change,
 *   so configuration and scheduler never drift apart.
 *
 * Reads (list, health, trigger history) never start or wake anything.
 */

import { basename } from 'path'
import { randomUUID } from 'crypto'
import { isValidCron } from './cron.js'
import { VALID_PROVIDERS } from './types.js'
import type { ReviewRepoConfig, WorkflowConfig } from './workflow-config.js'
import type { CronSchedule, EngineHealth, TriggerLedgerEntry, WorkflowRun } from './workflow-engine.js'
import type { EffectiveWorkflow } from './workflow-loader.js'
import type {
  AutomationActor,
  AutomationChange,
  AutomationChangeAction,
  AutomationChangeLog,
} from './automation-changes.js'

/** A change the caller must fix (400), a missing automation (404), or a conflict (409). */
export class AutomationError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'AutomationError'
  }
}

/** The subset of the workflow engine the service reads. */
export interface AutomationEngine {
  getSchedule(id: string): CronSchedule | null
  listRuns(opts?: { kind?: string; status?: WorkflowRun['status']; limit?: number }): WorkflowRun[]
  listTriggerLedger(opts?: { scheduleId?: string; limit?: number }): TriggerLedgerEntry[]
  getEngineHealth(): EngineHealth
  startRun(kind: string, input?: Record<string, unknown>): Promise<WorkflowRun>
  triggerSchedule(id: string): Promise<WorkflowRun>
}

export interface AutomationServiceDeps {
  config: {
    load: () => WorkflowConfig
    add: (repo: ReviewRepoConfig) => void
    update: (id: string, patch: Partial<ReviewRepoConfig>) => void
    remove: (id: string) => void
  }
  /** Null while the engine is not up — mutations still apply, health reports it. */
  engine: () => AutomationEngine | null
  /** Re-derive cron schedules and commit hooks from the config. */
  sync: () => void
  /** Validate a repo path against the repos root; null when outside or missing. */
  resolveRepo: (repoPath: string) => string | null
  /** Effective workflow definitions for a repo (built-ins + repo files). */
  workflows: (repoPath?: string) => EffectiveWorkflow[]
  /** Whether the commit hook that drives event automations is installed. */
  commitHookInstalled?: (repoPath: string) => boolean
  changes?: AutomationChangeLog | null
  now?: () => Date
  /** IANA timezone cron expressions are evaluated in (the server's). */
  timezone?: string
}

/** Who is changing configuration and why — recorded on every change. */
export interface ChangeContext {
  actor: AutomationActor
  reason?: string
  authorization?: string
  originSessionId?: string
  taskId?: string
  /** Required for Joe's mutations; optional for the UI. */
  idempotencyKey?: string
}

export interface CreateAutomationInput {
  repo: string
  kind: string
  /** Five-field cron expression, or 'event' for event-driven kinds. */
  cronExpression: string
  name?: string
  id?: string
  enabled?: boolean
  customPrompt?: string
  model?: string
  provider?: ReviewRepoConfig['provider']
}

export type AutomationPatch = Partial<Pick<ReviewRepoConfig, 'name' | 'kind' | 'cronExpression' | 'enabled' | 'customPrompt' | 'model' | 'provider'>>

export interface RepoAutomation {
  id: string
  name: string
  repo: string
  kind: string
  workflow: { name: string; source: EffectiveWorkflow['source']; hash: string } | null
  trigger: 'schedule' | 'event'
  cronExpression: string
  enabled: boolean
  customPrompt: string | null
  model: string | null
  provider: string | null
  revision: number
  /** 'maintenance' when adopted into the repo's maintenance plan (pauses with it). */
  managedBy: 'user' | 'maintenance'
  schedule: Pick<CronSchedule, 'nextRunAt' | 'lastRunAt' | 'lastHeldAt' | 'lastHeldReason' | 'heldCount' | 'catchUp'> | null
  timezone: string
}

export type AutomationHealthStatus = 'healthy' | 'starting' | 'held' | 'degraded' | 'unavailable' | 'disabled'

export interface AutomationHealth {
  automationId: string
  status: AutomationHealthStatus
  /** Plain-language reasons behind the status, most important first. */
  reasons: string[]
  lastSuccessAt: string | null
  lastFailureAt: string | null
  lastFailureError: string | null
  lastRunId: string | null
  lastRunStatus: string | null
  nextRunAt: string | null
  hold: { at: string; reason: string } | null
  scheduler: { lastTickAt: string | null; stale: boolean } | null
  timezone: string
}

export interface MutationResult {
  automation: RepoAutomation | null
  change: AutomationChange | null
  /** True when an idempotency key matched an already-applied change. */
  replayed: boolean
  /** Runs still going for this automation — disabling or removing never cancels them. */
  activeRuns: { id: string; status: string }[]
  /** Maintenance responsibilities whose coverage this change affects. */
  affectedResponsibilities: string[]
}

/** A schedule more than this far past its fire time has missed it. */
const OVERDUE_GRACE_MS = 15 * 60_000
/** Heartbeat older than three ticks means the dispatch loop is not running. */
const SCHEDULER_STALE_MS = 3 * 60_000
/** Holds that mean coverage is withheld, not that there was nothing to do. */
const COVERAGE_HOLD = /dormant|cooling|missed fire window|maintenance/

export class AutomationService {
  private readonly deps: AutomationServiceDeps
  private readonly timezone: string
  /** Reports which maintenance responsibilities a change affects (set once maintenance exists). */
  private changeObserver: ((automationId: string, action: AutomationChangeAction) => string[]) | null = null

  constructor(deps: AutomationServiceDeps) {
    this.deps = deps
    this.timezone = deps.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  }

  setChangeObserver(observer: ((automationId: string, action: AutomationChangeAction) => string[]) | null): void {
    this.changeObserver = observer
  }

  private affected(automationId: string, action: AutomationChangeAction): string[] {
    if (!this.changeObserver) return []
    try {
      return this.changeObserver(automationId, action)
    } catch (err) {
      console.error('[automations] Change observer failed:', err)
      return []
    }
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date()
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  listWorkflows(repo?: string): EffectiveWorkflow[] {
    if (repo) this.requireRepo(repo)
    return this.deps.workflows(repo)
  }

  getWorkflow(repo: string | undefined, kind: string): EffectiveWorkflow {
    const workflow = this.listWorkflows(repo).find(w => w.kind === kind)
    if (!workflow) throw new AutomationError(`No workflow "${kind}"${repo ? ` is available in ${repo}` : ''}`, 404)
    return workflow
  }

  /** Whether a path is a repo automations may target (under the repos root). */
  isValidRepo(repo: string): boolean {
    return this.deps.resolveRepo(repo) !== null
  }

  list(opts: { repo?: string } = {}): RepoAutomation[] {
    const entries = this.deps.config.load().reviewRepos
      .filter(r => !opts.repo || r.repoPath === opts.repo)
    const workflowsByRepo = new Map<string, EffectiveWorkflow[]>()
    return entries.map(entry => {
      let workflows = workflowsByRepo.get(entry.repoPath)
      if (!workflows) {
        workflows = this.safeWorkflows(entry.repoPath)
        workflowsByRepo.set(entry.repoPath, workflows)
      }
      return this.view(entry, workflows)
    })
  }

  get(id: string): RepoAutomation {
    const entry = this.requireEntry(id)
    return this.view(entry, this.safeWorkflows(entry.repoPath))
  }

  /**
   * Evidence-based health: a missing, stale, held or failing signal is never
   * reported healthy, and no evidence at all is `starting`, not healthy.
   */
  health(id: string): AutomationHealth {
    const entry = this.requireEntry(id)
    const engine = this.deps.engine()
    const now = this.now()
    const reasons: string[] = []
    const base: AutomationHealth = {
      automationId: id,
      status: 'starting',
      reasons,
      lastSuccessAt: null,
      lastFailureAt: null,
      lastFailureError: null,
      lastRunId: null,
      lastRunStatus: null,
      nextRunAt: null,
      hold: null,
      scheduler: null,
      timezone: this.timezone,
    }

    if (!engine) {
      reasons.push('The workflow engine is not running')
      return { ...base, status: 'unavailable' }
    }

    const heartbeat = engine.getEngineHealth()
    const stale = !heartbeat.lastTickAt || now.getTime() - new Date(heartbeat.lastTickAt).getTime() > SCHEDULER_STALE_MS
    base.scheduler = { lastTickAt: heartbeat.lastTickAt, stale }

    const runs = this.runsFor(engine, entry)
    const terminal = runs.filter(r => r.status === 'succeeded' || r.status === 'failed' || r.status === 'skipped')
    const lastSuccess = terminal.find(r => r.status === 'succeeded' || r.status === 'skipped')
    const lastFailure = terminal.find(r => r.status === 'failed')
    base.lastSuccessAt = lastSuccess ? (lastSuccess.completedAt ?? lastSuccess.createdAt) : null
    base.lastFailureAt = lastFailure ? (lastFailure.completedAt ?? lastFailure.createdAt) : null
    base.lastFailureError = lastFailure?.error ?? null
    base.lastRunId = runs[0]?.id ?? null
    base.lastRunStatus = runs[0]?.status ?? null

    if (!entry.enabled) {
      reasons.push('Disabled — no runs are scheduled')
      return { ...base, status: 'disabled' }
    }
    if (stale) {
      reasons.push(heartbeat.lastTickAt
        ? `The scheduler has not ticked since ${heartbeat.lastTickAt}`
        : 'The scheduler has never ticked')
      return { ...base, status: 'unavailable' }
    }

    const latestTerminal = terminal[0]
    const failing = latestTerminal?.status === 'failed'

    if (entry.cronExpression === 'event') {
      if (entry.kind === 'commit-review' && this.deps.commitHookInstalled && !this.deps.commitHookInstalled(entry.repoPath)) {
        reasons.push('The post-commit hook that triggers this review is not installed')
        return { ...base, status: 'unavailable' }
      }
      if (failing) {
        reasons.push(`The last run failed${latestTerminal.error ? `: ${latestTerminal.error}` : ''}`)
        return { ...base, status: 'degraded' }
      }
      if (!lastSuccess) {
        reasons.push('Waiting for the first event — no run has completed yet')
        return { ...base, status: 'starting' }
      }
      reasons.push('Event-driven: runs when the triggering event arrives; a quiet period is not proof of coverage')
      return { ...base, status: 'healthy' }
    }

    const schedule = engine.getSchedule(entry.id)
    if (!schedule) {
      reasons.push('No derived schedule exists for this automation — configuration and scheduler are out of sync')
      return { ...base, status: 'unavailable' }
    }
    base.nextRunAt = schedule.nextRunAt
    if (schedule.lastHeldAt && schedule.lastHeldReason && (!schedule.lastRunAt || schedule.lastHeldAt > schedule.lastRunAt)) {
      base.hold = { at: schedule.lastHeldAt, reason: schedule.lastHeldReason }
    }

    if (!schedule.nextRunAt) {
      reasons.push('Enabled, but the scheduler has no next run time')
      return { ...base, status: 'unavailable' }
    }
    if (now.getTime() - new Date(schedule.nextRunAt).getTime() > OVERDUE_GRACE_MS) {
      reasons.push(`Overdue — was due at ${schedule.nextRunAt}`)
      return { ...base, status: 'degraded' }
    }
    if (failing) {
      reasons.push(`The last run failed${latestTerminal.error ? `: ${latestTerminal.error}` : ''}`)
      return { ...base, status: 'degraded' }
    }
    if (base.hold && COVERAGE_HOLD.test(base.hold.reason)) {
      reasons.push(`Held: ${base.hold.reason}; next check ${schedule.nextRunAt}`)
      return { ...base, status: 'held' }
    }
    if (!lastSuccess) {
      reasons.push(`No run has completed yet; first run due ${schedule.nextRunAt}`)
      return { ...base, status: 'starting' }
    }
    if (base.hold) reasons.push(`Last check held: ${base.hold.reason}`)
    reasons.push(`Next run ${schedule.nextRunAt} (${this.timezone})`)
    return { ...base, status: 'healthy' }
  }

  /** Why an automation ran, was held, or did not run — newest first. */
  triggerHistory(id: string, limit = 20): {
    automationId: string
    decisions: TriggerLedgerEntry[]
    runs: { id: string; status: string; createdAt: string; completedAt: string | null; error: string | null }[]
    changes: AutomationChange[]
  } {
    const entry = this.requireEntry(id)
    const engine = this.deps.engine()
    const cap = Math.min(Math.max(limit, 1), 200)
    return {
      automationId: id,
      decisions: engine ? engine.listTriggerLedger({ scheduleId: id, limit: cap }) : [],
      runs: engine
        ? this.runsFor(engine, entry).slice(0, cap).map(r => ({ id: r.id, status: r.status, createdAt: r.createdAt, completedAt: r.completedAt, error: r.error }))
        : [],
      changes: this.deps.changes?.list({ automationId: id, limit: cap }) ?? [],
    }
  }

  changeHistory(opts: { automationId?: string; repo?: string; limit?: number } = {}): AutomationChange[] {
    return this.deps.changes?.list(opts) ?? []
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  create(input: CreateAutomationInput, ctx: ChangeContext, opts: { rejectDuplicates?: boolean } = {}): MutationResult {
    const replay = this.replay(ctx, 'create')
    if (replay) return replay

    const repo = this.requireRepo(input.repo)
    const workflows = this.deps.workflows(repo)
    const workflow = workflows.find(w => w.kind === input.kind)
    if (!workflow) {
      throw new AutomationError(`Workflow "${input.kind}" is not available in ${repo}`, 400, { available: workflows.map(w => w.kind) })
    }
    this.assertCron(input.cronExpression)
    this.assertProvider(input.provider)

    const config = this.deps.config.load()
    if (opts.rejectDuplicates) {
      const existing = config.reviewRepos.find(r => r.repoPath === repo && (r.kind ?? 'code-review.daily') === input.kind)
      if (existing) {
        throw new AutomationError(`${input.kind} is already configured for this repo (automation ${existing.id}) — update it instead`, 409, { existing: this.view(existing, workflows) })
      }
    }

    const id = input.id ?? this.uniqueId(`${basename(repo)}-${input.kind}`.toLowerCase().replace(/[^a-z0-9-]+/g, '-'), config)
    if (config.reviewRepos.some(r => r.id === id)) {
      throw new AutomationError(`An automation with id ${id} already exists`, 409)
    }

    const entry: ReviewRepoConfig = {
      id,
      name: input.name ?? `${workflow.name}: ${basename(repo)}`,
      repoPath: repo,
      cronExpression: input.cronExpression,
      enabled: input.enabled !== false,
      kind: input.kind,
      customPrompt: input.customPrompt,
      model: input.model,
      provider: input.provider,
      revision: 1,
    }
    this.deps.config.add(entry)
    this.safeSync()
    const change = this.record(entry, 'create', ctx, null, entry)
    return { automation: this.view(entry, workflows), change, replayed: false, activeRuns: [], affectedResponsibilities: [] }
  }

  update(id: string, patch: AutomationPatch, ctx: ChangeContext & { expectedRevision?: number }): MutationResult {
    const replay = this.replay(ctx, 'update', id)
    if (replay) return replay

    const before = this.requireEntry(id)
    this.assertRevision(before, ctx.expectedRevision)
    if (patch.cronExpression !== undefined) this.assertCron(patch.cronExpression)
    this.assertProvider(patch.provider)
    if (patch.kind !== undefined && patch.kind !== (before.kind ?? 'code-review.daily')) {
      const available = this.safeWorkflows(before.repoPath)
      if (!available.some(w => w.kind === patch.kind)) {
        throw new AutomationError(`Workflow "${patch.kind}" is not available in ${before.repoPath}`, 400, { available: available.map(w => w.kind) })
      }
    }

    const clean = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as AutomationPatch
    const changedKeys = (Object.keys(clean) as (keyof AutomationPatch)[]).filter(k => clean[k] !== before[k])
    if (changedKeys.length === 0) {
      return { automation: this.get(id), change: null, replayed: false, activeRuns: this.activeRuns(before), affectedResponsibilities: [] }
    }

    const after: ReviewRepoConfig = { ...before, ...clean, revision: revisionOf(before) + 1 }
    this.deps.config.update(id, { ...clean, revision: after.revision })
    this.safeSync()
    const action: AutomationChangeAction = changedKeys.length === 1 && changedKeys[0] === 'enabled'
      ? (after.enabled ? 'enable' : 'disable')
      : 'update'
    const change = this.record(after, action, ctx, before, after)
    return { automation: this.get(id), change, replayed: false, activeRuns: this.activeRuns(after), affectedResponsibilities: this.affected(id, action) }
  }

  /** Remove future configured execution. Run history and workflow files are kept. */
  remove(id: string, ctx: ChangeContext & { expectedRevision?: number }): MutationResult {
    const replay = this.replay(ctx, 'remove', id)
    if (replay) return replay

    const before = this.requireEntry(id)
    this.assertRevision(before, ctx.expectedRevision)
    const activeRuns = this.activeRuns(before)
    this.deps.config.remove(id)
    this.safeSync()
    const change = this.record(before, 'remove', ctx, before, null)
    return { automation: null, change, replayed: false, activeRuns, affectedResponsibilities: this.affected(id, 'remove') }
  }

  /** Run an automation now (manual trigger — activity gates bypassed). */
  async trigger(id: string): Promise<WorkflowRun> {
    const entry = this.requireEntry(id)
    const engine = this.deps.engine()
    if (!engine) throw new AutomationError('The workflow engine is not running', 409)
    if (entry.cronExpression !== 'event' && engine.getSchedule(id)) return engine.triggerSchedule(id)
    return engine.startRun(entry.kind ?? 'code-review.daily', {
      repoPath: entry.repoPath,
      repoName: entry.name,
      customPrompt: entry.customPrompt,
      model: entry.model,
      provider: entry.provider,
    })
  }

  /** Adopt an automation into its repo's maintenance plan, or hand it back. Audited like any change. */
  setManagedBy(id: string, owner: 'user' | 'maintenance', ctx: ChangeContext): RepoAutomation {
    const before = this.requireEntry(id)
    if ((before.managedBy ?? 'user') === owner) return this.get(id)
    const after: ReviewRepoConfig = { ...before, managedBy: owner === 'maintenance' ? 'maintenance' : undefined, revision: revisionOf(before) + 1 }
    this.deps.config.update(id, { managedBy: after.managedBy, revision: after.revision })
    this.record(after, 'update', ctx, before, after)
    return this.get(id)
  }

  /** Run a workflow kind once, outside any configured automation. */
  async startAdHocRun(kind: string, input: Record<string, unknown>): Promise<WorkflowRun> {
    const engine = this.deps.engine()
    if (!engine) throw new AutomationError('The workflow engine is not running', 409)
    try {
      return await engine.startRun(kind, input)
    } catch (err) {
      throw new AutomationError(err instanceof Error ? err.message : String(err), 400)
    }
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireEntry(id: string): ReviewRepoConfig {
    const entry = this.deps.config.load().reviewRepos.find(r => r.id === id)
    if (!entry) throw new AutomationError(`Automation not found: ${id}`, 404)
    return entry
  }

  private requireRepo(repo: string): string {
    const resolved = this.deps.resolveRepo(repo)
    if (!resolved) throw new AutomationError(`Invalid repo: ${repo} must be an existing directory under the configured repos root`, 400)
    return repo
  }

  private assertCron(cron: string): void {
    if (cron !== 'event' && !isValidCron(cron)) {
      throw new AutomationError(`Invalid cron expression "${cron}" — use five fields (minute hour day month weekday) or "event"`, 400)
    }
  }

  private assertProvider(provider: string | undefined): void {
    if (provider !== undefined && !VALID_PROVIDERS.has(provider as never)) {
      throw new AutomationError(`Invalid provider: ${provider}`, 400)
    }
  }

  private assertRevision(entry: ReviewRepoConfig, expected: number | undefined): void {
    if (expected === undefined) return
    const current = revisionOf(entry)
    if (expected !== current) {
      throw new AutomationError(
        `Automation ${entry.id} changed since you read it (revision ${current}, you expected ${expected}) — re-read it and retry`,
        409,
        { currentRevision: current, automation: this.view(entry, this.safeWorkflows(entry.repoPath)) },
      )
    }
  }

  /** An idempotency key already applied returns its recorded result. */
  private replay(ctx: ChangeContext, action: 'create' | 'update' | 'remove', id?: string): MutationResult | null {
    if (!ctx.idempotencyKey || !this.deps.changes) return null
    const prior = this.deps.changes.findByIdempotencyKey(ctx.idempotencyKey)
    if (!prior) return null
    const priorKind = prior.action === 'enable' || prior.action === 'disable' ? 'update' : prior.action
    if (priorKind !== action || (id && prior.automationId !== id)) {
      throw new AutomationError(`Idempotency key ${ctx.idempotencyKey} was already used for a different change`, 409)
    }
    let automation: RepoAutomation | null
    try {
      automation = action === 'remove' ? null : this.get(prior.automationId)
    } catch {
      automation = null
    }
    return { automation, change: prior, replayed: true, activeRuns: [], affectedResponsibilities: [] }
  }

  private record(entry: ReviewRepoConfig, action: AutomationChangeAction, ctx: ChangeContext, before: ReviewRepoConfig | null, after: ReviewRepoConfig | null): AutomationChange | null {
    if (!this.deps.changes) return null
    return this.deps.changes.record({
      automationId: entry.id,
      repo: entry.repoPath,
      action,
      actor: ctx.actor,
      reason: ctx.reason ?? null,
      before: before ? { ...before } : null,
      after: after ? { ...after } : null,
      authorization: ctx.authorization ?? null,
      originSessionId: ctx.originSessionId ?? null,
      taskId: ctx.taskId ?? null,
      idempotencyKey: ctx.idempotencyKey ?? null,
    })
  }

  private safeSync(): void {
    try {
      this.deps.sync()
    } catch (err) {
      // Engine not ready yet — the boot-time sync picks the config up.
      console.warn('[automations] Schedule sync deferred:', err instanceof Error ? err.message : err)
    }
  }

  private safeWorkflows(repo: string): EffectiveWorkflow[] {
    try {
      return this.deps.workflows(repo)
    } catch {
      return []
    }
  }

  private uniqueId(base: string, config: WorkflowConfig): string {
    const taken = new Set(config.reviewRepos.map(r => r.id))
    if (!taken.has(base)) return base
    for (let i = 2; i < 100; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
    return `${base}-${randomUUID().slice(0, 8)}`
  }

  private runsFor(engine: AutomationEngine, entry: ReviewRepoConfig): WorkflowRun[] {
    const kind = entry.kind ?? 'code-review.daily'
    return engine.listRuns({ kind, limit: 200 }).filter(r => r.input.repoPath === entry.repoPath)
  }

  private activeRuns(entry: ReviewRepoConfig): { id: string; status: string }[] {
    const engine = this.deps.engine()
    if (!engine) return []
    return this.runsFor(engine, entry)
      .filter(r => r.status === 'running' || r.status === 'queued')
      .map(r => ({ id: r.id, status: r.status }))
  }

  private view(entry: ReviewRepoConfig, workflows: EffectiveWorkflow[]): RepoAutomation {
    const kind = entry.kind ?? 'code-review.daily'
    const workflow = workflows.find(w => w.kind === kind)
    let schedule: RepoAutomation['schedule'] = null
    if (entry.cronExpression !== 'event') {
      try {
        const s = this.deps.engine()?.getSchedule(entry.id)
        if (s) schedule = { nextRunAt: s.nextRunAt, lastRunAt: s.lastRunAt, lastHeldAt: s.lastHeldAt, lastHeldReason: s.lastHeldReason, heldCount: s.heldCount, catchUp: s.catchUp }
      } catch { /* engine not ready */ }
    }
    return {
      id: entry.id,
      name: entry.name,
      repo: entry.repoPath,
      kind,
      workflow: workflow ? { name: workflow.name, source: workflow.source, hash: workflow.hash } : null,
      trigger: entry.cronExpression === 'event' ? 'event' : 'schedule',
      cronExpression: entry.cronExpression,
      enabled: entry.enabled,
      customPrompt: entry.customPrompt ?? null,
      model: entry.model ?? null,
      provider: entry.provider ?? null,
      revision: revisionOf(entry),
      managedBy: entry.managedBy === 'maintenance' ? 'maintenance' : 'user',
      schedule,
      timezone: this.timezone,
    }
  }
}

function revisionOf(entry: ReviewRepoConfig): number {
  return entry.revision ?? 1
}
