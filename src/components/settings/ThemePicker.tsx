/**
 * Theme picker (browser setting): the nine palettes as swatches.
 */

import { IconCheck } from '@tabler/icons-react'
import { ThemeSwatch } from '../ThemeSwatch'
import { THEMES } from '../../themes/registry'
import type { Settings } from '../../types'

interface Props {
  theme: Settings['theme']
  onSelect: (theme: Settings['theme']) => void
}

export function ThemePicker({ theme, onSelect }: Props) {
  return (
    <div>
      <div role="radiogroup" aria-label="Theme" className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {THEMES.map(t => {
          const selected = theme === t.id
          return (
            <button
              key={t.id}
              role="radio"
              aria-checked={selected}
              onClick={() => { onSelect(t.id) }}
              className={`flex flex-col gap-1.5 rounded-control border bg-surface p-1.5 text-left transition-colors ${
                selected ? 'border-focus ring-1 ring-focus' : 'border-edge hover:border-edge-strong'
              }`}
            >
              <ThemeSwatch theme={t} />
              <span className="flex items-center gap-1 px-0.5 pb-0.5">
                <span className="flex-1 truncate text-body text-ink">{t.label}</span>
                {selected
                  ? <IconCheck size={15} stroke={2} className="flex-shrink-0 text-focus" />
                  : t.label.toLowerCase() !== t.scheme && <span className="text-meta text-ink-muted">{t.scheme === 'dark' ? 'Dark' : 'Light'}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
