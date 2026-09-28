/**
 * A titled card: one section of Settings.
 */

export function SectionCard({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="settings-section-card rounded-lg border border-edge bg-surface">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-edge">
        <span className="text-ink-muted">{icon}</span>
        <h3 className="text-meta font-semibold uppercase tracking-wide text-ink-muted">{title}</h3>
      </div>
      <div className="px-4 py-4">
        {children}
      </div>
    </section>
  )
}
