/**
 * StepIcon, JsonBlock, and StepCard — components for rendering workflow run steps.
 */

import {
  IconCheck, IconX, IconLoader2, IconMinus, IconCircle, IconChevronRight,
} from '@tabler/icons-react'
import type { WorkflowStep } from '../../lib/workflowApi'
import { statusBadge, formatDuration } from '../../lib/workflowHelpers'

// ---------------------------------------------------------------------------
// StepIcon
// ---------------------------------------------------------------------------

export function StepIcon({ status }: { status: string }) {
  const cls = 'shrink-0'
  switch (status) {
    case 'succeeded': return <IconCheck size={14} stroke={2.5} className={`${cls} text-success-4`} />
    case 'failed':    return <IconX size={14} stroke={2.5} className={`${cls} text-error-4`} />
    case 'running':   return <IconLoader2 size={14} stroke={2} className={`${cls} text-accent-4 animate-spin`} />
    case 'skipped':   return <IconMinus size={14} stroke={2} className={`${cls} text-neutral-6`} />
    default:          return <IconCircle size={14} stroke={2} className={`${cls} text-neutral-6`} />
  }
}

// ---------------------------------------------------------------------------
// JsonBlock — collapsible JSON viewer
// ---------------------------------------------------------------------------

export function JsonBlock({ label, data, defaultOpen = false }: {
  label: string
  data: Record<string, unknown> | null
  defaultOpen?: boolean
}) {
  if (!data || Object.keys(data).length === 0) return null
  const json = JSON.stringify(data, null, 2)
  const display = json.length > 4000 ? json.slice(0, 4000) + '\n… (truncated)' : json

  return (
    <details open={defaultOpen} className="mt-1.5">
      <summary className="cursor-pointer select-none text-[14px] text-neutral-5 hover:text-neutral-3 list-none flex items-center gap-1">
        <IconChevronRight size={12} stroke={2} className="details-arrow transition-transform" />
        {label}
        <span className="text-neutral-6">({Object.keys(data).length} fields)</span>
      </summary>
      <pre className="mt-1 overflow-x-auto rounded-md bg-neutral-12 p-2.5 text-[14px] text-neutral-3 font-mono leading-relaxed max-h-64 overflow-y-auto">
        {display}
      </pre>
    </details>
  )
}

// ---------------------------------------------------------------------------
// StepCard
// ---------------------------------------------------------------------------

export function StepCard({ step }: { step: WorkflowStep }) {
  return (
    <div className="rounded-md border border-neutral-8/40 bg-neutral-11/60 px-3 py-2">
      <div className="flex items-center gap-2">
        <StepIcon status={step.status} />
        <span className="font-mono text-[14px] text-neutral-2 font-medium">{step.key}</span>
        <span className={`ml-auto inline-flex items-center rounded px-1.5 py-0.5 text-[13px] font-medium ${statusBadge(step.status)}`}>
          {step.status}
        </span>
        <span className="text-[14px] text-neutral-5 tabular-nums">
          {formatDuration(step.startedAt, step.completedAt)}
        </span>
      </div>

      {step.error && (
        <div className="mt-1.5 rounded bg-error-10/50 px-2 py-1 text-[14px] text-error-4 font-mono">
          {step.error}
        </div>
      )}

      <div className="mt-0.5">
        <JsonBlock label="input" data={step.input} />
        <JsonBlock label="output" data={step.output} />
      </div>
    </div>
  )
}
