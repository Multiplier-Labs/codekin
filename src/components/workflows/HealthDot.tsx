/**
 * HealthDot — colored dot indicating workflow/run health status.
 */

// ---------------------------------------------------------------------------
// HealthDot
// ---------------------------------------------------------------------------

export function HealthDot({ status }: { status: string | undefined }) {
  if (!status) return <span className="w-2.5 h-2.5 rounded-full bg-neutral-7 shrink-0" title="No runs yet" />
  const colors: Record<string, string> = {
    succeeded: 'bg-success-5',
    failed: 'bg-error-5',
    running: 'bg-accent-5 animate-pulse',
    queued: 'bg-neutral-5 animate-pulse',
    canceled: 'bg-warning-5',
    skipped: 'bg-neutral-6',
  }
  return <span className={`w-2.5 h-2.5 rounded-full shrink-0 ${colors[status] || 'bg-neutral-7'}`} title={status} />
}
