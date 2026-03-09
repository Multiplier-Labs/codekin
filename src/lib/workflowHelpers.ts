/**
 * Pure utility functions and constants shared across workflow UI components.
 */

import type { WorkflowRun } from './workflowApi'

export type WorkflowCategory = 'assessment' | 'organizer' | 'executor'

export const WORKFLOW_KINDS = [
  { value: 'coverage.daily', label: 'Coverage Assessment', category: 'assessment' as WorkflowCategory },
  { value: 'code-review.daily', label: 'Code Review', category: 'assessment' as WorkflowCategory },
  { value: 'comment-assessment.daily', label: 'Comment Assessment', category: 'assessment' as WorkflowCategory },
  { value: 'dependency-health.daily', label: 'Dependency Health', category: 'assessment' as WorkflowCategory },
  { value: 'security-audit.weekly', label: 'Security Audit', category: 'assessment' as WorkflowCategory },
  { value: 'complexity.weekly', label: 'Complexity Report', category: 'assessment' as WorkflowCategory },
  { value: 'repo-health.weekly', label: 'Repository Health', category: 'assessment' as WorkflowCategory },
]

export const MODEL_OPTIONS = [
  { value: '', label: 'Default (Opus)' },
  { value: 'claude-sonnet-4-6', label: 'Sonnet 4.6' },
  { value: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
]

export const DAY_PRESETS = [
  { label: 'Daily', dow: '*' },
  { label: 'Weekdays', dow: '1-5' },
]

export const DAY_INDIVIDUAL = [
  { label: 'Mon', dow: '1' },
  { label: 'Tue', dow: '2' },
  { label: 'Wed', dow: '3' },
  { label: 'Thu', dow: '4' },
  { label: 'Fri', dow: '5' },
  { label: 'Sat', dow: '6' },
  { label: 'Sun', dow: '0' },
]

export const DAY_PATTERNS = [...DAY_PRESETS, ...DAY_INDIVIDUAL]

/** Check if a dow value represents a bi-weekly schedule (e.g. `"biweekly"` or `"biweekly-1"`). */
export function isBiweeklyDow(dow: string): boolean {
  return dow.startsWith('biweekly')
}

/** Extract the day-of-week from a biweekly dow value, e.g. `"biweekly-1"` → `"1"`. Returns `"*"` for legacy `"biweekly"`. */
export function biweeklyDay(dow: string): string {
  const parts = dow.split('-')
  return parts.length >= 2 ? parts.slice(1).join('-') : '*'
}

/** Build a cron expression from hour (0–23), day-of-week pattern, and optional minute (0–59). */
export function buildCron(hour: number, dow: string, minute = 0): string {
  if (isBiweeklyDow(dow)) return `${minute} ${hour} */14 * ${biweeklyDay(dow)}`
  return `${minute} ${hour} * * ${dow}`
}

/** Parse a 5-field cron expression into hour, minute, and day-of-week components. Falls back to 6:00 AM daily. */
export function parseCron(expr: string): { hour: number; minute: number; dow: string } {
  const parts = expr.trim().split(/\s+/)
  if (parts.length === 5) {
    const biweekly = parts[2] === '*/14'
    const dow = biweekly
      ? (parts[4] === '*' ? 'biweekly' : `biweekly-${parts[4]}`)
      : parts[4]
    return {
      hour: parseInt(parts[1]) || 0,
      minute: parseInt(parts[0]) || 0,
      dow,
    }
  }
  return { hour: 6, minute: 0, dow: '*' }
}

/** Format a 24-hour integer (0–23) as a 12-hour time string, e.g. `6` → `"6:00 AM"`. */
export function formatHour(h: number): string {
  if (h === 0) return '12:00 AM'
  if (h < 12) return `${h}:00 AM`
  if (h === 12) return '12:00 PM'
  return `${h - 12}:00 PM`
}

/** Convert hour + minute to an HTML time input value string, e.g. `(6, 30)` → `"06:30"`. */
export function toTimeValue(h: number, m: number): string {
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

/** Parse an HTML time input value string to hour + minute, e.g. `"06:30"` → `{ hour: 6, minute: 30 }`. */
export function fromTimeValue(v: string): { hour: number; minute: number } {
  const [h, m] = v.split(':').map(Number)
  return { hour: h || 0, minute: m || 0 }
}

/** Convert a 5-field cron expression into a human-readable description, e.g. `"Daily at 06:00"`. */
export function describeCron(expr: string): string {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return expr
  const [min, hour, dom, , dow] = parts
  const pad = (n: string) => n.length === 1 ? `0${n}` : n
  const time = `${pad(hour)}:${pad(min)}`
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  if (dom === '*/14') {
    const dayName = dow !== '*' ? ` ${days[parseInt(dow)] ?? dow}` : ''
    return `Bi-weekly${dayName} at ${time}`
  }
  if (dow === '*') return `Daily at ${time}`
  if (dow === '1-5') return `Weekdays at ${time}`
  const dayName = days[parseInt(dow)] ?? dow
  return `Weekly ${dayName} at ${time}`
}

/** Look up the display label for a model value, e.g. `"claude-sonnet-4-6"` → `"Sonnet 4.6"`. Returns `null` for empty/default. */
export function modelLabel(model: string | undefined): string | null {
  if (!model) return null
  return MODEL_OPTIONS.find(m => m.value === model)?.label ?? model
}

/** Look up the display label for a workflow kind, e.g. `"coverage.daily"` → `"Coverage Assessment"`. */
export function kindLabel(kind: string): string {
  return WORKFLOW_KINDS.find(k => k.value === kind)?.label ?? kind
}

/** Look up the category for a workflow kind. Defaults to `"assessment"` for unknown kinds. */
export function kindCategory(kind: string): WorkflowCategory {
  return WORKFLOW_KINDS.find(k => k.value === kind)?.category ?? 'assessment'
}

/** Convert a string to a URL-safe slug: lowercase, non-alphanumeric chars replaced with hyphens. */
export function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
}

/** Format the elapsed time between two ISO timestamps as a compact duration (e.g. `"3m"`, `"45s"`). Uses wall-clock time if still running. */
export function formatDuration(startedAt: string | null, completedAt: string | null): string {
  if (!startedAt) return '—'
  const end = completedAt ? new Date(completedAt) : new Date()
  const ms = end.getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return '<1s'
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`
  return `${Math.round(ms / 60_000)}m`
}

/** Format an ISO timestamp as a short locale string, e.g. `"Mar 8, 06:00 AM"`. Returns `"—"` for null. */
export function formatTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/** Extract a display-friendly repo name from a workflow run's input, falling back to the kind. */
export function repoNameFromRun(run: WorkflowRun): string {
  return (run.input.repoName as string)
    || (run.input.repoPath as string)?.split('/').pop()
    || run.kind
}

/** Return Tailwind CSS classes for a status badge background and text color. */
export function statusBadge(status: string): string {
  switch (status) {
    case 'succeeded': return 'bg-success-7 text-success-2'
    case 'failed':    return 'bg-error-8 text-error-2'
    case 'running':   return 'bg-accent-8 text-accent-2 animate-pulse'
    case 'queued':    return 'bg-neutral-8 text-neutral-3'
    case 'canceled':  return 'bg-warning-8 text-warning-2'
    case 'skipped':   return 'bg-neutral-8 text-neutral-5'
    default:          return 'bg-neutral-8 text-neutral-3'
  }
}
