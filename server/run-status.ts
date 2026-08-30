/**
 * The shared status vocabulary for background runs.
 *
 * Workflows, loops, and agent runs grew separate status unions with
 * overlapping-but-different members. This catalog is the superset they derive
 * from (via Extract<>) or fold into (Loops 2.0 maps its state/outcome pair
 * here in unified-runs.ts), so a status string means one thing everywhere and
 * the unified Automations view can treat runs uniformly.
 */

export type RunLifecycleStatus =
  | 'queued'          // created, not yet executing
  | 'running'         // actively executing
  | 'verifying'       // deterministic evaluators/verify commands executing
  | 'checking'        // independent reviewer (different provider) reviewing
  | 'blocked'         // waiting on a human decision (non-terminal)
  | 'awaiting_human'  // agent: escalated to a human checkpoint (terminal)
  | 'paused'          // loop: durably parked by the user; resumable
  | 'succeeded'
  | 'failed'
  | 'canceled'        // stopped by the user
  | 'skipped'         // workflow: clean no-op (e.g. no commits since last run)

/** Statuses a run can never leave. */
export const TERMINAL_RUN_STATUSES: ReadonlySet<RunLifecycleStatus> = new Set<RunLifecycleStatus>([
  'awaiting_human',
  'succeeded',
  'failed',
  'canceled',
  'skipped',
])

export function isTerminalRunStatus(status: RunLifecycleStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status)
}
