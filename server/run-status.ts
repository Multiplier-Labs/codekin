/**
 * The shared status vocabulary for background runs.
 *
 * Workflows and goal runs (loops) grew separate status unions with
 * overlapping-but-different members. This catalog is the superset both derive
 * from (via Extract<>), so a status string means one thing everywhere and the
 * Phase-2 unified Automations view can treat runs uniformly.
 *
 * Known wart, kept deliberately: `canceled` (workflows) and `aborted` (loops)
 * are the same concept under two names. They are persisted values in existing
 * databases and API responses, so collapsing them is a data migration — that
 * lands with the unified run store, not here. The REST routes already accept
 * both verbs (/cancel and /abort are aliases on both engines).
 */

export type RunLifecycleStatus =
  | 'queued'          // created, not yet executing
  | 'running'         // actively executing
  | 'verifying'       // loop: deterministic verify commands executing
  | 'checking'        // loop: second-provider checker reviewing
  | 'blocked'         // loop: a tool call is waiting on human approval (non-terminal)
  | 'awaiting_human'  // loop: escalated to a human checkpoint (terminal)
  | 'succeeded'
  | 'failed'
  | 'canceled'        // workflow: stopped by the user
  | 'aborted'         // loop: stopped by the user (same concept as canceled)
  | 'skipped'         // workflow: clean no-op (e.g. no commits since last run)

/** Statuses a run can never leave. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunLifecycleStatus> = new Set<RunLifecycleStatus>([
  'awaiting_human',
  'succeeded',
  'failed',
  'canceled',
  'aborted',
  'skipped',
])

export function isTerminalRunStatus(status: RunLifecycleStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}
