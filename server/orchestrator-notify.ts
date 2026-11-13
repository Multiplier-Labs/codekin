/**
 * The one path for delivering notification messages to the orchestrator
 * (parent) session via the Claude stdin channel. The child manager, the
 * proactive monitor and the session prompt listener all go through it, so
 * they share one delivery gate (rate limit, liveness, idle) and one fallback.
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
import { getOrchestratorSessionId, isOrchestratorSession } from './orchestrator-manager.js'

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
  // While the rate-limit circuit breaker is open, don't push more API work at
  // the orchestrator; the outbox flusher holds the item until it closes.
  if (!sessions.isRateLimited() && session?.claudeProcess?.isAlive() && !session.isProcessing) {
    const message = `[Agent ${getAgentDisplayName()} Notification — ${args.label}]\n${args.title}\n${args.body}`
    sessions.sendInput(args.parentSessionId, message)
    return true
  }

  // Parent unreachable, mid-turn or rate-limited — queue for replay by the outbox flusher.
  try {
    outbox.enqueue({ label: args.label, title: args.title, body: args.body })
    return true
  } catch (err) {
    console.warn('[orchestrator-notify] failed to queue notification:', err)
    return false
  }
}

/**
 * Notify the orchestrator session, whichever it is. Returns false when no
 * orchestrator is configured (nothing is queued then) or queueing failed.
 */
export function notifyOrchestrator(
  sessions: SessionManager,
  args: Omit<OrchestratorNotifyArgs, 'parentSessionId'>,
  outbox?: NotificationOutbox,
): boolean {
  const orchestratorId = getOrchestratorSessionId(sessions)
  if (!orchestratorId) return false
  return sendOrchestratorNotification(sessions, { ...args, parentSessionId: orchestratorId }, outbox)
}

/** Sessions whose prompts another component already reports to the orchestrator. */
export interface SessionPromptReporters {
  /** Joe's own children: the child manager reports their prompts. */
  isManagedChild: (sessionId: string) => boolean
  /** Loop makers/reviewers: reported as `session_blocked` run events. */
  isLoopSession: (sessionId: string) => boolean
}

/**
 * Tell the orchestrator that a session is waiting on an approval or answer,
 * through the same idle-gated path as every other notification: a prompt in
 * one of the user's own sessions never lands in the middle of Joe's turn.
 * Skips the orchestrator's own prompts and sessions that are already
 * reported elsewhere, so Joe hears about each blocked session once.
 */
export function notifySessionPrompt(
  sessions: SessionManager,
  reporters: SessionPromptReporters,
  prompt: { sessionId: string; promptType: 'permission' | 'question'; toolName?: string; requestId?: string },
  outbox?: NotificationOutbox,
): boolean {
  const session = sessions.get(prompt.sessionId)
  if (!session || isOrchestratorSession(session.source)) return false
  if (reporters.isManagedChild(prompt.sessionId) || reporters.isLoopSession(prompt.sessionId)) return false

  const needs = prompt.promptType === 'question' ? 'Answer' : 'Approval'
  return notifyOrchestrator(sessions, {
    label: `Session Needs ${needs}`,
    title: `${session.name} (${prompt.sessionId})`,
    body: [
      prompt.toolName ? `Tool: ${prompt.toolName}` : 'Unknown tool',
      `Request ID: ${prompt.requestId ?? 'unknown'}`,
      '',
      'It may have been answered since. Use pending_prompts to see what is still waiting, and respond_to_prompt to answer.',
      `Without those tools: curl -s "http://localhost:$CODEKIN_PORT/api/orchestrator/sessions/pending-prompts" -H "Authorization: Bearer $CODEKIN_AUTH_TOKEN"`,
    ].join('\n'),
  }, outbox)
}
