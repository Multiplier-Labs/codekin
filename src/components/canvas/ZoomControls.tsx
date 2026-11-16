/** The zoom bar shown in the corner of pannable Canvas views (diagrams, images). */

import { IconMaximize, IconMinus, IconPlus } from '@tabler/icons-react'

interface Props {
  scale: number
  onZoomBy: (factor: number) => void
  onFit: () => void
  /** Clicking the percentage goes to 100%, when given. */
  onActualSize?: () => void
}

const BUTTON = 'inline-flex h-7 w-7 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink'

export function ZoomControls({ scale, onZoomBy, onFit, onActualSize }: Props) {
  const pct = `${Math.round(scale * 100)}%`
  return (
    <div data-zoom-controls className="absolute bottom-3 right-3 flex items-center gap-1 rounded-control border border-edge bg-surface p-1">
      <button type="button" onClick={() => { onZoomBy(1 / 1.25) }} className={BUTTON} aria-label="Zoom out"><IconMinus size={15} /></button>
      {onActualSize
        ? <button type="button" onClick={onActualSize} className="h-7 w-12 rounded-control text-center text-meta tabular-nums text-ink hover:bg-surface-raised" title="Actual size (100%)" aria-label={`Zoom ${pct}, show at actual size`}>{pct}</button>
        : <span className="w-12 text-center text-meta tabular-nums text-ink">{pct}</span>}
      <button type="button" onClick={() => { onZoomBy(1.25) }} className={BUTTON} aria-label="Zoom in"><IconPlus size={15} /></button>
      <button type="button" onClick={onFit} className={BUTTON} aria-label="Fit to view" title="Fit to view"><IconMaximize size={15} /></button>
    </div>
  )
}
