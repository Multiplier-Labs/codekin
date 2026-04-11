/** Tests for evaluateRestart — pure restart decision logic. */
import { describe, it, expect } from 'vitest'
import { evaluateRestart, type RestartState } from './session-restart-scheduler.js'

function makeState(overrides: Partial<RestartState> = {}): RestartState {
  return {
    restartCount: 0,
    lastRestartAt: null,
    stoppedByUser: false,
    exitCode: null,
    exitSignal: null,
    ...overrides,
  }
}

describe('evaluateRestart', () => {
  it('returns stopped_by_user when stoppedByUser is true', () => {
    const action = evaluateRestart(makeState({ stoppedByUser: true }))
    expect(action.kind).toBe('stopped_by_user')
  })

  it('returns restart on first unexpected exit', () => {
    const action = evaluateRestart(makeState())
    expect(action).toMatchObject({
      kind: 'restart',
      attempt: 1,
      maxAttempts: 3,
      updatedCount: 1,
    })
  })

  it('returns exhausted after max restarts', () => {
    const action = evaluateRestart(makeState({ restartCount: 3, lastRestartAt: Date.now() }))
    expect(action).toMatchObject({ kind: 'exhausted', maxAttempts: 3 })
  })

  it('resets counter after cooldown window elapses', () => {
    const action = evaluateRestart(makeState({
      restartCount: 3,
      lastRestartAt: Date.now() - 6 * 60 * 1000, // 6 minutes ago
    }))
    expect(action).toMatchObject({ kind: 'restart', attempt: 1 })
  })

  // --- Non-retryable exit code tests ---

  it('returns non_retryable for exit code 2 (usage error)', () => {
    const action = evaluateRestart(makeState({ exitCode: 2 }))
    expect(action).toMatchObject({ kind: 'non_retryable', exitCode: 2 })
  })

  it('returns non_retryable for exit code 78 (config error)', () => {
    const action = evaluateRestart(makeState({ exitCode: 78 }))
    expect(action).toMatchObject({ kind: 'non_retryable', exitCode: 78 })
  })

  it('still restarts for non-deterministic exit codes', () => {
    const action = evaluateRestart(makeState({ exitCode: 1 }))
    expect(action.kind).toBe('restart')
  })

  it('still restarts when exit code is null (signal kill)', () => {
    const action = evaluateRestart(makeState({ exitCode: null, exitSignal: 'SIGKILL' }))
    expect(action.kind).toBe('restart')
  })

  it('stopped_by_user takes precedence over non-retryable exit code', () => {
    const action = evaluateRestart(makeState({ stoppedByUser: true, exitCode: 2 }))
    expect(action.kind).toBe('stopped_by_user')
  })
})
