/** Tests for MaintenanceService — explicit enrollment, evidence-based health, pause gate, and bounded action. */
import { describe, it, expect, beforeEach } from 'vitest'
import { AutomationService, type AutomationEngine } from './automation-service.js'
import { AutomationChangeLog } from './automation-changes.js'
import { MaintenanceStore } from './maintenance-store.js'
import { MaintenanceError, MaintenanceService } from './maintenance-service.js'
import { OrchestratorTaskService } from './orchestrator-tasks.js'
import { TaskStore } from './task-store.js'
import type { WorkflowConfig } from './workflow-config.js'
import type { CronSchedule, WorkflowRun } from './workflow-engine.js'
import type { EffectiveWorkflow } from './workflow-loader.js'

const REPO = '/repos/app'
const NOW = new Date('2026-09-30T12:00:00Z')

function workflow(kind: string): EffectiveWorkflow {
  return { kind, name: kind, source: 'builtin', path: `/wf/${kind}.md`, builtinPath: null, hash: 'h', model: null, outputDir: '.codekin/reports/x', prompt: 'p', configurableFields: [] }
}

function run(partial: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'run-1', kind: 'dependency-health.daily', status: 'succeeded', input: { repoPath: REPO }, output: { filePath: '.codekin/reports/deps.md' },
    error: null, createdAt: '2026-09-30T06:00:00Z', startedAt: null, completedAt: '2026-09-30T06:10:00Z', ...partial,
  }
}

describe('MaintenanceService', () => {
  let config: WorkflowConfig
  let runs: WorkflowRun[]
  let schedules: Map<string, CronSchedule>
  let notes: { label: string; body: string }[]
  let taskStore: TaskStore
  let tasks: OrchestratorTaskService
  let automations: AutomationService
  let maintenance: MaintenanceService

  beforeEach(() => {
    config = { reviewRepos: [] }
    runs = []
    schedules = new Map()
    notes = []
    const engine: AutomationEngine = {
      getSchedule: (id) => schedules.get(id) ?? null,
      listRuns: (opts) => runs.filter(r => !opts?.kind || r.kind === opts.kind),
      listTriggerLedger: () => [],
      getEngineHealth: () => ({ lastTickAt: NOW.toISOString(), tickCount: 1 }),
      startRun: async () => run({}),
      triggerSchedule: async () => run({}),
    }
    automations = new AutomationService({
      config: {
        load: () => config,
        add: (r) => { config.reviewRepos.push(r) },
        update: (id, patch) => {
          const i = config.reviewRepos.findIndex(r => r.id === id)
          config.reviewRepos[i] = { ...config.reviewRepos[i], ...patch }
        },
        remove: (id) => { config.reviewRepos = config.reviewRepos.filter(r => r.id !== id) },
      },
      engine: () => engine,
      sync: () => {},
      resolveRepo: (p) => p,
      workflows: () => [workflow('dependency-health.daily'), workflow('security-audit.weekly')],
      changes: new AutomationChangeLog(':memory:'),
      now: () => NOW,
    })
    taskStore = new TaskStore(':memory:')
    tasks = new OrchestratorTaskService({ store: taskStore, notify: () => true })
    maintenance = new MaintenanceService({
      store: new MaintenanceStore(':memory:'),
      automations,
      tasks: taskStore,
      notifyJoe: (n) => { notes.push(n); return true },
    })
    tasks.setGuard(maintenance)
    automations.setChangeObserver((id, action) => maintenance.affectedBy(id, action))

    config.reviewRepos.push(
      { id: 'deps', name: 'Dependency health', repoPath: REPO, cronExpression: '0 6 * * *', enabled: true, kind: 'dependency-health.daily' },
      { id: 'sec', name: 'Security audit', repoPath: REPO, cronExpression: '0 9 * * 1', enabled: true, kind: 'security-audit.weekly' },
    )
    schedules.set('deps', { id: 'deps', kind: 'dependency-health.daily', cronExpression: '0 6 * * *', input: {}, enabled: true, lastRunAt: '2026-09-30T06:00:00Z', nextRunAt: '2026-10-01T06:00:00Z', catchUp: 'collapse', lastReviewedSha: null, lastHeldAt: null, lastHeldReason: null, heldCount: 0 })
  })

  const deps = { name: 'Keep dependencies healthy', scope: 'package.json', automationIds: ['deps'], policy: 'propose' as const }

  function enablePlan(policy: 'notify' | 'propose' | 'investigate' | 'implement' = 'propose', maxActiveTasks = 1) {
    const r = maintenance.addResponsibility(REPO, { ...deps, policy, maxActiveTasks }, 'user')
    maintenance.enable(REPO, 'user', { adoptAutomationIds: ['deps'] })
    return r
  }

  it('never infers maintenance from automations, tasks or past work', () => {
    tasks.create([{ repo: REPO, title: 'Old work', createdBy: 'joe' }])
    expect(maintenance.get(REPO)).toMatchObject({ state: 'off', label: 'Not maintained', health: null })
    expect(maintenance.list()).toEqual([])
  })

  it('treats Joe\'s additions as proposals only the user can enable', () => {
    const proposal = maintenance.addResponsibility(REPO, deps, 'joe')
    expect(proposal.proposed).toBe(true)
    expect(maintenance.get(REPO)).toMatchObject({ state: 'off', hasProposal: true })
    expect(() => maintenance.enable(REPO, 'joe')).toThrow(/Only the user/)

    const plan = maintenance.enable(REPO, 'user')
    expect(plan.state).toBe('enabled')
    expect(plan.responsibilities[0].proposed).toBe(false)
    expect(notes.at(-1)?.label).toBe('Maintenance Enabled')
    expect(() => maintenance.updateResponsibility(proposal.id, { policy: 'implement' }, 'joe')).toThrow(/Only the user/)
  })

  it('refuses a plan that could not show real coverage', () => {
    expect(() => maintenance.enable(REPO, 'user')).toThrow(/at least one responsibility/)
    expect(() => maintenance.addResponsibility(REPO, { ...deps, automationIds: ['nope'] }, 'user')).toThrow(/only functioning checks/)
  })

  it('derives health from the linked automations\' evidence', () => {
    enablePlan()
    // Schedule is timely but no run has succeeded yet.
    expect(maintenance.get(REPO)).toMatchObject({ health: 'starting', label: 'Maintenance starting' })

    runs = [run({})]
    expect(maintenance.get(REPO)).toMatchObject({ health: 'healthy', label: 'Joe maintaining' })

    runs = [run({ id: 'bad', status: 'failed', error: 'npm audit crashed', completedAt: '2026-09-30T07:00:00Z' }), run({})]
    const plan = maintenance.get(REPO)
    expect(plan).toMatchObject({ health: 'degraded', label: 'Maintenance needs attention' })
    expect(plan.reasons[0]).toMatch(/Keep dependencies healthy/)
  })

  it('reports affected coverage when a linked automation is disabled or removed', () => {
    enablePlan()
    runs = [run({})]
    const disabled = automations.update('deps', { enabled: false }, { actor: 'user' })
    expect(disabled.affectedResponsibilities).toEqual(['Keep dependencies healthy'])
    expect(maintenance.get(REPO).health).toBe('degraded')

    automations.remove('deps', { actor: 'user' })
    expect(maintenance.get(REPO).responsibilities[0].checks[0].health).toBe('missing')
    expect(maintenance.get(REPO).health).toBe('unavailable')
  })

  describe('pause and resume', () => {
    it('holds adopted automations only, and never rewrites their own settings', () => {
      enablePlan()
      maintenance.pause(REPO, 'joe')
      expect(maintenance.dispatchHold('deps')).toMatch(/maintenance paused/)
      expect(maintenance.dispatchHold('sec')).toBeNull() // independently managed
      expect(config.reviewRepos.find(r => r.id === 'deps')?.enabled).toBe(true)

      expect(() => maintenance.resume(REPO, 'joe')).toThrow(/Only the user/)
      maintenance.resume(REPO, 'user')
      expect(maintenance.dispatchHold('deps')).toBeNull()
    })

    it('stops governed dispatch when turned off until the automation is released', () => {
      enablePlan()
      maintenance.turnOff(REPO, 'user')
      expect(maintenance.dispatchHold('deps')).toMatch(/maintenance off/)
      maintenance.release('deps', 'user')
      expect(maintenance.dispatchHold('deps')).toBeNull()
      expect(automations.get('deps').managedBy).toBe('user')
    })

    it('rejects stale plan changes', () => {
      enablePlan()
      const { revision } = maintenance.get(REPO)
      maintenance.pause(REPO, 'user')
      expect(() => maintenance.resume(REPO, 'user', { expectedRevision: revision })).toThrow(MaintenanceError)
    })
  })

  describe('bounded action', () => {
    it('enforces plan state, policy and task limit on maintenance tasks', () => {
      const r = enablePlan('propose', 1)
      const [task] = tasks.create([{ repo: REPO, title: 'Bump lodash', createdBy: 'joe', responsibilityId: r.id }])
      expect(() => tasks.create([{ repo: REPO, title: 'Bump react', createdBy: 'joe', responsibilityId: r.id }])).toThrow(/limit 1/)

      // Propose: Joe may not start it; the user's Start authorizes it.
      expect(() => tasks.assertStartable(task.id, REPO)).toThrow(/only proposes work/)
      tasks.requestStart(task.id)
      expect(() => tasks.assertStartable(task.id, REPO)).not.toThrow()

      tasks.update(task.id, { status: 'done' }, 'user')
      maintenance.pause(REPO, 'user')
      expect(() => tasks.create([{ repo: REPO, title: 'While paused', createdBy: 'joe', responsibilityId: r.id }])).toThrow(/paused/)
    })

    it('does not let a notify-only responsibility create work', () => {
      const r = enablePlan('notify')
      expect(() => tasks.create([{ repo: REPO, title: 'x', createdBy: 'joe', responsibilityId: r.id }])).toThrow(/only notifies/)
    })

    it('lets an implement policy start its own tasks', () => {
      const r = enablePlan('implement')
      const [task] = tasks.create([{ repo: REPO, title: 'Fix CVE', createdBy: 'joe', responsibilityId: r.id }])
      expect(() => tasks.assertStartable(task.id, REPO)).not.toThrow()
    })

    it('observes each finished check once and hands Joe the policy', () => {
      enablePlan('investigate')
      maintenance.observeRun(run({}))
      maintenance.observeRun(run({})) // replayed event
      const checks = notes.filter(n => n.label === 'Maintenance Check')
      expect(checks).toHaveLength(1)
      expect(checks[0].body).toContain('Investigate:')
      expect(checks[0].body).toContain('.codekin/reports/deps.md')
      expect(maintenance.activity(REPO).filter(a => a.kind === 'check_ok')).toHaveLength(1)
      expect(maintenance.get(REPO).responsibilities[0].latestObservation).toMatch(/Check completed/)

      maintenance.observeRun(run({ id: 'run-2', status: 'failed', error: 'timeout' }))
      expect(notes.at(-1)?.label).toBe('Maintenance Check Failed')
      expect(maintenance.activity(REPO)[0]).toMatchObject({ kind: 'check_failed' })
    })

    it('records checks while paused but dispatches nothing', () => {
      enablePlan('implement')
      maintenance.pause(REPO, 'user')
      const before = notes.length
      maintenance.observeRun(run({ id: 'run-during-pause' }))
      expect(notes.length).toBe(before)
      expect(maintenance.activity(REPO)[0].kind).toBe('check_ok')
    })
  })
})
