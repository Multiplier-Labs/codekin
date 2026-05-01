/** Tests for the shared orchestrator notification helper — verifies that
 * the message is correctly formatted and that delivery is gated on the
 * recipient session's Claude process being alive. */
import { describe, it, expect, vi } from 'vitest'

vi.mock('./config.js', () => ({
  getAgentDisplayName: () => 'TestAgent',
  PORT: 32352,
  DATA_DIR: '/tmp/codekin-test',
}))

import { sendOrchestratorNotification } from './orchestrator-notify.js'

function makeSessions(opts: {
  exists: boolean
  alive: boolean
}) {
  const sentInputs: Array<{ id: string; data: string }> = []
  const session = opts.exists
    ? {
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

describe('sendOrchestratorNotification', () => {
  it('formats and sends the message when the parent process is alive', () => {
    const sessions = makeSessions({ exists: true, alive: true })
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'parent-id',
      label: 'Child Session Stopped',
      title: 'Session: testagent:fix/foo (abc)',
      body: 'Status: completed\nBranch: fix/foo',
    })

    expect(ok).toBe(true)
    expect(sessions.sendInput).toHaveBeenCalledTimes(1)
    const sent = sessions._sentInputs[0]
    expect(sent.id).toBe('parent-id')
    expect(sent.data).toBe(
      '[Agent TestAgent Notification — Child Session Stopped]\n' +
        'Session: testagent:fix/foo (abc)\n' +
        'Status: completed\nBranch: fix/foo',
    )
  })

  it('returns false and does not send when the parent session is missing', () => {
    const sessions = makeSessions({ exists: false, alive: false })
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'missing-id',
      label: 'Child Session Stopped',
      title: 'x',
      body: 'y',
    })

    expect(ok).toBe(false)
    expect(sessions.sendInput).not.toHaveBeenCalled()
  })

  it('returns false and does not send when the parent process is not alive', () => {
    const sessions = makeSessions({ exists: true, alive: false })
    const ok = sendOrchestratorNotification(sessions, {
      parentSessionId: 'parent-id',
      label: 'Child Session Stopped',
      title: 'x',
      body: 'y',
    })

    expect(ok).toBe(false)
    expect(sessions.sendInput).not.toHaveBeenCalled()
  })
})
