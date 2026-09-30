/** Tests for AutomationService — revisions, idempotency, audit trail, and evidence-based health. */
import { describe, it, expect, beforeEach } from 'vitest'
import { AutomationChangeLog } from './automation-changes.js'
import { AutomationError, AutomationService, type AutomationEngine } from './automation-service.js'
import type { ReviewRepoConfig, WorkflowConfig } from './workflow-config.js'
import type { CronSchedule, WorkflowRun } from './workflow-engine.js'
import type { EffectiveWorkflow } from './workflow-loader.js'

const REPO = '/repos/app'
const NOW = new Date('2026-09-30T12:00:00Z')

function workflow(kind: string): EffectiveWorkflow {
  return { kind, name: kind, source: 'builtin', path: `/wf/${kind}.md`, builtinPath: null, hash: 'h1', model: null, outputDir: '.codekin/reports/x', prompt: 'p', configurableFields: [] }
}

function run(partial: Partial<WorkflowRun>): WorkflowRun {
  return {
    id: 'run', kind: 'security-audit.weekly', status: 'succeeded', input: { repoPath: REPO }, output: null, error: null,
    createdAt: '2026-09-29T09:00:00Z', startedAt: null, completedAt: '2026-09-29T09:10:00Z', ...partial,
  }
}

function schedule(partial: Partial<CronSchedule>): CronSchedule {
  return {
    id: 'a1', kind: 'security-audit.weekly', cronExpression: '0 9 * * 1', input: {}, enabled: true,
    lastRunAt: '2026-09-29T09:00:00Z', nextRunAt: '2026-10-06T09:00:00Z', catchUp: 'collapse',
    lastReviewedSha: null, lastHeldAt: null, lastHeldReason: null, heldCount: 0, ...partial,
  }
}

describe('AutomationService', () => {
  let config: WorkflowConfig
  let runs: WorkflowRun[]
  let schedules: Map<string, CronSchedule>
  let lastTickAt: string | null
  let engineUp: boolean
  let hookInstalled: boolean
  let syncs: number
  let changes: AutomationChangeLog
  let service: AutomationService

  const engine: AutomationEngine = {
    getSchedule: (id) => schedules.get(id) ?? null,
    listRuns: (opts) => runs.filter(r => !opts?.kind || r.kind === opts.kind),
    listTriggerLedger: () => [],
    getEngineHealth: () => ({ lastTickAt, tickCount: 1 }),
    startRun: async (kind, input) => run({ id: 'adhoc', kind, input: input ?? {}, status: 'queued' }),
    triggerSchedule: async (id) => run({ id: `triggered-${id}`, status: 'queued' }),
  }

  beforeEach(() => {
    config = { reviewRepos: [] }
    runs = []
    schedules = new Map()
    lastTickAt = '2026-09-30T11:59:30Z'
    engineUp = true
    hookInstalled = true
    syncs = 0
    changes = new AutomationChangeLog(':memory:')
    service = new AutomationService({
      config: {
        load: () => config,
        add: (repo) => { config.reviewRepos.push(repo) },
        update: (id, patch) => {
          const i = config.reviewRepos.findIndex(r => r.id === id)
          config.reviewRepos[i] = { ...config.reviewRepos[i], ...patch }
        },
        remove: (id) => { config.reviewRepos = config.reviewRepos.filter(r => r.id !== id) },
      },
      engine: () => (engineUp ? engine : null),
      sync: () => { syncs++ },
      resolveRepo: (p) => (p.startsWith('/repos/') ? p : null),
      workflows: () => [workflow('security-audit.weekly'), workflow('commit-review'), workflow('dependency-health.daily')],
      commitHookInstalled: () => hookInstalled,
      changes,
      now: () => NOW,
      timezone: 'Europe/Tallinn',
    })
  })

  function seed(entry: Partial<ReviewRepoConfig> = {}): ReviewRepoConfig {
    const full: ReviewRepoConfig = { id: 'a1', name: 'Security', repoPath: REPO, cronExpression: '0 9 * * 1', enabled: true, kind: 'security-audit.weekly', ...entry }
    config.reviewRepos.push(full)
    return full
  }

  describe('create', () => {
    it('configures a workflow, syncs schedules and records who and why', () => {
      const result = service.create(
        { repo: REPO, kind: 'security-audit.weekly', cronExpression: '0 9 * * 1' },
        { actor: 'joe', reason: 'user asked for Monday reviews', originSessionId: 's1', idempotencyKey: 'key-00001' },
      )
      expect(result.automation).toMatchObject({ repo: REPO, kind: 'security-audit.weekly', revision: 1, timezone: 'Europe/Tallinn', trigger: 'schedule' })
      expect(syncs).toBe(1)
      expect(changes.list()[0]).toMatchObject({ action: 'create', actor: 'joe', reason: 'user asked for Monday reviews', originSessionId: 's1', before: null })
    })

    it('rejects a workflow the repo does not have, and an invalid cron', () => {
      expect(() => service.create({ repo: REPO, kind: 'nope', cronExpression: '0 9 * * 1' }, { actor: 'joe' })).toThrow(/not available/)
      expect(() => service.create({ repo: REPO, kind: 'commit-review', cronExpression: 'every monday' }, { actor: 'joe' })).toThrow(/Invalid cron/)
      expect(() => service.create({ repo: '/etc', kind: 'commit-review', cronExpression: 'event' }, { actor: 'joe' })).toThrow(/Invalid repo/)
    })

    it('applies a retried change once', () => {
      const ctx = { actor: 'joe' as const, reason: 'r', idempotencyKey: 'retry-key-1' }
      const first = service.create({ repo: REPO, kind: 'security-audit.weekly', cronExpression: '0 9 * * 1' }, ctx)
      const second = service.create({ repo: REPO, kind: 'security-audit.weekly', cronExpression: '0 9 * * 1' }, ctx)
      expect(second.replayed).toBe(true)
      expect(second.automation?.id).toBe(first.automation?.id)
      expect(config.reviewRepos).toHaveLength(1)
      expect(changes.list()).toHaveLength(1)
    })

    it('refuses an idempotency key reused for a different change', () => {
      seed()
      service.update('a1', { enabled: false }, { actor: 'joe', idempotencyKey: 'shared-key' })
      expect(() => service.create({ repo: REPO, kind: 'commit-review', cronExpression: 'event' }, { actor: 'joe', idempotencyKey: 'shared-key' }))
        .toThrow(/different change/)
    })

    it('refuses a duplicate workflow for the repo when asked to', () => {
      seed()
      try {
        service.create({ repo: REPO, kind: 'security-audit.weekly', cronExpression: '0 10 * * 1' }, { actor: 'joe' }, { rejectDuplicates: true })
        expect.unreachable()
      } catch (err) {
        expect(err).toBeInstanceOf(AutomationError)
        expect((err as AutomationError).status).toBe(409)
      }
    })
  })

  describe('update and remove', () => {
    it('bumps the revision and rejects a stale writer', () => {
      seed()
      const updated = service.update('a1', { cronExpression: '0 9 * * 1,4' }, { actor: 'user', expectedRevision: 1 })
      expect(updated.automation?.revision).toBe(2)
      expect(() => service.update('a1', { cronExpression: '0 8 * * 1' }, { actor: 'joe', expectedRevision: 1 })).toThrow(/changed since you read it/)
      expect(config.reviewRepos[0].cronExpression).toBe('0 9 * * 1,4')
    })

    it('records an enablement-only change as disable, and reports runs still going', () => {
      seed()
      runs = [run({ id: 'live', status: 'running', completedAt: null })]
      const result = service.update('a1', { enabled: false }, { actor: 'joe', reason: 'stop it' })
      expect(result.change?.action).toBe('disable')
      expect(result.activeRuns).toEqual([{ id: 'live', status: 'running' }])
    })

    it('treats an unchanged patch as a no-op', () => {
      seed()
      const result = service.update('a1', { enabled: true }, { actor: 'user' })
      expect(result.change).toBeNull()
      expect(syncs).toBe(0)
    })

    it('removes configuration but keeps the change history', () => {
      seed()
      const result = service.remove('a1', { actor: 'joe', reason: 'no longer needed', expectedRevision: 1 })
      expect(result.automation).toBeNull()
      expect(config.reviewRepos).toHaveLength(0)
      expect(service.changeHistory({ automationId: 'a1' })[0]).toMatchObject({ action: 'remove', after: null, before: expect.objectContaining({ id: 'a1' }) })
    })
  })

  describe('health', () => {
    it('is healthy only with a recent success and a timely schedule', () => {
      seed()
      schedules.set('a1', schedule({}))
      runs = [run({})]
      expect(service.health('a1')).toMatchObject({ status: 'healthy', nextRunAt: '2026-10-06T09:00:00Z', timezone: 'Europe/Tallinn' })
    })

    it('is starting, not healthy, without evidence', () => {
      seed()
      schedules.set('a1', schedule({ lastRunAt: null }))
      expect(service.health('a1').status).toBe('starting')
    })

    it('is degraded when overdue or when the last run failed', () => {
      seed()
      runs = [run({})]
      schedules.set('a1', schedule({ nextRunAt: '2026-09-30T09:00:00Z' }))
      expect(service.health('a1')).toMatchObject({ status: 'degraded', reasons: [expect.stringMatching(/Overdue/)] })

      schedules.set('a1', schedule({}))
      runs = [run({ id: 'bad', status: 'failed', error: 'push rejected', completedAt: '2026-09-30T09:10:00Z' }), run({})]
      expect(service.health('a1')).toMatchObject({ status: 'degraded', lastFailureError: 'push rejected' })
    })

    it('shows an activity hold instead of claiming coverage', () => {
      seed()
      runs = [run({})]
      schedules.set('a1', schedule({ lastHeldAt: '2026-09-30T09:00:00Z', lastHeldReason: 'repo dormant — held until activity resumes' }))
      const health = service.health('a1')
      expect(health.status).toBe('held')
      expect(health.hold?.reason).toMatch(/dormant/)
    })

    it('is unavailable when the scheduler, schedule or hook is missing', () => {
      seed()
      expect(service.health('a1').status).toBe('unavailable') // no derived schedule

      schedules.set('a1', schedule({}))
      lastTickAt = '2026-09-30T10:00:00Z'
      expect(service.health('a1')).toMatchObject({ status: 'unavailable', scheduler: { stale: true } })

      engineUp = false
      expect(service.health('a1').status).toBe('unavailable')

      engineUp = true
      lastTickAt = NOW.toISOString()
      config.reviewRepos = []
      seed({ id: 'c1', kind: 'commit-review', cronExpression: 'event' })
      hookInstalled = false
      expect(service.health('c1')).toMatchObject({ status: 'unavailable', reasons: [expect.stringMatching(/hook/)] })
    })

    it('reports disabled automations as disabled', () => {
      seed({ enabled: false })
      expect(service.health('a1').status).toBe('disabled')
    })
  })

  it('triggers a configured automation through its schedule', async () => {
    seed()
    schedules.set('a1', schedule({}))
    expect((await service.trigger('a1')).id).toBe('triggered-a1')
  })
})
