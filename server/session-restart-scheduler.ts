/**
 * Restart decision logic extracted from SessionManager.handleClaudeExit.
 *
 * Pure function that evaluates whether a crashed session should be auto-restarted,
 * based on restart count, cooldown window, exit classification, and user-stop state.
 * Returns an action descriptor that the caller (SessionManager) executes.
 */

/** Max auto-restart attempts per cooldown window before pausing. */
const MAX_RESTARTS = 3
/** Window after which the per-window restart counter resets (5 minutes). */
const RESTART_COOLDOWN_MS = 5 * 60 * 1000
/** Hard cap on total lifetime restarts.  Once reached, the session stops
 *  permanently regardless of cooldown windows.  Prevents sessions from
 *  restarting indefinitely (3 per window × many windows = hundreds). */
const MAX_LIFETIME_RESTARTS = 10
/** Delay between crash and auto-restart attempt. */
const RESTART_DELAY_MS = 2000

/**
 * Exit codes that indicate a deterministic failure — retrying will produce
 * the same result every time, so auto-restart is wasteful.
 *
 * - 2: CLI usage / argument error (e.g. invalid --model, bad flags)
 * - 78: EX_CONFIG — configuration error (sysexits.h convention)
 */
const NON_RETRYABLE_EXIT_CODES = new Set([2, 78])

export interface RestartState {
  restartCount: number
  lastRestartAt: number | null
  stoppedByUser: boolean
  /** Exit code from the process, if available. Used to classify failure type. */
  exitCode?: number | null
  /** Signal that killed the process, if any. */
  exitSignal?: string | null
  /** Total number of restarts over the entire session lifetime. */
  lifetimeRestarts?: number
}

export type RestartAction =
  | { kind: 'stopped_by_user' }
  | { kind: 'non_retryable'; exitCode: number }
  | { kind: 'restart'; attempt: number; maxAttempts: number; delayMs: number; updatedCount: number; updatedLastRestartAt: number; updatedLifetimeCount: number }
  | { kind: 'exhausted'; maxAttempts: number }

/**
 * Determine the restart action for a crashed session.
 * Does NOT mutate state or perform side effects — the caller applies the result.
 */
export function evaluateRestart(state: RestartState): RestartAction {
  if (state.stoppedByUser) {
    return { kind: 'stopped_by_user' }
  }

  // Deterministic failures: retrying won't help, tell the user immediately
  if (state.exitCode != null && NON_RETRYABLE_EXIT_CODES.has(state.exitCode)) {
    return { kind: 'non_retryable', exitCode: state.exitCode }
  }

  // Hard lifetime cap: prevent sessions from restarting indefinitely
  const lifetime = state.lifetimeRestarts ?? 0
  if (lifetime >= MAX_LIFETIME_RESTARTS) {
    return { kind: 'exhausted', maxAttempts: MAX_LIFETIME_RESTARTS }
  }

  const now = Date.now()
  let { restartCount } = state

  // Reset per-window counter if cooldown has elapsed
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
      updatedLifetimeCount: lifetime + 1,
    }
  }

  return { kind: 'exhausted', maxAttempts: MAX_RESTARTS }
}
