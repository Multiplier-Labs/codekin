/**
 * A titled block inside a Settings section page.
 */

export function Block({ title, action, children }: { title?: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="rounded-control border border-edge bg-surface px-4 py-4">
      {(title || action) && (
        <div className="mb-3 flex items-center gap-3">
          {title && <h3 className="flex-1 text-meta font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>}
          {action}
        </div>
      )}
      {children}
    </section>
  )
}
