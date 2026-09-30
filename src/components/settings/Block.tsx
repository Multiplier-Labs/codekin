/**
 * The building blocks every Settings page is made of, so the pages read the
 * same way: a titled block, and inside it rows of "what this is / why" on the
 * left with the control on the right.
 */

/** A titled block inside a Settings section page. */
export function Block({ title, description, action, children }: {
  title?: string
  /** One sentence under the title: what this block is for. */
  description?: React.ReactNode
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="rounded-control border border-edge bg-surface px-5 py-4">
      {(title || action) && (
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            {title && <h3 className="text-title font-semibold text-ink">{title}</h3>}
            {description && <p className="mt-0.5 text-meta text-ink-muted">{description}</p>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  )
}

/**
 * Rows separated by hairlines. Each row pads itself top and bottom; the
 * first and last are trimmed so the group sits flush with what surrounds it.
 */
export function Rows({ children }: { children: React.ReactNode }) {
  return <div className="divide-y divide-edge [&>*:first-child]:pt-0 [&>*:last-child]:pb-0">{children}</div>
}

/**
 * One setting: the label and a sentence of explanation on the left, the
 * control on the right (wrapping under on narrow screens). `children` is for
 * anything that belongs to the setting but needs the full width — a list, a
 * confirmation, an error.
 */
export function Row({ label, description, control, htmlFor, children }: {
  label: React.ReactNode
  description?: React.ReactNode
  control?: React.ReactNode
  /** Point the label at the control's input. */
  htmlFor?: string
  children?: React.ReactNode
}) {
  const Label = htmlFor ? 'label' : 'p'
  return (
    <div className="py-3">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
        <div className="min-w-[14rem] flex-1">
          <Label {...(htmlFor ? { htmlFor } : {})} className="block text-body font-medium text-ink">{label}</Label>
          {description && <p className="mt-0.5 text-meta text-ink-muted">{description}</p>}
        </div>
        {control && <div className="flex shrink-0 flex-wrap items-center gap-2">{control}</div>}
      </div>
      {children}
    </div>
  )
}

/** A heading for a group of rows or a list inside a block. */
export function Subheading({ children }: { children: React.ReactNode }) {
  return <h4 className="mb-2 text-body font-semibold text-ink">{children}</h4>
}

/* One button scale for every Settings page. */
const buttonBase =
  'inline-flex items-center justify-center gap-2 rounded-control px-3 py-1.5 text-body transition disabled:opacity-50'
/** The default: an outlined button. */
export const button = `${buttonBase} border border-edge text-ink hover:bg-surface-raised`
/** Irreversible or destructive actions. */
export const dangerButton = `${buttonBase} border border-error-7/60 text-error-4 hover:bg-error-9/15`
/** Secondary choices beside a button: Cancel, Keep it. */
export const quietButton = `${buttonBase} text-ink-muted hover:text-ink`
/** Text inputs and selects. */
export const input =
  'rounded-control border border-edge bg-page px-3 py-1.5 text-body text-ink placeholder:text-ink-faint focus:border-focus focus:outline-none'
/** Native checkboxes, tinted. */
export const checkbox = 'h-4 w-4 cursor-pointer accent-primary-7'
