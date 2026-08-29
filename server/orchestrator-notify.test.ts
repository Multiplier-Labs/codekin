/** Tests for the shared orchestrator notification helper — verifies that
 * the message is correctly formatted, delivered when the recipient session's
 * Claude process is alive, and queued in the outbox otherwise. */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./config.js', () => ({
  getAgentDisplayName: () => 'TestAgent',
  PORT: 32352,
  DATA_DIR: '/tmp/codekin-test',
}))

// All tests inject their own outbox; mock the module so importing it does not
// drag in orchestrator-manager (which reads config constants at load time).
vi.mock('./orchestrator-outbox.js', () => ({
  getOrchestratorOutbox: () => ({ enqueue: () => {} }),
}))

import { sendOrchestratorNotification, type NotificationOutbox } from './orchestrator-notify.js'

function makeSessions(opts: {
  exists: boolean
  alive: boolean
  isProcessing?: boolean
}) {
  const sentInputs: Array<{ id: string; data: string }> = []
  const session = opts.exists
    ? {
        isProcessing: opts.isProcessing ?? false,
        claudeProcess: opts.alive
          ? { isAlive: vi.fn(() => true) }
          : { isAlive: vi.fn(() => false) },
      }
    : null

  return {
    get: vi.fn(() => session),
    sendInput: vi.fn((id: string, data: string) => { sentInputs.push({ id, data }) }),
    _sentInputs: sentInputs,
  } as any
}

function makeOutbox(): NotificationOutbox & { enqueue: ReturnType<typeof vi.fn> } {
  return { enqueue: vi.fn() }
}

describe('sendOrchestratorNotification', () => {
  it('formats and sends the message when the parent process is alive', () => {
    const sessions = makeSessions({ exists: true, alive: true })
    const outbox = makeOutbox()
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'parent-id',
      label: 'Child Session Stopped',
      title: 'Session: testagent:fix/foo (abc)',
      body: 'Status: completed\nBranch: fix/foo',
    }, outbox)

    expect(ok).toBe(true)
    expect(sessions.sendInput).toHaveBeenCalledTimes(1)
    expect(outbox.enqueue).not.toHaveBeenCalled()
    const sent = sessions._sentInputs[0]
    expect(sent.id).toBe('parent-id')
    expect(sent.data).toBe(
      '[Agent TestAgent Notification — Child Session Stopped]\n' +
        'Session: testagent:fix/foo (abc)\n' +
        'Status: completed\nBranch: fix/foo',
    )
  })

  it('queues to the outbox instead of injecting mid-turn (A5)', () => {
    const sessions = makeSessions({ exists: true, alive: true, isProcessing: true })
    const outbox = makeOutbox()
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'parent-id',
      label: 'ACTION',
      title: 'busy parent',
      body: 'must not be interrupted',
    }, outbox)

    expect(ok).toBe(true)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(outbox.enqueue).toHaveBeenCalledWith({ label: 'ACTION', title: 'busy parent', body: 'must not be interrupted' })
  })

  it('queues to the outbox and returns true when the parent session is missing', () => {
    const sessions = makeSessions({ exists: false, alive: false })
    const outbox = makeOutbox()
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'missing-id',
      label: 'Child Session Stopped',
      title: 'x',
      body: 'y',
    }, outbox)

    expect(ok).toBe(true)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(outbox.enqueue).toHaveBeenCalledTimes(1)
    expect(outbox.enqueue).toHaveBeenCalledWith({
      label: 'Child Session Stopped',
      title: 'x',
      body: 'y',
    })
  })

  it('queues to the outbox and returns true when the parent process is not alive', () => {
    const sessions = makeSessions({ exists: true, alive: false })
    const outbox = makeOutbox()
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'parent-id',
      label: 'Child Session Stopped',
      title: 'x',
      body: 'y',
    }, outbox)

    expect(ok).toBe(true)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(outbox.enqueue).toHaveBeenCalledTimes(1)
  })

  it('returns false when queueing itself fails', () => {
    const sessions = makeSessions({ exists: false, alive: false })
    const outbox: NotificationOutbox = {
      enqueue: vi.fn(() => { throw new Error('disk full') }),
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'missing-id',
      label: 'ALERT',
      title: 'x',
      body: 'y',
    }, outbox)
    warnSpy.mockRestore()

    expect(ok).toBe(false)
    expect(sessions.sendInput).not.toHaveBeenCalled()
  })
})
