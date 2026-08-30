/** Shared presentation helpers for loop runs (list rows + workspace header). */

import type { LoopRun, LoopRunState } from './loopsApi'

/** Fold a run's (state, outcome) pair into a badge label + intent classes. */
export function stateBadge(run: Pick<LoopRun, 'state' | 'outcome'>): { label: string; classes: string } {
  if (run.state === 'done') {
    switch (run.outcome) {
      case 'completed': return { label: 'completed', classes: 'bg-success-7 text-success-2' }
      case 'completed_with_warnings': return { label: 'completed*', classes: 'bg-success-8 text-success-3' }
      case 'canceled': return { label: 'canceled', classes: 'bg-warning-8 text-warning-2' }
      default: return { label: 'failed', classes: 'bg-error-8 text-error-2' }
    }
  }
  switch (run.state) {
    case 'awaiting_approval': return { label: 'needs decision', classes: 'bg-warning-7 text-warning-1 animate-pulse' }
    case 'paused': return { label: 'paused', classes: 'bg-edge-strong text-ink-muted' }
    case 'pausing': return { label: 'pausing…', classes: 'bg-edge-strong text-ink-muted' }
    case 'planning': return { label: 'planning', classes: 'bg-primary-8 text-primary-2 animate-pulse' }
    case 'evaluating': return { label: 'evaluating', classes: 'bg-accent-8 text-accent-2 animate-pulse' }
    case 'reviewing': return { label: 'reviewing', classes: 'bg-primary-8 text-primary-2 animate-pulse' }
    case 'monitoring_ci': return { label: 'ci checks', classes: 'bg-primary-8 text-primary-2 animate-pulse' }
    default: return { label: run.state, classes: 'bg-accent-8 text-accent-2 animate-pulse' }
  }
}

/** States that accept a pause (anything live that is not already waiting). */
export const ACTIVE_LOOP_STATES: ReadonlySet<LoopRunState> = new Set([
  'created', 'preflight', 'planning', 'executing', 'evaluating', 'reviewing', 'finalizing', 'monitoring_ci', 'recovering', 'pausing', 'canceling',
])
