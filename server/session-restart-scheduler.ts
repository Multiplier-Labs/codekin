/**
 * Restart decision logic extracted from SessionManager.handleClaudeExit.
 *
 * Pure function that evaluates whether a crashed session should be auto-restarted,
 * based on restart count, cooldown window, and user-stop state. Returns an action
 * descriptor that the caller (SessionManager) executes.
 */

/** Max auto-restart attempts before requiring manual intervention. */
const MAX_RESTARTS = 3
/** Window after which the restart counter resets (5 minutes). */
const RESTART_COOLDOWN_MS = 5 * 60 * 1000
/** Delay between crash and auto-restart attempt. */
const RESTART_DELAY_MS = 2000

export interface RestartState {
  restartCount: number
  lastRestartAt: number | null
  stoppedByUser: boolean
}

export type RestartAction =
  | { kind: 'stopped_by_user' }
  | { kind: 'restart'; attempt: number; maxAttempts: number; delayMs: number; updatedCount: number; updatedLastRestartAt: number }
  | { kind: 'exhausted'; maxAttempts: number }

/**
 * Determine the restart action for a crashed session.
 * Does NOT mutate state or perform side effects — the caller applies the result.
 */
export function evaluateRestart(state: RestartState): RestartAction {
  if (state.stoppedByUser) {
    return { kind: 'stopped_by_user' }
  }

  const now = Date.now()
  let { restartCount } = state

  // Reset counter if cooldown has elapsed
  if (state.lastRestartAt && (now - state.lastRestartAt) > RESTART_COOLDOWN_MS) {
    restartCount = 0
  }

  if (restartCount < MAX_RESTARTS) {
    const updatedCount = restartCount + 1
    return {
      kind: 'restart',
      attempt: updatedCount,
      maxAttempts: MAX_RESTARTS,
      delayMs: RESTART_DELAY_MS,
      updatedCount,
      updatedLastRestartAt: now,
    }
  }

  return { kind: 'exhausted', maxAttempts: MAX_RESTARTS }
}
