/**
 * Plan mode state machine for Codekin.
 *
 * Owns the entire plan mode lifecycle as a single, testable state machine.
 * Replaces the distributed flag-based tracking that was previously spread
 * across ClaudeProcess (pendingExitPlanModeId, exitPlanModeDenied),
 * SessionManager (clearPendingExitPlanMode wiring), and the PreToolUse hook
 * (deny-with-message workaround for ExitPlanMode).
 *
 * State transitions:
 *   idle ──EnterPlanMode──► planning
 *   planning ──ExitPlanMode hook──► reviewing  (user sees approval prompt)
 *   reviewing ──approve──► idle               (hook returns deny-with-approval-message)
 *   reviewing ──deny──► planning              (hook returns deny-with-rejection-message)
 *   planning ──result (turn end)──► idle      (safety reset if plan mode ends naturally)
 *
 * Enforcement architecture:
 *   The PreToolUse hook is the real gate — it intercepts ExitPlanMode before
 *   the CLI can execute it. The hook calls requestToolApproval() on the server,
 *   which delegates to PlanManager. PlanManager transitions to 'reviewing' and
 *   the server shows an approval prompt. The hook blocks until the user responds.
 *   On approve: hook returns deny-with-approval-message (CLI workaround for
 *   requiresUserInteraction). On deny: hook returns deny-with-rejection-message.
 *   PlanManager never auto-approves — if the turn ends while reviewing, it
 *   auto-denies and returns to planning state.
 */

import { randomUUID } from 'crypto'
import { EventEmitter } from 'events'

export type PlanState = 'idle' | 'planning' | 'reviewing'

export interface PlanManagerEvents {
  /** Emitted when plan mode state changes. The UI should show/hide the plan mode indicator. */
  planning_mode: [active: boolean]
}

export class PlanManager extends EventEmitter<PlanManagerEvents> {
  private _state: PlanState = 'idle'
  /** Current pending review request ID (unique per ExitPlanMode attempt). */
  private _pendingReviewId: string | null = null

  get state(): PlanState {
    return this._state
  }

  get pendingReviewId(): string | null {
    return this._pendingReviewId
  }

  /**
   * Called when Claude invokes EnterPlanMode.
   * Transitions idle → planning and emits planning_mode:true.
   */
  onEnterPlanMode(): void {
    if (this._state !== 'idle') {
      // Already in planning — idempotent
      return
    }
    this._state = 'planning'
    this.emit('planning_mode', true)
  }

  /**
   * Called when the ExitPlanMode hook request arrives at the server.
   * Transitions planning → reviewing and returns the review request ID.
   * Returns null if not in planning state (caller should fall through).
   */
  onExitPlanModeRequested(): string | null {
    if (this._state !== 'planning') {
      return null
    }
    this._state = 'reviewing'
    this._pendingReviewId = randomUUID()
    return this._pendingReviewId
  }

  /**
   * Called when the user approves the plan.
   * Transitions reviewing → idle and emits planning_mode:false.
   * Returns true if the approval was valid (state was reviewing with matching ID).
   */
  approve(reviewId?: string): boolean {
    if (this._state !== 'reviewing') return false
    if (reviewId && reviewId !== this._pendingReviewId) return false
    this._state = 'idle'
    this._pendingReviewId = null
    this.emit('planning_mode', false)
    return true
  }

  /**
   * Called when the user denies (rejects) the plan.
   * Transitions reviewing → planning.
   * Returns the rejection message to send back via the hook.
   */
  deny(reviewId?: string, feedback?: string): string | null {
    if (this._state !== 'reviewing') return null
    if (reviewId && reviewId !== this._pendingReviewId) return null
    this._state = 'planning'
    this._pendingReviewId = null
    return feedback
      ? `Plan rejected. Please revise: ${feedback}`
      : 'Plan rejected. Please revise the plan and try again.'
  }

  /**
   * Called when a turn ends (result event).
   * If we're still in 'reviewing' at turn end, auto-deny — never auto-approve.
   * The hook may have timed out or the CLI may have handled ExitPlanMode
   * through a non-hook path. Stay safe: return to planning.
   */
  onTurnEnd(): void {
    if (this._state === 'reviewing') {
      // Auto-deny: return to planning, don't silently approve
      this._state = 'planning'
      this._pendingReviewId = null
      // Don't emit planning_mode:false — we're still in plan mode
    }
  }

  /**
   * Reset to idle state. Used when the Claude process exits or restarts.
   * Emits planning_mode:false if we were in a non-idle state.
   */
  reset(): void {
    if (this._state !== 'idle') {
      this._state = 'idle'
      this._pendingReviewId = null
      this.emit('planning_mode', false)
    }
  }
}
