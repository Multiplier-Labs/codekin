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
      <label id="settings-theme-label" className="mb-1.5 block text-body text-ink-muted">Theme</label>
      <div role="radiogroup" aria-labelledby="settings-theme-label" className="grid grid-cols-2 gap-2 sm:grid-cols-3">
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
              <span className="flex items-center gap-1 px-0.5">
                <span className="flex-1 truncate text-meta text-ink">{t.label}</span>
                {selected
                  ? <IconCheck size={13} stroke={2} className="flex-shrink-0 text-focus" />
                  : t.label.toLowerCase() !== t.scheme && <span className="text-micro text-ink-faint">{t.scheme === 'dark' ? 'Dark' : 'Light'}</span>}
              </span>
            </button>
          )
        })}
      </div>
    </div>
  )
}
