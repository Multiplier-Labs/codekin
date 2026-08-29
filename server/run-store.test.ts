/** Tests for the unified RunStore — CRUD, ledger ordering, events, and boot-time interrupted recovery. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { RunStore, type RunStoreEvent } from './run-store.js'

let store: RunStore

beforeEach(() => {
  store = new RunStore(':memory:')
})

afterEach(() => {
  store.close()
})

function createAgentRun(id?: string) {
  return store.createRun({
    id,
    engine: 'agent',
    kind: 'child',
    title: 'Fix the flaky test',
    repo: '/srv/repos/example',
    branch: 'fix/flaky',
    spec: { completionPolicy: 'pr' },
    sessionIds: ['sess-1'],
  })
}

describe('RunStore', () => {
  it('creates and reads a run in the unified shape', () => {
    const run = createAgentRun('run-1')
    expect(run).toMatchObject({
      id: 'run-1',
      engine: 'agent',
      kind: 'child',
      status: 'queued',
      title: 'Fix the flaky test',
      branch: 'fix/flaky',
      sessionIds: ['sess-1'],
    })
  })

  it('patches status/error/completion and filters by engine and status', () => {
    const run = createAgentRun()
    store.patchRun(run.id, { status: 'running' })
    store.patchRun(run.id, { status: 'failed', error: 'boom', completedAt: new Date().toISOString() })

    expect(store.getRun(run.id)).toMatchObject({ status: 'failed', error: 'boom' })
    expect(store.listRuns({ engine: 'agent', status: 'failed' })).toHaveLength(1)
    expect(store.listRuns({ engine: 'workflow' })).toHaveLength(0)
  })

  it('appends ledger entries in order with payloads', () => {
    const run = createAgentRun()
    store.appendLedger(run.id, { summary: 'Spawned.' })
    store.appendLedger(run.id, { role: 'system', summary: 'Blocked: waiting on approval.', payload: { tool: 'Bash' } })

    const ledger = store.listLedger(run.id)
    expect(ledger.map((e) => e.entryIndex)).toEqual([0, 1])
    expect(ledger[1].payload).toEqual({ tool: 'Bash' })
  })

  it('emits run_status and ledger events; a throwing listener never breaks a mutation', () => {
    const events: RunStoreEvent[] = []
    store.setEventListener((e) => {
      events.push(e)
      if (events.length === 1) throw new Error('listener boom')
    })
    const run = createAgentRun()
    store.patchRun(run.id, { status: 'running' })
    store.appendLedger(run.id, { summary: 'note' })

    expect(events.map((e) => e.eventType)).toEqual(['run_status', 'run_status', 'ledger'])
    expect(store.getRun(run.id)?.status).toBe('running')
  })

  it('failInterrupted marks non-terminal runs failed and leaves terminal ones alone', () => {
    const stuck = createAgentRun()
    store.patchRun(stuck.id, { status: 'blocked' })
    const done = createAgentRun()
    store.patchRun(done.id, { status: 'succeeded', completedAt: new Date().toISOString() })

    const failed = store.failInterrupted('agent')
    expect(failed).toEqual([stuck.id])
    expect(store.getRun(stuck.id)).toMatchObject({ status: 'failed', error: 'interrupted by server restart' })
    expect(store.getRun(done.id)?.status).toBe('succeeded')
    expect(store.listLedger(stuck.id).some((e) => e.summary.includes('server restart'))).toBe(true)
  })
})
