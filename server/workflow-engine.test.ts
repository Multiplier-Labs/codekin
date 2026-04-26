/** Tests for WorkflowEngine — verifies step registration, execution, skipping, and singleton lifecycle; mocks better-sqlite3 and fs. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock better-sqlite3 to avoid filesystem side-effects and allow tests to run without a real SQLite database.
const mockRun = vi.fn(() => ({ changes: 1 }))
const mockGet = vi.fn()
const mockAll = vi.fn(() => [])

vi.mock('better-sqlite3', () => {
  class MockDatabase {
    pragma = vi.fn()
    exec = vi.fn()
    prepare = vi.fn(() => ({
      run: mockRun,
      get: mockGet,
      all: mockAll,
    }))
    close = vi.fn()
  }
  return { default: MockDatabase }
})

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    mkdirSync: vi.fn(),
    chmodSync: vi.fn(),
  }
})

import { WorkflowEngine, WorkflowSkipped, SessionGoneError, initWorkflowEngine, getWorkflowEngine, shutdownWorkflowEngine } from './workflow-engine.js'
import type { StepHandler } from './workflow-engine.js'

describe('WorkflowEngine', () => {
  let engine: WorkflowEngine

  beforeEach(() => {
    vi.clearAllMocks()
    engine = new WorkflowEngine('/tmp/test.db')
  })

  afterEach(() => {
    engine.shutdown()
  })

  describe('constructor', () => {
    it('creates tables on initialization', () => {
      const e = new WorkflowEngine('/tmp/test2.db')
      expect(e).toBeDefined()
      e.shutdown()
    })
  })

  describe('registerWorkflow', () => {
    it('registers a workflow definition', () => {
      engine.registerWorkflow({
        kind: 'test-workflow',
        steps: [{ key: 'step1', handler: async () => ({}) }],
      })
      // No error means success
    })
  })

  describe('startRun', () => {
    it('throws for unknown workflow kind', async () => {
      await expect(engine.startRun('unknown-kind')).rejects.toThrow('Unknown workflow kind: unknown-kind')
    })

    it('creates a run and step rows', async () => {
      // Use a blocking handler so the run doesn't complete before we inspect it
      let resolveStep!: () => void
      const handler: StepHandler = async () => {
        await new Promise<void>(r => { resolveStep = r })
        return { result: 'done' }
      }
      engine.registerWorkflow({
        kind: 'simple',
        steps: [{ key: 'step1', handler }],
      })

      // Mock stepRow lookup to return an ID
      mockGet.mockReturnValueOnce({ id: 'step-id-1' })

      const run = await engine.startRun('simple', { foo: 'bar' })
      expect(run.kind).toBe('simple')
      // Run starts executing immediately (microtask), so status is 'running'
      expect(run.status).toBe('running')
      expect(run.input).toEqual({ foo: 'bar' })

      // Let the step complete
      resolveStep()
      await new Promise(r => setTimeout(r, 10))
    })

    it('executes steps sequentially and passes accumulated output', async () => {
      const step1: StepHandler = async (input) => {
        expect(input).toEqual({ initial: true })
        return { fromStep1: 'value1' }
      }
      const step2: StepHandler = async (input) => {
        expect(input.initial).toBe(true)
        expect(input.fromStep1).toBe('value1')
        return { fromStep2: 'value2' }
      }

      engine.registerWorkflow({
        kind: 'multi-step',
        steps: [
          { key: 'first', handler: step1 },
          { key: 'second', handler: step2 },
        ],
      })

      mockGet.mockReturnValueOnce({ id: 'step-1' }).mockReturnValueOnce({ id: 'step-2' })

      await engine.startRun('multi-step', { initial: true })
      // Give async execution a tick
      await new Promise(r => setTimeout(r, 50))

      // Verify DB updates happened
      expect(mockRun).toHaveBeenCalled()
    })
  })

  describe('cancelRun', () => {
    it('returns false for non-existent run', () => {
      expect(engine.cancelRun('nonexistent')).toBe(false)
    })

    it('aborts an active run', async () => {
      let resolveStep: () => void
      const stepPromise = new Promise<void>(r => { resolveStep = r })

      const handler: StepHandler = async (_input, { abortSignal }) => {
        await stepPromise
        if (abortSignal.aborted) throw new Error('Run canceled')
        return {}
      }

      engine.registerWorkflow({
        kind: 'cancellable',
        steps: [{ key: 'long-step', handler }],
      })

      mockGet.mockReturnValue({ id: 'step-cancel-1' })

      const run = await engine.startRun('cancellable')

      // Wait a tick for execution to start
      await new Promise(r => setTimeout(r, 10))

      const canceled = engine.cancelRun(run.id)
      expect(canceled).toBe(true)

      // Resolve the step to let it complete
      resolveStep!()
      await new Promise(r => setTimeout(r, 50))
    })
  })

  describe('WorkflowSkipped', () => {
    it('marks run as skipped when step throws WorkflowSkipped', async () => {
      const handler: StepHandler = async () => {
        throw new WorkflowSkipped('No changes since last run')
      }

      engine.registerWorkflow({
        kind: 'skippable',
        steps: [{ key: 'check', handler }],
      })

      mockGet.mockReturnValue({ id: 'skip-step-1' })

      const skippedPromise = new Promise<void>(resolve => {
        engine.on('workflow_event', (event: { eventType: string }) => {
          if (event.eventType === 'run_skipped') resolve()
        })
      })

      await engine.startRun('skippable')
      await skippedPromise

      // If we get here, the run_skipped event was emitted
      expect(true).toBe(true)
    })
  })

  describe('step failure', () => {
    it('marks run as failed when step throws', async () => {
      const handler: StepHandler = async () => {
        throw new Error('step exploded')
      }

      engine.registerWorkflow({
        kind: 'failing',
        steps: [{ key: 'boom', handler }],
      })

      mockGet.mockReturnValue({ id: 'fail-step-1' })

      await engine.startRun('failing')
      await new Promise(r => setTimeout(r, 50))

      // Verify step was marked failed
      expect(mockRun).toHaveBeenCalled()
    })

    it('skips remaining steps after failure', async () => {
      const step1: StepHandler = async () => { throw new Error('fail') }
      const step2: StepHandler = vi.fn(async () => ({}))

      engine.registerWorkflow({
        kind: 'fail-skip',
        steps: [
          { key: 'step1', handler: step1 },
          { key: 'step2', handler: step2 },
        ],
      })

      mockGet.mockReturnValueOnce({ id: 'fs-1' })

      await engine.startRun('fail-skip')
      await new Promise(r => setTimeout(r, 50))

      // step2 handler should never be called
      expect(step2).not.toHaveBeenCalled()
    })
  })

  describe('afterRun hook', () => {
    it('calls afterRun on success', async () => {
      const afterRun = vi.fn()
      engine.registerWorkflow({
        kind: 'with-hook',
        steps: [{ key: 'step1', handler: async () => ({ done: true }) }],
        afterRun,
      })

      mockGet.mockReturnValue({ id: 'hook-step-1' })

      await engine.startRun('with-hook')
      await new Promise(r => setTimeout(r, 50))

      expect(afterRun).toHaveBeenCalledWith(expect.objectContaining({ kind: 'with-hook' }))
    })

    it('calls afterRun even on failure', async () => {
      const afterRun = vi.fn()
      engine.registerWorkflow({
        kind: 'fail-hook',
        steps: [{ key: 'step1', handler: async () => { throw new Error('oops') } }],
        afterRun,
      })

      mockGet.mockReturnValue({ id: 'fh-step-1' })

      await engine.startRun('fail-hook')
      await new Promise(r => setTimeout(r, 50))

      expect(afterRun).toHaveBeenCalled()
    })

    it('handles afterRun errors gracefully', async () => {
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      engine.registerWorkflow({
        kind: 'broken-hook',
        steps: [{ key: 'step1', handler: async () => ({}) }],
        afterRun: async () => { throw new Error('hook failed') },
      })

      mockGet.mockReturnValue({ id: 'bh-step-1' })

      await engine.startRun('broken-hook')
      await new Promise(r => setTimeout(r, 50))

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('afterRun hook error'), expect.any(Error))
      consoleSpy.mockRestore()
    })
  })

  describe('events', () => {
    it('emits workflow events during execution', async () => {
      const events: string[] = []
      engine.on('workflow_event', (e) => events.push(e.eventType))

      engine.registerWorkflow({
        kind: 'event-test',
        steps: [{ key: 'step1', handler: async () => ({}) }],
      })

      mockGet.mockReturnValue({ id: 'ev-step-1' })

      await engine.startRun('event-test')
      await new Promise(r => setTimeout(r, 50))

      expect(events).toContain('run_queued')
      expect(events).toContain('run_started')
      expect(events).toContain('step_started')
      expect(events).toContain('step_succeeded')
      expect(events).toContain('run_succeeded')
    })

    it('emits run_failed on step failure', async () => {
      const events: string[] = []
      engine.on('workflow_event', (e) => events.push(e.eventType))

      engine.registerWorkflow({
        kind: 'fail-event',
        steps: [{ key: 'step1', handler: async () => { throw new Error('fail') } }],
      })

      mockGet.mockReturnValue({ id: 'fe-step-1' })

      await engine.startRun('fail-event')
      await new Promise(r => setTimeout(r, 50))

      expect(events).toContain('step_failed')
      expect(events).toContain('run_failed')
    })
  })

  describe('schedule management', () => {
    it('upserts a new schedule', () => {
      mockGet.mockReturnValueOnce(undefined) // no existing schedule

      const schedule = engine.upsertSchedule({
        id: 'sched-1',
        kind: 'test',
        cronExpression: '0 6 * * *',
        input: {},
        enabled: true,
      })

      expect(schedule.id).toBe('sched-1')
      expect(schedule.kind).toBe('test')
      expect(schedule.nextRunAt).toBeTruthy()
      expect(mockRun).toHaveBeenCalled()
    })

    it('updates an existing schedule', () => {
      mockGet.mockReturnValueOnce({ id: 'sched-existing' }) // existing

      engine.upsertSchedule({
        id: 'sched-existing',
        kind: 'test',
        cronExpression: '0 12 * * *',
        input: {},
        enabled: true,
      })

      expect(mockRun).toHaveBeenCalled()
    })

    it('sets nextRunAt to null when disabled', () => {
      mockGet.mockReturnValueOnce(undefined)

      const schedule = engine.upsertSchedule({
        id: 'disabled-sched',
        kind: 'test',
        cronExpression: '0 6 * * *',
        input: {},
        enabled: false,
      })

      expect(schedule.nextRunAt).toBeNull()
    })

    it('deletes a schedule', () => {
      mockRun.mockReturnValueOnce({ changes: 1 })
      expect(engine.deleteSchedule('sched-1')).toBe(true)

      mockRun.mockReturnValueOnce({ changes: 0 })
      expect(engine.deleteSchedule('nonexistent')).toBe(false)
    })

    it('lists schedules', () => {
      mockAll.mockReturnValueOnce([{
        id: 's1',
        kind: 'test',
        cron_expression: '0 6 * * *',
        input: '{}',
        enabled: 1,
        last_run_at: null,
        next_run_at: '2026-03-09T06:00:00.000Z',
      }])

      const schedules = engine.listSchedules()
      expect(schedules).toHaveLength(1)
      expect(schedules[0].id).toBe('s1')
      expect(schedules[0].enabled).toBe(true)
      expect(schedules[0].cronExpression).toBe('0 6 * * *')
    })

    it('gets a single schedule', () => {
      mockGet.mockReturnValueOnce({
        id: 's1',
        kind: 'test',
        cron_expression: '0 6 * * *',
        input: '{}',
        enabled: 1,
        last_run_at: null,
        next_run_at: null,
      })

      const schedule = engine.getSchedule('s1')
      expect(schedule).toBeDefined()
      expect(schedule!.id).toBe('s1')
    })

    it('returns null for non-existent schedule', () => {
      mockGet.mockReturnValueOnce(undefined)
      expect(engine.getSchedule('nonexistent')).toBeNull()
    })
  })

  describe('triggerSchedule', () => {
    it('throws for non-existent schedule', async () => {
      mockGet.mockReturnValueOnce(undefined)
      await expect(engine.triggerSchedule('nonexistent')).rejects.toThrow('Schedule not found')
    })
  })

  describe('listRuns', () => {
    it('returns parsed runs', () => {
      mockAll.mockReturnValueOnce([{
        id: 'run-1',
        kind: 'test',
        status: 'succeeded',
        input: '{"foo":"bar"}',
        output: '{"result":"ok"}',
        error: null,
        created_at: '2026-03-08T00:00:00.000Z',
        started_at: '2026-03-08T00:00:01.000Z',
        completed_at: '2026-03-08T00:00:02.000Z',
      }])

      const runs = engine.listRuns()
      expect(runs).toHaveLength(1)
      expect(runs[0].input).toEqual({ foo: 'bar' })
      expect(runs[0].output).toEqual({ result: 'ok' })
    })

    it('filters by kind and status', () => {
      mockAll.mockReturnValueOnce([])
      engine.listRuns({ kind: 'test', status: 'failed', limit: 10, offset: 5 })
      // Verify the SQL was called (we can check prepare was called)
      expect(mockAll).toHaveBeenCalled()
    })
  })

  describe('getRun', () => {
    it('returns null for non-existent run', () => {
      mockGet.mockReturnValueOnce(undefined)
      expect(engine.getRun('nonexistent')).toBeNull()
    })

    it('returns run with steps', () => {
      mockGet.mockReturnValueOnce({
        id: 'run-1',
        kind: 'test',
        status: 'succeeded',
        input: '{}',
        output: '{"result":"ok"}',
        error: null,
        created_at: '2026-03-08T00:00:00.000Z',
        started_at: '2026-03-08T00:00:01.000Z',
        completed_at: '2026-03-08T00:00:02.000Z',
      })
      mockAll.mockReturnValueOnce([{
        id: 'step-1',
        run_id: 'run-1',
        key: 'step1',
        status: 'succeeded',
        input: '{}',
        output: '{"data":1}',
        error: null,
        started_at: '2026-03-08T00:00:01.000Z',
        completed_at: '2026-03-08T00:00:02.000Z',
      }])

      const run = engine.getRun('run-1')
      expect(run).toBeDefined()
      expect(run!.steps).toHaveLength(1)
      expect(run!.steps[0].output).toEqual({ data: 1 })
    })
  })

  describe('resumeInterrupted', () => {
    it('marks running runs without resumable step as failed on startup', async () => {
      // Two interrupted runs; neither has a resumable current_step_key, so both fail loudly.
      mockAll.mockReturnValueOnce([
        { id: 'interrupted-1', kind: 'unregistered', session_id: null, current_step_key: 'validate_repo', last_step_at: null, input: '{}' },
        { id: 'interrupted-2', kind: 'unregistered', session_id: null, current_step_key: 'create_session', last_step_at: null, input: '{}' },
      ])

      await engine.resumeInterrupted()

      // Should have called update for each interrupted run
      expect(mockRun).toHaveBeenCalled()
    })

    it('does nothing when no interrupted runs', async () => {
      mockAll.mockReturnValueOnce([])
      const callsBefore = mockRun.mock.calls.length
      await engine.resumeInterrupted()
      // No new update calls
      expect(mockRun.mock.calls.length).toBe(callsBefore)
    })

    it('resumes a mid-run_prompt run by re-executing the in-flight step with resumed=true', async () => {
      // Workflow with the four real step keys so resumeInterrupted recognises run_prompt as resumable.
      const validate: StepHandler = vi.fn(async () => ({ ok: true }))
      const createSession: StepHandler = vi.fn(async () => ({ sessionId: 'sess-A' }))
      const runPromptCalls: Array<{ resumed: boolean | undefined }> = []
      const runPrompt: StepHandler = vi.fn(async (_input, ctx) => {
        runPromptCalls.push({ resumed: ctx.resumed })
        return { reportText: 'final report' }
      })
      const saveReport: StepHandler = vi.fn(async () => ({ filePath: '/tmp/report.md' }))

      engine.registerWorkflow({
        kind: 'restart-resume',
        steps: [
          { key: 'validate_repo', handler: validate },
          { key: 'create_session', handler: createSession },
          { key: 'run_prompt', handler: runPrompt },
          { key: 'save_report', handler: saveReport },
        ],
      })

      // Simulate a session that survived the crash: resolver returns liveness info.
      engine.setSessionResolver(() => ({ lastActivityAt: '2026-04-26T10:25:00.000Z' }))

      // 1) Interrupted-runs scan.
      mockAll.mockReturnValueOnce([{
        id: 'run-resume-1',
        kind: 'restart-resume',
        session_id: 'sess-A',
        current_step_key: 'run_prompt',
        last_step_at: '2026-04-26T10:30:00.000Z',
        input: '{}',
      }])

      // 2) getRun() body: row + steps for the run.
      mockGet.mockImplementationOnce(() => ({
        id: 'run-resume-1',
        kind: 'restart-resume',
        status: 'running',
        input: '{}',
        output: null,
        error: null,
        created_at: '2026-04-26T10:20:00.000Z',
        started_at: '2026-04-26T10:21:00.000Z',
        completed_at: null,
        session_id: 'sess-A',
        last_step_at: '2026-04-26T10:30:00.000Z',
        current_step_key: 'run_prompt',
      }))
      // 3) Step rows for getRun() AND for prior-output reconstruction.
      const stepRowsForResume = [
        { id: 's1', run_id: 'run-resume-1', key: 'validate_repo', status: 'succeeded', input: '{}', output: '{"ok":true}', error: null, started_at: null, completed_at: null },
        { id: 's2', run_id: 'run-resume-1', key: 'create_session', status: 'succeeded', input: '{}', output: '{"sessionId":"sess-A"}', error: null, started_at: null, completed_at: null },
        { id: 's3', run_id: 'run-resume-1', key: 'run_prompt', status: 'running', input: '{}', output: null, error: null, started_at: null, completed_at: null },
        { id: 's4', run_id: 'run-resume-1', key: 'save_report', status: 'pending', input: null, output: null, error: null, started_at: null, completed_at: null },
      ]
      mockAll.mockReturnValueOnce(stepRowsForResume) // prior-output reconstruction
      mockAll.mockReturnValueOnce(stepRowsForResume) // getRun() steps

      // 4) Per-step lookups inside executeRun for run_prompt + save_report.
      mockGet.mockImplementation(() => ({ id: 'step-resumed' }))

      await engine.resumeInterrupted()
      // Yield so the fire-and-forget executeRun can complete.
      await new Promise(r => setTimeout(r, 30))

      // The earlier steps must NOT be re-run — that's the whole point of resume.
      expect(validate).not.toHaveBeenCalled()
      expect(createSession).not.toHaveBeenCalled()
      // run_prompt is the in-flight step — it runs with resumed=true.
      expect(runPrompt).toHaveBeenCalledTimes(1)
      expect(runPromptCalls[0].resumed).toBe(true)
      // save_report continues normally afterwards.
      expect(saveReport).toHaveBeenCalledTimes(1)
    })

    it('fails with a typed SessionGoneError reason when the session is gone before resume', async () => {
      const handler: StepHandler = vi.fn(async () => ({}))
      engine.registerWorkflow({
        kind: 'orphan-resume',
        steps: [
          { key: 'validate_repo', handler },
          { key: 'create_session', handler },
          { key: 'run_prompt', handler },
          { key: 'save_report', handler },
        ],
      })

      // Resolver returns null → session no longer exists.
      engine.setSessionResolver(() => null)

      mockAll.mockReturnValueOnce([{
        id: 'run-orphan-1',
        kind: 'orphan-resume',
        session_id: 'sess-gone',
        current_step_key: 'run_prompt',
        last_step_at: '2026-04-26T10:40:00.000Z',
        input: '{}',
      }])
      // failInterrupted's lookup for the event payload.
      mockGet.mockReturnValueOnce({ id: 'run-orphan-1', kind: 'orphan-resume' })

      const events: Array<{ eventType: string; runId: string }> = []
      engine.on('workflow_event', (e) => events.push(e))

      await engine.resumeInterrupted()
      // Yield so failInterrupted's emit propagates.
      await new Promise(r => setTimeout(r, 5))

      // The handler must NOT be invoked — we should never silently rerun the prompt.
      expect(handler).not.toHaveBeenCalled()

      // Find the UPDATE that wrote the failure reason on the run row.
      const failedRunUpdate = mockRun.mock.calls.find(call => {
        const reason = call[0]
        return typeof reason === 'string'
          && reason.includes('Workflow session is no longer available')
          && reason.includes('session=sess-gone')
          && reason.includes('step=run_prompt')
      })
      expect(failedRunUpdate).toBeDefined()
      // Confirm event surface so UI sees the failure (vs silently skipping).
      expect(events.some(e => e.eventType === 'run_failed' && e.runId === 'run-orphan-1')).toBe(true)
    })

    it('does NOT throw a bare stack trace — SessionGoneError is a real Error subclass', () => {
      const err = new SessionGoneError('run-x', 'run_prompt', 'sess-y', '2026-04-26T10:00:00.000Z')
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('SessionGoneError')
      expect(err.runId).toBe('run-x')
      expect(err.stepKey).toBe('run_prompt')
      expect(err.sessionId).toBe('sess-y')
      expect(err.lastSeen).toBe('2026-04-26T10:00:00.000Z')
      expect(err.message).toContain('run=run-x')
      expect(err.message).toContain('step=run_prompt')
      expect(err.message).toContain('session=sess-y')
    })
  })

  describe('recordSessionId', () => {
    it('persists the session id atomically on the workflow_runs row', () => {
      engine.recordSessionId('run-1', 'sess-1')
      // Verify the UPDATE was executed with the right values.
      const sessionIdWrite = mockRun.mock.calls.find(call => call[0] === 'sess-1' && call[1] === 'run-1')
      expect(sessionIdWrite).toBeDefined()
    })

    it('is exposed to step handlers via context.recordSessionId', async () => {
      let receivedRecorder: ((sessionId: string) => void) | undefined
      const handler: StepHandler = async (_input, ctx) => {
        receivedRecorder = ctx.recordSessionId
        ctx.recordSessionId?.('sess-from-handler')
        return { sessionId: 'sess-from-handler' }
      }
      engine.registerWorkflow({
        kind: 'record-id',
        steps: [{ key: 'create_session', handler }],
      })
      mockGet.mockReturnValue({ id: 'step-rec-1' })

      await engine.startRun('record-id')
      await new Promise(r => setTimeout(r, 30))

      expect(receivedRecorder).toBeTypeOf('function')
      // Verify the recordSessionId write actually happened.
      const recorded = mockRun.mock.calls.find(call => call[0] === 'sess-from-handler')
      expect(recorded).toBeDefined()
    })
  })

  describe('heartbeat', () => {
    it('updates last_step_at and current_step_key on every step start', async () => {
      const handler: StepHandler = async () => ({})
      engine.registerWorkflow({
        kind: 'heartbeat',
        steps: [
          { key: 'validate_repo', handler },
          { key: 'create_session', handler },
        ],
      })
      mockGet.mockReturnValue({ id: 'step-hb' })

      await engine.startRun('heartbeat')
      await new Promise(r => setTimeout(r, 30))

      // Find the UPDATE writes that pushed step keys onto workflow_runs.
      const validateBeat = mockRun.mock.calls.find(call => call[1] === 'validate_repo')
      const createBeat = mockRun.mock.calls.find(call => call[1] === 'create_session')
      expect(validateBeat).toBeDefined()
      expect(createBeat).toBeDefined()
    })
  })

  describe('cron scheduler', () => {
    it('starts and stops the cron scheduler', () => {
      vi.useFakeTimers()
      mockAll.mockReturnValue([]) // no schedules

      engine.startCronScheduler()
      // Starting again should be a no-op
      engine.startCronScheduler()

      engine.stopCronScheduler()
      // Stopping again should be a no-op
      engine.stopCronScheduler()

      vi.useRealTimers()
    })
  })

  describe('shutdown', () => {
    it('stops cron and closes database', () => {
      engine.shutdown()
      // Should not throw on double shutdown
    })

    it('cancels all active runs via abort controllers', async () => {
      let resolveStep!: () => void
      const handler: StepHandler = async (_input, { abortSignal }) => {
        await new Promise<void>(r => { resolveStep = r })
        if (abortSignal.aborted) throw new Error('Run canceled')
        return {}
      }

      engine.registerWorkflow({
        kind: 'shutdown-cancel',
        steps: [{ key: 'blocking', handler }],
      })

      mockGet.mockReturnValue({ id: 'sc-step-1' })

      const run = await engine.startRun('shutdown-cancel')
      // Wait a tick for execution to start
      await new Promise(r => setTimeout(r, 10))

      expect(run.status).toBe('running')

      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

      // Shutdown should abort the active run's controller
      engine.shutdown()

      expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('Canceling active run'))
      expect(consoleSpy).toHaveBeenCalledWith('[workflow] Engine shut down')
      consoleSpy.mockRestore()

      // Resolve the step so the async handler finishes cleanly
      resolveStep()
      await new Promise(r => setTimeout(r, 50))
    })
  })
})

describe('singleton lifecycle', () => {
  afterEach(() => {
    shutdownWorkflowEngine()
  })

  it('getWorkflowEngine throws before init', () => {
    expect(() => getWorkflowEngine()).toThrow('Workflow engine not initialized — call initWorkflowEngine() first')
  })

  it('initWorkflowEngine creates an instance', () => {
    const engine = initWorkflowEngine()
    expect(engine).toBeInstanceOf(WorkflowEngine)
  })

  it('initWorkflowEngine returns same instance on second call', () => {
    const first = initWorkflowEngine()
    const second = initWorkflowEngine()
    expect(second).toBe(first)
  })

  it('getWorkflowEngine returns the instance after init', () => {
    const created = initWorkflowEngine()
    const retrieved = getWorkflowEngine()
    expect(retrieved).toBe(created)
  })

  it('shutdownWorkflowEngine shuts it down', () => {
    initWorkflowEngine()
    shutdownWorkflowEngine()
    // After shutdown, getWorkflowEngine should throw again
    expect(() => getWorkflowEngine()).toThrow('Workflow engine not initialized')
  })

  it('shutdownWorkflowEngine is a no-op when already shut down', () => {
    // No engine initialized — should not throw
    expect(() => shutdownWorkflowEngine()).not.toThrow()
  })
})

describe('WorkflowSkipped', () => {
  it('has correct name and message', () => {
    const err = new WorkflowSkipped('no changes')
    expect(err.name).toBe('WorkflowSkipped')
    expect(err.message).toBe('no changes')
    expect(err).toBeInstanceOf(Error)
  })
})
