/**
 * Explicit repo maintenance by Agent Joe
 * (docs/JOE-REPO-COLLABORATION-MAINTENANCE-SPEC.md §6–§9, §11).
 *
 * A repo is maintained only when the user enables a plan. The plan's
 * responsibilities link to existing repo automations — there is no second
 * scheduler — and its health is computed from those automations' evidence,
 * so missing, stale, held or failing coverage never shows as healthy.
 *
 * Enforcement lives here, not in Joe's prompt:
 * - Joe can propose responsibilities; only the user enables, resumes, or
 *   widens a plan. Joe may pause (it only reduces authority).
 * - Pausing is a dispatch gate for automations adopted into the plan; their
 *   own enabled settings are never rewritten, so resume restores them as-is.
 * - Maintenance tasks need an enabled plan and responsibility, respect the
 *   responsibility's task limit, and a notify/propose policy never lets Joe
 *   start work the user has not started.
 * - Each finished run of a linked automation is recorded once (by run id) as
 *   activity and handed to Joe with the responsibility's policy.
 */

import type { AutomationHealth, AutomationService } from './automation-service.js'
import type { Task, TaskStore } from './task-store.js'
import { CLOSED_TASK_STATUSES } from './task-store.js'
import type { WorkflowRun } from './workflow-engine.js'
import {
  RESPONSE_POLICIES,
  type MaintenanceActivity,
  type MaintenancePlan,
  type MaintenanceStore,
  type PlanState,
  type Responsibility,
  type ResponsibilityInput,
  type ResponsePolicy,
} from './maintenance-store.js'

export class MaintenanceError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message)
    this.name = 'MaintenanceError'
  }
}

export type MaintenanceActor = 'user' | 'joe'
export type CoverageHealth = 'healthy' | 'starting' | 'degraded' | 'unavailable'

export interface ResponsibilityView extends Responsibility {
  health: CoverageHealth | null
  reasons: string[]
  checks: {
    automationId: string
    name: string | null
    managedBy: 'user' | 'maintenance' | null
    health: AutomationHealth['status'] | 'missing'
    lastSuccessAt: string | null
    nextRunAt: string | null
    hold: AutomationHealth['hold']
  }[]
  openTasks: number
}

export interface RepoMaintenance {
  repo: string
  state: PlanState
  revision: number
  /** Operational health; null unless the plan is enabled. */
  health: CoverageHealth | null
  label: 'Not maintained' | 'Joe maintaining' | 'Maintenance starting' | 'Maintenance needs attention' | 'Maintenance paused'
  reasons: string[]
  responsibilities: ResponsibilityView[]
  /** Open tasks governed by the plan. */
  activeTasks: number
  /** Of those, running now. */
  runningTasks: number
  /** Decisions and reviews waiting on the user. */
  needsYou: number
  /** Adopted automations that stop running while the plan is not enabled. */
  governedAutomations: string[]
  hasProposal: boolean
  updatedAt: string | null
}

export interface MaintenanceServiceDeps {
  store: MaintenanceStore
  automations: AutomationService
  tasks: TaskStore
  notifyJoe: (args: { label: string; title: string; body: string }) => boolean
  /** Whether a child session is an active attempt. */
  isChildActive?: (childId: string) => boolean
}

const HEALTH_RANK: Record<CoverageHealth, number> = { healthy: 0, starting: 1, degraded: 2, unavailable: 3 }

function worst(values: CoverageHealth[]): CoverageHealth {
  return values.reduce<CoverageHealth>((acc, h) => (HEALTH_RANK[h] > HEALTH_RANK[acc] ? h : acc), 'healthy')
}

/** Automation health folded into the spec's four coverage states. */
function coverageOf(status: AutomationHealth['status'] | 'missing'): CoverageHealth {
  switch (status) {
    case 'healthy': return 'healthy'
    case 'starting': return 'starting'
    case 'held':
    case 'degraded':
    case 'disabled': return 'degraded'
    case 'unavailable':
    case 'missing': return 'unavailable'
  }
}

const POLICY_TEXT: Record<ResponsePolicy, string> = {
  notify: 'Notify: record findings and bring them to the user\'s attention. Do not create or start work.',
  propose: 'Propose work: create_task with responsibilityId for findings worth fixing; do not start it — the user starts proposed tasks.',
  investigate: 'Investigate: you may start a child to diagnose and recommend (no code changes beyond the report); ask with request_decision before any fix.',
  implement: 'Implement: you may start a child to fix the finding through a verified PR, within the responsibility\'s scope and task limit.',
}

export class MaintenanceService {
  constructor(private readonly deps: MaintenanceServiceDeps) {}

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /** Summaries for every repo that has (or had) a plan. */
  list(): RepoMaintenance[] {
    const repos = new Set([...this.deps.store.listPlans().map(p => p.repo), ...this.deps.store.listResponsibilities().map(r => r.repo)])
    return [...repos].sort().map(repo => this.get(repo))
  }

  get(repo: string): RepoMaintenance {
    const plan = this.deps.store.getPlan(repo)
    const state: PlanState = plan?.state ?? 'off'
    const automations = new Map(this.deps.automations.list({ repo }).map(a => [a.id, a]))
    const tasks = this.deps.tasks.list({ repo }).filter(t => t.responsibilityId)
    const open = tasks.filter(t => !CLOSED_TASK_STATUSES.has(t.status))

    const responsibilities = this.deps.store.listResponsibilities(repo).map((r): ResponsibilityView => {
      const checks: ResponsibilityView['checks'] = r.automationIds.map(id => {
        const automation = automations.get(id)
        if (!automation) {
          return { automationId: id, name: null, managedBy: null, health: 'missing', lastSuccessAt: null, nextRunAt: null, hold: null }
        }
        const health = this.deps.automations.health(id)
        return {
          automationId: id,
          name: automation.name,
          managedBy: automation.managedBy,
          health: health.status,
          lastSuccessAt: health.lastSuccessAt,
          nextRunAt: health.nextRunAt,
          hold: health.hold,
        }
      })
      const reasons: string[] = []
      let health: CoverageHealth | null = null
      if (state === 'enabled' && r.enabled && !r.proposed) {
        if (checks.length === 0) {
          health = 'unavailable'
          reasons.push('No automation provides this check')
        } else {
          health = worst(checks.map(c => coverageOf(c.health)))
          for (const c of checks) {
            if (c.health === 'missing') reasons.push(`Linked automation ${c.automationId} no longer exists`)
            else if (c.health === 'disabled') reasons.push(`${c.name ?? c.automationId} is disabled`)
            else if (c.health !== 'healthy') reasons.push(`${c.name ?? c.automationId}: ${c.health}${c.hold ? ` (${c.hold.reason})` : ''}`)
          }
        }
      }
      return { ...r, health, reasons, checks, openTasks: open.filter(t => t.responsibilityId === r.id).length }
    })

    const active = responsibilities.filter(r => r.enabled && !r.proposed)
    const reasons: string[] = []
    let health: CoverageHealth | null = null
    if (state === 'enabled') {
      if (active.length === 0) {
        health = 'degraded'
        reasons.push('The plan has no enabled responsibilities')
      } else {
        health = worst(active.map(r => r.health ?? 'unavailable'))
        for (const r of active) if (r.health !== 'healthy') reasons.push(`${r.name}: ${r.reasons.join('; ') || r.health}`)
      }
    }

    const governed = [...automations.values()].filter(a => a.managedBy === 'maintenance').map(a => a.id)
    return {
      repo,
      state,
      revision: plan?.revision ?? 0,
      health,
      label: labelOf(state, health),
      reasons,
      responsibilities,
      activeTasks: open.length,
      runningTasks: open.filter(t => t.childId && this.deps.isChildActive?.(t.childId)).length,
      needsYou: open.filter(t => t.status === 'needs_decision' || t.status === 'in_review').length,
      governedAutomations: governed,
      hasProposal: responsibilities.some(r => r.proposed),
      updatedAt: plan?.updatedAt ?? null,
    }
  }

  activity(repo: string, limit = 50): MaintenanceActivity[] {
    return this.deps.store.listActivity({ repo, limit })
  }

  // -------------------------------------------------------------------------
  // Plan state
  // -------------------------------------------------------------------------

  /**
   * Enable maintenance (the user's decision). Accepts any proposed
   * responsibilities, adopts the listed automations into the plan, and
   * refuses a plan that could not show real coverage.
   */
  enable(repo: string, actor: MaintenanceActor, opts: { expectedRevision?: number; adoptAutomationIds?: string[] } = {}): RepoMaintenance {
    this.requireUser(actor, 'Only the user can enable maintenance — propose a plan and ask them to review it')
    this.assertRevision(repo, opts.expectedRevision)
    const responsibilities = this.deps.store.listResponsibilities(repo).filter(r => r.enabled)
    if (responsibilities.length === 0) throw new MaintenanceError('Add at least one responsibility before enabling maintenance', 400)
    const automationIds = new Set(this.deps.automations.list({ repo }).map(a => a.id))
    for (const r of responsibilities) {
      if (r.automationIds.length === 0) throw new MaintenanceError(`"${r.name}" has no automation to provide its checks`, 400)
      const missing = r.automationIds.filter(id => !automationIds.has(id))
      if (missing.length) throw new MaintenanceError(`"${r.name}" links automations that do not exist: ${missing.join(', ')}`, 400)
    }
    for (const r of responsibilities.filter(x => x.proposed)) this.deps.store.updateResponsibility(r.id, { proposed: false })
    for (const id of opts.adoptAutomationIds ?? []) {
      if (!responsibilities.some(r => r.automationIds.includes(id))) throw new MaintenanceError(`Automation ${id} is not linked to a responsibility`, 400)
      this.deps.automations.setManagedBy(id, 'maintenance', { actor, reason: 'Adopted into the maintenance plan' })
    }
    this.deps.store.setState(repo, 'enabled', actor)
    this.log(repo, 'config', `Maintenance enabled with ${responsibilities.length} responsibilit${responsibilities.length === 1 ? 'y' : 'ies'}`)
    this.tellJoe(repo, 'Maintenance Enabled', 'The user enabled maintenance for this repo. You are now responsible for its enabled responsibilities (get_maintenance_plan). Do not claim coverage beyond them.')
    return this.get(repo)
  }

  /** Pause: suspend governed checks and new maintenance dispatch. Running work continues. */
  pause(repo: string, actor: MaintenanceActor, opts: { expectedRevision?: number } = {}): RepoMaintenance {
    this.assertRevision(repo, opts.expectedRevision)
    if (this.deps.store.getPlan(repo)?.state !== 'enabled') throw new MaintenanceError('Maintenance is not enabled for this repo', 409)
    this.deps.store.setState(repo, 'paused', actor)
    const running = this.get(repo).runningTasks
    this.log(repo, 'config', `Maintenance paused by ${actor === 'user' ? 'the user' : 'Joe'}${running ? ` — ${running} running task${running === 1 ? '' : 's'} will finish` : ''}`)
    if (actor === 'user') this.tellJoe(repo, 'Maintenance Paused', 'The user paused maintenance. Start no new maintenance work here; running tasks may finish.')
    return this.get(repo)
  }

  /** Resume (the user's decision): governed automations resume on their next slot, collapsing missed ones. */
  resume(repo: string, actor: MaintenanceActor, opts: { expectedRevision?: number } = {}): RepoMaintenance {
    this.requireUser(actor, 'Only the user can resume maintenance')
    this.assertRevision(repo, opts.expectedRevision)
    if (this.deps.store.getPlan(repo)?.state !== 'paused') throw new MaintenanceError('Maintenance is not paused', 409)
    this.deps.store.setState(repo, 'enabled', actor)
    this.log(repo, 'config', 'Maintenance resumed')
    this.tellJoe(repo, 'Maintenance Resumed', 'The user resumed maintenance. Reconcile with current conditions before acting (existing tasks, get_automation_health) — do not create duplicate tasks for issues already tracked.')
    return this.get(repo)
  }

  /** Turn off: no standing mandate. History, tasks and responsibilities are kept. */
  turnOff(repo: string, actor: MaintenanceActor, opts: { expectedRevision?: number } = {}): RepoMaintenance {
    this.requireUser(actor, 'Only the user can turn maintenance off — you may pause it')
    this.assertRevision(repo, opts.expectedRevision)
    this.deps.store.setState(repo, 'off', actor)
    this.log(repo, 'config', 'Maintenance turned off')
    this.tellJoe(repo, 'Maintenance Turned Off', 'The user turned maintenance off. This repo is no longer yours to watch; individual tasks the user asks for still apply.')
    return this.get(repo)
  }

  /** Hand an adopted automation back to independent management (it runs regardless of the plan). */
  release(automationId: string, actor: MaintenanceActor): void {
    this.requireUser(actor, 'Only the user can release an automation from maintenance')
    this.deps.automations.setManagedBy(automationId, 'user', { actor, reason: 'Released from the maintenance plan' })
  }

  // -------------------------------------------------------------------------
  // Responsibilities
  // -------------------------------------------------------------------------

  /**
   * Add a responsibility. Joe's additions are proposals — inert until the
   * user enables (or re-enables) the plan with them.
   */
  addResponsibility(repo: string, input: ResponsibilityInput, actor: MaintenanceActor): Responsibility {
    this.validateInput(repo, input)
    const proposed = actor === 'joe'
    const created = this.deps.store.addResponsibility(repo, { ...input, proposed })
    this.log(repo, 'config', `${proposed ? 'Proposed' : 'Added'} responsibility "${created.name}" (${created.policy})`, created.id)
    return created
  }

  updateResponsibility(id: string, patch: Partial<ResponsibilityInput>, actor: MaintenanceActor): Responsibility {
    const existing = this.requireResponsibility(id)
    if (actor === 'joe' && !existing.proposed) {
      throw new MaintenanceError('Only the user can change an accepted responsibility — propose a new one instead', 403)
    }
    this.validateInput(existing.repo, { ...existing, ...patch })
    const updated = this.deps.store.updateResponsibility(id, patch)
    if (!updated) throw new MaintenanceError('Responsibility not found', 404)
    this.log(existing.repo, 'config', `Changed responsibility "${updated.name}"`, id)
    return updated
  }

  removeResponsibility(id: string, actor: MaintenanceActor): void {
    const existing = this.requireResponsibility(id)
    if (actor === 'joe' && !existing.proposed) throw new MaintenanceError('Only the user can remove an accepted responsibility', 403)
    this.deps.store.removeResponsibility(id)
    this.log(existing.repo, 'config', `Removed responsibility "${existing.name}"`)
  }

  // -------------------------------------------------------------------------
  // Enforcement
  // -------------------------------------------------------------------------

  /** Dispatch gate for the workflow engine: why a governed schedule must not fire, or null. */
  dispatchHold(automationId: string): string | null {
    const automation = this.safeAutomation(automationId)
    if (automation?.managedBy !== 'maintenance') return null
    const state = this.deps.store.getPlan(automation.repo)?.state ?? 'off'
    if (state === 'paused') return 'maintenance paused — resumes with the plan'
    if (state === 'off') return 'maintenance off — release the automation to run it independently'
    return null
  }

  /** May a task be created under this responsibility right now? */
  assertTaskAllowed(responsibilityId: string, repo: string): Responsibility {
    const r = this.requireResponsibility(responsibilityId)
    if (r.repo !== repo) throw new MaintenanceError(`Responsibility belongs to ${r.repo}, not ${repo}`, 409)
    const state = this.deps.store.getPlan(repo)?.state ?? 'off'
    if (state !== 'enabled') throw new MaintenanceError(`Maintenance is ${state === 'paused' ? 'paused' : 'not enabled'} for this repo`, 409)
    if (!r.enabled || r.proposed) throw new MaintenanceError(`"${r.name}" is not an enabled responsibility`, 409)
    if (r.policy === 'notify') throw new MaintenanceError(`"${r.name}" only notifies — record the finding instead of creating work`, 403)
    const open = this.deps.tasks.list({ repo }).filter(t => t.responsibilityId === r.id && !CLOSED_TASK_STATUSES.has(t.status))
    if (open.length >= r.maxActiveTasks) {
      throw new MaintenanceError(`"${r.name}" already has ${open.length} open task${open.length === 1 ? '' : 's'} (limit ${r.maxActiveTasks}) — update the existing one`, 409)
    }
    return r
  }

  /** May Joe start execution on a maintenance task? */
  assertStartAllowed(task: Task): void {
    if (!task.responsibilityId) return
    const r = this.deps.store.getResponsibility(task.responsibilityId)
    const state = r ? this.deps.store.getPlan(r.repo)?.state ?? 'off' : 'off'
    // Work the user asked to start is theirs to authorize, whatever the plan.
    const userStarted = !!task.queuedAt
    if (userStarted) return
    if (!r || state !== 'enabled') throw new MaintenanceError('Maintenance is not enabled for this task\'s repo — the user must start it', 409)
    if (r.policy === 'notify' || r.policy === 'propose') {
      throw new MaintenanceError(`"${r.name}" only proposes work — the user starts it from Tasks`, 403)
    }
  }

  /** Responsibilities whose checks an automation change affects (for UI and audit). */
  affectedBy(automationId: string, action: string): string[] {
    const affected = this.deps.store.listResponsibilities().filter(r => r.automationIds.includes(automationId) && !r.proposed)
    for (const r of affected) {
      const verb = action === 'remove' ? 'was removed' : action === 'disable' ? 'was disabled' : 'changed'
      this.deps.store.recordActivity({
        repo: r.repo,
        responsibilityId: r.id,
        kind: 'coverage',
        summary: `Linked automation ${automationId} ${verb} — "${r.name}" coverage is affected`,
        ref: null,
      })
    }
    return affected.map(r => r.name)
  }

  // -------------------------------------------------------------------------
  // Observation → bounded action
  // -------------------------------------------------------------------------

  /** A workflow run finished: record it for every responsibility it serves, once. */
  observeRun(run: WorkflowRun): void {
    if (run.status !== 'succeeded' && run.status !== 'failed' && run.status !== 'skipped') return
    const repo = typeof run.input.repoPath === 'string' ? run.input.repoPath : null
    if (!repo) return
    const automationIds = new Set(this.deps.automations.list({ repo }).filter(a => a.kind === run.kind).map(a => a.id))
    if (automationIds.size === 0) return
    const responsibilities = this.deps.store.listResponsibilities(repo)
      .filter(r => r.enabled && !r.proposed && r.automationIds.some(id => automationIds.has(id)))
    if (responsibilities.length === 0) return
    const planEnabled = this.deps.store.getPlan(repo)?.state === 'enabled'
    const reportPath = typeof run.output?.reportPath === 'string' ? run.output.reportPath
      : typeof run.output?.filePath === 'string' ? run.output.filePath : null

    for (const r of responsibilities) {
      const kind = run.status === 'failed' ? 'check_failed' : 'check_ok'
      const summary = run.status === 'failed'
        ? `Check failed: ${run.kind}${run.error ? ` — ${run.error}` : ''}`
        : run.status === 'skipped'
          ? `No changes to check (${run.kind}${run.error ? `: ${run.error}` : ''})`
          : `Check completed: ${run.kind}${reportPath ? ` — ${reportPath}` : ''}`
      const recorded = this.deps.store.recordActivity({ repo, responsibilityId: r.id, kind, summary, ref: `${r.id}:${run.id}` })
      if (!recorded) continue // Already handled (replayed event).
      this.deps.store.updateResponsibility(r.id, { latestObservation: summary, latestObservationAt: recorded.createdAt })
      if (!planEnabled || run.status === 'skipped') continue

      if (run.status === 'failed') {
        this.tellJoe(repo, 'Maintenance Check Failed', [
          `Responsibility: ${r.name} (${r.id})`,
          `Run: ${run.id} (${run.kind}) failed${run.error ? `: ${run.error}` : ''}.`,
          'Coverage is degraded until a check succeeds. Look at why (get_automation_trigger_history) and tell the user only if it needs them.',
        ].join('\n'))
        continue
      }
      this.tellJoe(repo, 'Maintenance Check', [
        `Responsibility: ${r.name} (${r.id}) — scope: ${r.scope || 'as named'}`,
        `Run: ${run.id} (${run.kind}) completed${reportPath ? `; report: ${reportPath}` : ''}.`,
        `Policy — ${POLICY_TEXT[r.policy]}`,
        r.requiredDecision ? `Always ask the user before: ${r.requiredDecision}` : null,
        `Task limit: ${r.maxActiveTasks} open at once. Update an existing task for a known problem instead of creating another.`,
        'Triage the report. Record the outcome with record_maintenance_activity — "No issues found" when clean, or the finding. Create tasks with responsibilityId so they stay linked.',
      ].filter((l): l is string => l !== null).join('\n'))
    }
  }

  /** Joe records a triage outcome or an action for a responsibility. */
  recordActivity(repo: string, input: { responsibilityId?: string; kind: 'finding' | 'check_ok' | 'action'; summary: string; ref?: string }): MaintenanceActivity {
    if (input.responsibilityId) {
      const r = this.requireResponsibility(input.responsibilityId)
      if (r.repo !== repo) throw new MaintenanceError('Responsibility belongs to another repo', 409)
      this.deps.store.updateResponsibility(r.id, { latestObservation: input.summary, latestObservationAt: new Date().toISOString() })
    }
    const entry = this.deps.store.recordActivity({ repo, responsibilityId: input.responsibilityId ?? null, kind: input.kind, summary: input.summary, ref: input.ref ?? null })
    if (!entry) throw new MaintenanceError('That activity was already recorded', 409)
    return entry
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private requireUser(actor: MaintenanceActor, message: string): void {
    if (actor !== 'user') throw new MaintenanceError(message, 403)
  }

  private assertRevision(repo: string, expected: number | undefined): void {
    if (expected === undefined) return
    const current = this.deps.store.getPlan(repo)?.revision ?? 0
    if (current !== expected) throw new MaintenanceError(`The plan changed since you read it (revision ${current}) — reload and retry`, 409)
  }

  private requireResponsibility(id: string): Responsibility {
    const r = this.deps.store.getResponsibility(id)
    if (!r) throw new MaintenanceError('Responsibility not found', 404)
    return r
  }

  private validateInput(repo: string, input: ResponsibilityInput): void {
    if (!input.name.trim()) throw new MaintenanceError('A responsibility needs a name', 400)
    if (!RESPONSE_POLICIES.includes(input.policy)) throw new MaintenanceError(`Invalid policy: one of ${RESPONSE_POLICIES.join(', ')}`, 400)
    if (input.maxActiveTasks !== undefined && (!Number.isInteger(input.maxActiveTasks) || input.maxActiveTasks < 1 || input.maxActiveTasks > 10)) {
      throw new MaintenanceError('maxActiveTasks must be 1–10', 400)
    }
    const known = new Set(this.deps.automations.list({ repo }).map(a => a.id))
    const unknown = input.automationIds.filter(id => !known.has(id))
    if (unknown.length) throw new MaintenanceError(`Not automations of this repo: ${unknown.join(', ')} — only functioning checks can provide coverage`, 400)
  }

  private safeAutomation(id: string) {
    try {
      return this.deps.automations.get(id)
    } catch {
      return null
    }
  }

  private log(repo: string, kind: MaintenanceActivity['kind'], summary: string, responsibilityId: string | null = null): void {
    this.deps.store.recordActivity({ repo, responsibilityId, kind, summary, ref: null })
  }

  private tellJoe(repo: string, label: string, body: string): void {
    this.deps.notifyJoe({ label, title: `${label}: ${repo}`, body: `Repo: ${repo}\n${body}` })
  }
}

function labelOf(state: PlanState, health: CoverageHealth | null): RepoMaintenance['label'] {
  if (state === 'off') return 'Not maintained'
  if (state === 'paused') return 'Maintenance paused'
  if (health === 'healthy') return 'Joe maintaining'
  if (health === 'starting') return 'Maintenance starting'
  return 'Maintenance needs attention'
}

export type { MaintenancePlan }
