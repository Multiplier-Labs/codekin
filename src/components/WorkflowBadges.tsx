/**
 * Small shared badge components for workflow status and category display.
 */

import {
  IconCheck, IconX, IconLoader2, IconClock,
  IconMinus, IconPlayerPause,
} from '@tabler/icons-react'
import { kindCategory, type WorkflowCategory } from '../lib/workflowHelpers'

export function CategoryBadge({ kind }: { kind: string }) {
  const cat = kindCategory(kind)
  const styles: Record<WorkflowCategory, string> = {
    assessment: 'border-accent-7/60 bg-accent-9/30 text-accent-4',
    organizer:  'border-success-7/60 bg-success-9/30 text-success-4',
    executor:   'border-warning-7/60 bg-warning-9/30 text-warning-4',
    event:      'border-purple-700/60 bg-purple-900/30 text-purple-400',
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-[13px] font-medium capitalize ${styles[cat]}`}>
      {cat}
    </span>
  )
}

export function StatusBadge({ status }: { status: string }) {
  switch (status) {
    case 'succeeded':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-success-7/60 bg-success-8/40 px-2.5 py-0.5 text-[13px] font-medium text-success-4">
          <IconCheck size={12} stroke={2.5} />
          succeeded
        </span>
      )
    case 'failed':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-error-7/60 bg-error-9/40 px-2.5 py-0.5 text-[13px] font-medium text-error-4">
          <IconX size={12} stroke={2.5} />
          failed
        </span>
      )
    case 'running':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-accent-7/60 bg-accent-9/40 px-2.5 py-0.5 text-[13px] font-medium text-accent-4">
          <IconLoader2 size={12} stroke={2} className="animate-spin" />
          running
        </span>
      )
    case 'queued':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-7/60 bg-neutral-9/40 px-2.5 py-0.5 text-[13px] font-medium text-neutral-4">
          <IconClock size={12} stroke={2} />
          queued
        </span>
      )
    case 'canceled':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-warning-7/60 bg-warning-9/40 px-2.5 py-0.5 text-[13px] font-medium text-warning-4">
          <IconMinus size={12} stroke={2} />
          canceled
        </span>
      )
    case 'skipped':
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-7/60 bg-neutral-9/40 px-2.5 py-0.5 text-[13px] font-medium text-neutral-5">
          <IconPlayerPause size={12} stroke={2} />
          skipped
        </span>
      )
    default:
      return (
        <span className="inline-flex items-center gap-1.5 rounded-full border border-neutral-7/60 bg-neutral-9/40 px-2.5 py-0.5 text-[13px] font-medium text-neutral-4">
          {status}
        </span>
      )
  }
}
