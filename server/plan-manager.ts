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
 *   planning ──ExitPlanMode──► reviewing  (user sees approval prompt)
 *   reviewing ──approve──► idle           (sends "plan approved" message)
 *   reviewing ──deny──► planning          (sends "plan rejected" message)
 *   planning ──result (turn end)──► idle  (safety reset if Claude leaves plan mode)
 *
 * The key insight: approval is gated at the Codekin layer as a conversational
 * turn (user message), not at the CLI permission layer (hook workaround).
 * This avoids fighting the CLI's requiresUserInteraction() guard on ExitPlanMode.
 */

import { EventEmitter } from 'events'

export type PlanState = 'idle' | 'planning' | 'reviewing'

export interface PlanManagerEvents {
  /** Emitted when plan mode state changes. The UI should show/hide the plan mode indicator. */
  planning_mode: [active: boolean]
  /** Emitted when the user needs to approve/reject the plan exit. */
  plan_review: []
  /** Emitted when a message should be sent to Claude (approve/deny feedback). */
  send_message: [message: string]
}

export class PlanManager extends EventEmitter<PlanManagerEvents> {
  private _state: PlanState = 'idle'

  get state(): PlanState {
    return this._state
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
   * Called when Claude invokes ExitPlanMode (content_block_start detected).
   * Transitions planning → reviewing.
   * The caller should show an approval prompt to the user.
   */
  onExitPlanModeRequested(): void {
    if (this._state !== 'planning') {
      // Not in planning mode — nothing to review.
      // Could happen if ExitPlanMode fires without a prior EnterPlanMode.
      return
    }
    this._state = 'reviewing'
    this.emit('plan_review')
  }

  /**
   * Called when the user approves the plan.
   * Transitions reviewing → idle, emits planning_mode:false,
   * and sends an approval message to Claude.
   */
  approve(): void {
    if (this._state !== 'reviewing') return
    this._state = 'idle'
    this.emit('planning_mode', false)
    this.emit('send_message', 'Plan approved. Proceed with implementation.')
  }

  /**
   * Called when the user denies (rejects) the plan.
   * Transitions reviewing → planning and sends a rejection message to Claude.
   */
  deny(feedback?: string): void {
    if (this._state !== 'reviewing') return
    this._state = 'planning'
    const msg = feedback
      ? `Plan rejected. Please revise: ${feedback}`
      : 'Plan rejected. Please revise the plan and try again.'
    this.emit('send_message', msg)
  }

  /**
   * Called when a turn ends (result event).
   * Safety reset: if we're still in 'reviewing' at turn end, it means
   * the ExitPlanMode tool completed without our gate catching it properly.
   * Reset to idle.
   *
   * If we're in 'planning' at turn end, stay in planning — Claude may
   * still be iterating on the plan across multiple turns.
   */
  onTurnEnd(): void {
    if (this._state === 'reviewing') {
      // ExitPlanMode completed but we never got user approval through our gate.
      // This can happen if the CLI auto-handled ExitPlanMode.
      // Reset to idle — the CLI has already exited plan mode.
      this._state = 'idle'
      this.emit('planning_mode', false)
    }
  }

  /**
   * Reset to idle state. Used when the Claude process exits or restarts.
   * Emits planning_mode:false if we were in a non-idle state.
   */
  reset(): void {
    if (this._state !== 'idle') {
      this._state = 'idle'
      this.emit('planning_mode', false)
    }
  }
}
