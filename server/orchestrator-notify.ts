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
 */

import type { SessionManager } from './session-manager.js'
import { getAgentDisplayName } from './config.js'

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

/**
 * Send a notification to the parent session via Claude stdin.
 * Returns true when delivered, false when the recipient cannot be reached
 * (session missing or its Claude process is not alive).
 */
export function sendOrchestratorNotification(
  sessions: SessionManager,
  args: OrchestratorNotifyArgs,
): boolean {
  const session = sessions.get(args.parentSessionId)
  if (!session?.claudeProcess?.isAlive()) return false

  const message = `[Agent ${getAgentDisplayName()} Notification — ${args.label}]\n${args.title}\n${args.body}`
  sessions.sendInput(args.parentSessionId, message)
  return true
}
