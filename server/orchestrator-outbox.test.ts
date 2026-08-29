/** Tests for the persistent orchestrator notification outbox — covers
 * enqueue/persist/load round-trips, the queue cap, flush gating (empty,
 * rate-limited, orchestrator missing or not alive), digest formatting,
 * and the clear-before-send double-delivery guard. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

vi.mock('./config.js', () => ({
  getAgentDisplayName: () => 'TestAgent',
  DATA_DIR: '/tmp/codekin-test',
}))

const getOrchestratorSessionIdMock = vi.fn<() => string | null>(() => 'orch-id')
vi.mock('./orchestrator-manager.js', () => ({
  getOrchestratorSessionId: (...args: unknown[]) => getOrchestratorSessionIdMock(...args as []),
}))

import { OrchestratorOutbox } from './orchestrator-outbox.js'

function makeSessions(opts: { alive?: boolean; rateLimited?: boolean; isProcessing?: boolean } = {}) {
  const { alive = true, rateLimited = false, isProcessing = false } = opts
  const sentInputs: Array<{ id: string; data: string }> = []
  return {
    isRateLimited: vi.fn(() => rateLimited),
    get: vi.fn(() => ({
      isProcessing,
      claudeProcess: { isAlive: vi.fn(() => alive) },
    })),
    sendInput: vi.fn((id: string, data: string) => { sentInputs.push({ id, data }) }),
    _sentInputs: sentInputs,
  } as any
}

let dir: string
let filePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-test-'))
  filePath = join(dir, 'sub', 'outbox.json')
  getOrchestratorSessionIdMock.mockReturnValue('orch-id')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('OrchestratorOutbox', () => {
  it('persists enqueued items and reloads them in a new instance', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'ALERT', title: 'Workflow failed', body: 'Run x failed' })
    outbox.enqueue({ label: 'INFO', title: 'Repo passive', body: 'No activity' })

    expect(outbox.size()).toBe(2)
    expect(existsSync(filePath)).toBe(true)

    const reloaded = new OrchestratorOutbox(filePath)
    expect(reloaded.size()).toBe(2)
  })

  it('starts empty when the file is corrupt', () => {
    writeFileSync(join(dir, 'corrupt.json'), 'not json', 'utf-8')
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const outbox = new OrchestratorOutbox(join(dir, 'corrupt.json'))
    warnSpy.mockRestore()
    expect(outbox.size()).toBe(0)
  })

  it('drops oldest items beyond the 200-item cap', () => {
    const outbox = new OrchestratorOutbox(filePath)
    for (let i = 0; i < 205; i++) {
      outbox.enqueue({ label: 'INFO', title: `item-${i}`, body: 'b' })
    }
    expect(outbox.size()).toBe(200)
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as Array<{ title: string }>
    expect(raw[0].title).toBe('item-5')
    expect(raw[199].title).toBe('item-204')
  })

  it('flush is a no-op when the queue is empty', () => {
    const outbox = new OrchestratorOutbox(filePath)
    const sessions = makeSessions()
    expect(outbox.flush(sessions)).toBe(0)
    expect(sessions.sendInput).not.toHaveBeenCalled()
  })

  it('flush is a no-op when rate-limited', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'INFO', title: 't', body: 'b' })
    const sessions = makeSessions({ rateLimited: true })
    expect(outbox.flush(sessions)).toBe(0)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(outbox.size()).toBe(1)
  })

  it('flush is a no-op when the orchestrator session is missing', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'INFO', title: 't', body: 'b' })
    getOrchestratorSessionIdMock.mockReturnValue(null)
    const sessions = makeSessions()
    expect(outbox.flush(sessions)).toBe(0)
    expect(outbox.size()).toBe(1)
  })

  it('flush is a no-op when the orchestrator process is not alive', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'INFO', title: 't', body: 'b' })
    const sessions = makeSessions({ alive: false })
    expect(outbox.flush(sessions)).toBe(0)
    expect(outbox.size()).toBe(1)
  })

  it('flush holds the digest while the orchestrator is mid-turn (A5)', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'ACTION', title: 't', body: 'b' })
    const sessions = makeSessions({ isProcessing: true })

    expect(outbox.flush(sessions)).toBe(0)
    expect(sessions.sendInput).not.toHaveBeenCalled()

    // Next tick after the turn ends: delivered.
    expect(outbox.flush(makeSessions())).toBe(1)
  })

  it('flush delivers a single-item digest with the original label', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'ALERT', title: 'Workflow failed', body: 'Run x failed' })
    const sessions = makeSessions()

    expect(outbox.flush(sessions)).toBe(1)
    expect(sessions.sendInput).toHaveBeenCalledTimes(1)
    const sent = sessions._sentInputs[0]
    expect(sent.id).toBe('orch-id')
    expect(sent.data).toBe(
      '[Agent TestAgent Notification — ALERT (queued while you were away)]\n' +
        'Workflow failed\nRun x failed',
    )
    expect(outbox.size()).toBe(0)
  })

  it('flush delivers a multi-item digest with per-item sections', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'ALERT', title: 'a-title', body: 'a-body' })
    outbox.enqueue({ label: 'INFO', title: 'b-title', body: 'b-body' })
    const sessions = makeSessions()

    expect(outbox.flush(sessions)).toBe(2)
    const sent = sessions._sentInputs[0].data
    expect(sent).toContain('[Agent TestAgent Notifications — 2 queued while you were away]')
    expect(sent).toContain('--- [ALERT]')
    expect(sent).toContain('a-title\na-body')
    expect(sent).toContain('--- [INFO]')
    expect(sent).toContain('b-title\nb-body')
  })

  it('clears the queue and file before sending so a throwing sendInput cannot double-deliver', () => {
    const outbox = new OrchestratorOutbox(filePath)
    outbox.enqueue({ label: 'INFO', title: 't', body: 'b' })
    const sessions = makeSessions()
    sessions.sendInput.mockImplementation(() => { throw new Error('boom') })

    expect(() => outbox.flush(sessions)).toThrow('boom')
    expect(outbox.size()).toBe(0)
    const raw = JSON.parse(readFileSync(filePath, 'utf-8')) as unknown[]
    expect(raw).toEqual([])
  })

  it('startFlusher periodically flushes and stopFlusher stops it', () => {
    vi.useFakeTimers()
    try {
      const outbox = new OrchestratorOutbox(filePath)
      outbox.enqueue({ label: 'INFO', title: 't', body: 'b' })
      const sessions = makeSessions()

      outbox.startFlusher(sessions, 1000)
      vi.advanceTimersByTime(1000)
      expect(sessions.sendInput).toHaveBeenCalledTimes(1)

      outbox.enqueue({ label: 'INFO', title: 't2', body: 'b2' })
      outbox.stopFlusher()
      vi.advanceTimersByTime(5000)
      expect(sessions.sendInput).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
