/**
 * HealthDot — colored dot indicating workflow/run health status.
 */

// ---------------------------------------------------------------------------
// HealthDot
// ---------------------------------------------------------------------------

export function HealthDot({ status }: { status: string | undefined }) {
  if (!status) return <span className="w-2.5 h-2.5 rounded-full bg-edge-strong shrink-0" title="No runs yet" />
  const colors: Record<string, string> = {
    succeeded: 'bg-success-5',
    failed: 'bg-error-5',
    running: 'bg-accent-5 animate-pulse',
    queued: 'bg-ink-muted animate-pulse',
    canceled: 'bg-warning-5',
    skipped: 'bg-ink-faint',
  }
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors[status] || 'bg-edge-strong'}`} title={status} />
}
