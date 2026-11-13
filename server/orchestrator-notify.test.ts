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

const orchestratorId = vi.hoisted(() => ({ current: 'orch-id' as string | null }))
vi.mock('./orchestrator-manager.js', () => ({
  getOrchestratorSessionId: () => orchestratorId.current,
  isOrchestratorSession: (source: string | undefined) => source === 'orchestrator',
}))

import { sendOrchestratorNotification, notifyOrchestrator, notifySessionPrompt, type NotificationOutbox } from './orchestrator-notify.js'

function makeSessions(opts: {
  exists: boolean
  alive: boolean
  isProcessing?: boolean
  rateLimited?: boolean
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
    isRateLimited: vi.fn(() => opts.rateLimited ?? false),
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

describe('sendOrchestratorNotification rate limit', () => {
  it('queues instead of sending while the rate-limit breaker is open', () => {
    const sessions = makeSessions({ exists: true, alive: true, rateLimited: true })
    const outbox = makeOutbox()
    expect(sendOrchestratorNotification(sessions, { parentSessionId: 'p', label: 'INFO', title: 't', body: 'b' }, outbox)).toBe(true)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(outbox.enqueue).toHaveBeenCalledWith({ label: 'INFO', title: 't', body: 'b' })
  })
})

describe('notifyOrchestrator', () => {
  it('sends to the configured orchestrator session', () => {
    orchestratorId.current = 'orch-id'
    const sessions = makeSessions({ exists: true, alive: true })
    expect(notifyOrchestrator(sessions, { label: 'ALERT', title: 't', body: 'b' }, makeOutbox())).toBe(true)
    expect(sessions._sentInputs[0].id).toBe('orch-id')
  })

  it('does nothing, and queues nothing, when no orchestrator is configured', () => {
    orchestratorId.current = null
    const sessions = makeSessions({ exists: true, alive: true })
    const outbox = makeOutbox()
    expect(notifyOrchestrator(sessions, { label: 'ALERT', title: 't', body: 'b' }, outbox)).toBe(false)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(outbox.enqueue).not.toHaveBeenCalled()
    orchestratorId.current = 'orch-id'
  })
})

describe('notifySessionPrompt', () => {
  function promptSessions(opts: { source: string; orchestratorBusy: boolean }) {
    const prompting = { name: 'my-session', source: opts.source }
    const orchestrator = { isProcessing: opts.orchestratorBusy, claudeProcess: { isAlive: () => true } }
    return {
      get: vi.fn((id: string) => (id === 'orch-id' ? orchestrator : id === 's1' ? prompting : undefined)),
      isRateLimited: () => false,
      sendInput: vi.fn(),
    } as any
  }
  const none = { isManagedChild: () => false, isLoopSession: () => false }
  const prompt = { sessionId: 's1', promptType: 'permission' as const, toolName: 'Bash', requestId: 'r1' }

  it('holds a manual session\'s prompt in the outbox while the orchestrator is mid-turn', () => {
    const sessions = promptSessions({ source: 'manual', orchestratorBusy: true })
    const outbox = makeOutbox()
    expect(notifySessionPrompt(sessions, none, prompt, outbox)).toBe(true)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(outbox.enqueue).toHaveBeenCalledWith(expect.objectContaining({
      label: 'Session Needs Approval',
      title: 'my-session (s1)',
      body: expect.stringContaining('Request ID: r1'),
    }))
  })

  it('sends right away when the orchestrator is idle', () => {
    const sessions = promptSessions({ source: 'manual', orchestratorBusy: false })
    expect(notifySessionPrompt(sessions, none, { ...prompt, promptType: 'question' }, makeOutbox())).toBe(true)
    expect(sessions.sendInput).toHaveBeenCalledWith('orch-id', expect.stringContaining('Notification — Session Needs Answer]\nmy-session (s1)'))
  })

  it('skips the orchestrator\'s own prompts, managed children and loop sessions', () => {
    const outbox = makeOutbox()
    const own = promptSessions({ source: 'orchestrator', orchestratorBusy: false })
    expect(notifySessionPrompt(own, none, prompt, outbox)).toBe(false)
    const sessions = promptSessions({ source: 'agent', orchestratorBusy: false })
    expect(notifySessionPrompt(sessions, { ...none, isManagedChild: () => true }, prompt, outbox)).toBe(false)
    expect(notifySessionPrompt(sessions, { ...none, isLoopSession: () => true }, prompt, outbox)).toBe(false)
    expect(notifySessionPrompt(sessions, none, { ...prompt, sessionId: 'gone' }, outbox)).toBe(false)
    expect(sessions.sendInput).not.toHaveBeenCalled()
    expect(own.sendInput).not.toHaveBeenCalled()
    expect(outbox.enqueue).not.toHaveBeenCalled()
  })
})
