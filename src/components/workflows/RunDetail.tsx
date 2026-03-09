/**
 * RunDetail — expanded debug panel showing steps for a workflow run.
 */

import type { WorkflowRunWithSteps } from '../../lib/workflowApi'
import { StepCard, JsonBlock } from './StepCard'

// ---------------------------------------------------------------------------
// RunDetail
// ---------------------------------------------------------------------------

export function RunDetail({ run }: { run: WorkflowRunWithSteps }) {
  return (
    <div className="mt-2 space-y-1.5 border-l-2 border-neutral-8/50 pl-3">
      <div className="text-[14px] font-medium text-neutral-5 uppercase tracking-wider mb-2">Steps</div>

      {run.steps.length === 0 ? (
        <div className="text-[14px] text-neutral-5 py-1">No steps recorded yet.</div>
      ) : (
        run.steps.map(step => <StepCard key={step.id} step={step} />)
      )}

      {run.output && Object.keys(run.output).length > 0 && (
        <div className="pt-1">
          <JsonBlock label="run output" data={run.output} defaultOpen />
        </div>
      )}

      {run.error && (
        <div className="rounded-md bg-error-10/50 px-3 py-2 text-[14px] text-error-4 font-mono">
          {run.error}
        </div>
      )}
    </div>
  )
}
