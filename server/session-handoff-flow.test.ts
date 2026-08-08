/**
 * Carry-context provider switch flow: handoff generation on setProvider and
 * injection into the first message under the new provider.
 * handoff-manager is mocked — its own behavior is covered in
 * handoff-manager.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionManager } from './session-manager.js'
import type { Handoff } from './handoff-manager.js'

const mocks = vi.hoisted(() => ({
  generateHandoff: vi.fn(),
  buildHandoffInjection: vi.fn((h: Handoff) => `[HANDOFF from ${h.sourceHarness}]\n${h.content}\n[End of handoff]`),
}))

vi.mock('./handoff-manager.js', () => ({
  generateHandoff: mocks.generateHandoff,
  buildHandoffInjection: mocks.buildHandoffInjection,
}))

function fakeProcess(alive = true) {
  return {
    isAlive: vi.fn(() => alive),
    isReady: vi.fn(() => alive),
    stop: vi.fn(),
    start: vi.fn(),
    on: vi.fn(),
    once: vi.fn((_event: string, cb: () => void) => { cb() }),
    removeAllListeners: vi.fn(),
    sendMessage: vi.fn(),
    sendControlResponse: vi.fn(),
    getSessionId: vi.fn(() => 'native-session-id'),
    hasSessionConflict: vi.fn(() => false),
    hadOutput: vi.fn(() => true),
    hasSpawnFailed: vi.fn(() => false),
    waitForExit: vi.fn(() => Promise.resolve()),
    emit: vi.fn(),
  } as any
}

const FAKE_HANDOFF: Handoff = {
  content: '## Goal\nShip the feature.',
  transcriptPath: '/fake/rollout.jsonl',
  sourceHarness: 'codex',
  distilled: true,
  savedPath: null,
}

describe('carry-context provider switch', () => {
  let sm: SessionManager

  beforeEach(() => {
    sm = new SessionManager()
    mocks.generateHandoff.mockReset()
    mocks.buildHandoffInjection.mockClear()
  })

  it('generates a handoff from the pre-switch identity, then switches', async () => {
    const s = sm.create('test', '/repo')
    s.provider = 'codex'
    s.claudeSessionId = 'thread-abc'
    mocks.generateHandoff.mockResolvedValue(FAKE_HANDOFF)

    sm.setProvider(s.id, 'claude', true)
    await vi.waitFor(() => expect(s.pendingHandoff).toBeDefined())

    expect(mocks.generateHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'codex', harnessSessionId: 'thread-abc', workingDir: '/repo' }),
      undefined,
    )
    expect(s.provider).toBe('claude')
    expect(s.claudeSessionId).toBeNull()
    expect(s.pendingHandoff).toEqual(FAKE_HANDOFF)
    // Status lines were recorded for the user
    const notices = s.outputHistory.filter((m) => m.type === 'system_message')
    expect(notices.some((m) => 'text' in m && (m.text as string).includes('Preparing handoff'))).toBe(true)
    expect(notices.some((m) => 'text' in m && (m.text as string).includes('Handoff ready'))).toBe(true)
  })

  it('uses the worktree path as the handoff working dir when present', async () => {
    const s = sm.create('test', '/repo')
    s.worktreePath = '/worktrees/wt-1'
    s.claudeSessionId = 'abc'
    mocks.generateHandoff.mockResolvedValue(FAKE_HANDOFF)

    sm.setProvider(s.id, 'codex', true)
    await vi.waitFor(() => expect(s.provider).toBe('codex'))

    expect(mocks.generateHandoff).toHaveBeenCalledWith(
      expect.objectContaining({ workingDir: '/worktrees/wt-1' }),
      undefined,
    )
  })

  it('still switches provider when no transcript is found', async () => {
    const s = sm.create('test', '/repo')
    s.claudeSessionId = 'abc'
    mocks.generateHandoff.mockResolvedValue(null)

    sm.setProvider(s.id, 'codex', true)
    await vi.waitFor(() => expect(s.provider).toBe('codex'))

    expect(s.pendingHandoff).toBeUndefined()
    const notices = s.outputHistory.filter((m) => m.type === 'system_message')
    expect(notices.some((m) => 'text' in m && (m.text as string).includes('No transcript found'))).toBe(true)
  })

  it('does not generate a handoff without carryContext', () => {
    const s = sm.create('test', '/repo')
    sm.setProvider(s.id, 'codex')
    expect(mocks.generateHandoff).not.toHaveBeenCalled()
    expect(s.provider).toBe('codex')
  })

  it('injects the pending handoff into the next message and clears it', () => {
    const s = sm.create('test', '/repo')
    const cp = fakeProcess(true)
    s.claudeProcess = cp
    s.claudeSessionId = 'live-session'
    s.pendingHandoff = FAKE_HANDOFF

    sm.sendInput(s.id, 'continue the work')

    expect(cp.sendMessage).toHaveBeenCalledTimes(1)
    const sent = cp.sendMessage.mock.calls[0][0] as string
    expect(sent).toContain('[HANDOFF from codex]')
    expect(sent).toContain('## Goal')
    expect(sent.endsWith('continue the work')).toBe(true)
    expect(s.pendingHandoff).toBeUndefined()

    // Second message: no re-injection
    sm.sendInput(s.id, 'and then?')
    expect(cp.sendMessage.mock.calls[1][0]).toBe('and then?')
  })
})
