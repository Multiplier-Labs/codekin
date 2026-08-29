/**
 * Shared helper for delivering notification messages to the orchestrator
 * (parent) session via the Claude stdin channel.
 *
 * The rendered format is:
 *   [Agent <name> Notification — LABEL]
 *   <title>
 *   <body>
 *
 * which is the established style used by the proactive monitor and surfaced
 * inside the orchestrator chat.
 *
 * When the recipient session cannot be reached (missing or its Claude
 * process is not running), the notification is queued in the persistent
 * outbox and replayed as a digest once the orchestrator is back.
 */

import type { SessionManager } from './session-manager.js'
import { getAgentDisplayName } from './config.js'
import { getOrchestratorOutbox } from './orchestrator-outbox.js'

export interface OrchestratorNotifyArgs {
  /** Recipient session ID (the parent / orchestrator session). */
  parentSessionId: string
  /** Bracket-suffix label (e.g. 'ACTION', 'ALERT', 'Child Session Stopped'). */
  label: string
  /** First body line — short headline. */
  title: string
  /** Remaining body — multi-line is fine. */
  body: string
}

/** Minimal outbox surface needed by this helper (injectable for tests). */
export interface NotificationOutbox {
  enqueue(args: { label: string; title: string; body: string }): void
}

/**
 * Send a notification to the parent session via Claude stdin.
 * Returns true when delivered immediately OR queued in the outbox for
 * replay (the outbox owns delivery from that point on). Returns false only
 * when queueing itself failed.
 *
 * Delivery is gated on the parent being idle: input sent while it is
 * mid-turn lands inside the active turn and derails it (audit item A5).
 * A busy parent gets the notification via the outbox's next flush tick,
 * which applies the same idle gate.
 */
export function sendOrchestratorNotification(
  sessions: SessionManager,
  args: OrchestratorNotifyArgs,
  outbox: NotificationOutbox = getOrchestratorOutbox(),
): boolean {
  const session = sessions.get(args.parentSessionId)
  if (session?.claudeProcess?.isAlive() && !session.isProcessing) {
    const message = `[Agent ${getAgentDisplayName()} Notification — ${args.label}]\n${args.title}\n${args.body}`
    sessions.sendInput(args.parentSessionId, message)
    return true
  }

  // Parent unreachable or mid-turn — queue for replay by the outbox flusher.
  try {
    outbox.enqueue({ label: args.label, title: args.title, body: args.body })
    return true
  } catch (err) {
    console.warn('[orchestrator-notify] failed to queue notification:', err)
    return false
  }
}
