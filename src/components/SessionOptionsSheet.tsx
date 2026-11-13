/**
 * SessionOptionsSheet — the new-session composer's options on touch.
 *
 * On a phone the composer's place, agent and permission chips fold into one
 * Options button; this bottom sheet holds them: Place (opens the place picker
 * as a full-height screen), the worktree switch for git places, the agent
 * and its model, and the permission mode. Rows are tall (≥ 52px) so every
 * target clears 44px.
 */

import { useEffect, useRef } from 'react'
import { IconCheck, IconChevronRight } from '@tabler/icons-react'
import { PROVIDERS, permissionModesFor, type CodingProvider, type ModelOption, type PermissionMode } from '../types'
import { providerAvailability } from '../lib/agentHealth'
import { useAgentHealth } from '../hooks/useAgentHealth'
import type { DraftPlace } from '../lib/places'

interface Props {
  place: DraftPlace
  placeLabel: string
  onOpenPlace: () => void
  showWorktree: boolean
  useWorktree: boolean
  onWorktreeChange: (on: boolean) => void
  provider: CodingProvider
  onProviderChange: (provider: CodingProvider) => void
  currentModel: string | null
  availableModels: ModelOption[]
  onModelChange: (model: string) => void
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  onClose: () => void
}

const ROW = 'flex min-h-[52px] w-full items-center gap-3 px-4 text-left text-body'

function SectionTitle({ children }: { children: string }) {
  return <div className="px-4 pt-3 pb-1 text-micro uppercase tracking-wide text-ink-muted">{children}</div>
}

export function SessionOptionsSheet({
  place, placeLabel, onOpenPlace, showWorktree, useWorktree, onWorktreeChange,
  provider, onProviderChange, currentModel, availableModels, onModelChange,
  permissionMode, onPermissionModeChange, onClose,
}: Props) {
  const health = useAgentHealth()
  const doneRef = useRef<HTMLButtonElement>(null)
  useEffect(() => { doneRef.current?.focus() }, [])
  useEffect(() => {
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('keydown', onKey) }
  }, [onClose])

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end">
      <button type="button" aria-label="Close session options" className="flex-1 bg-page/60" onClick={onClose} />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Session options"
        className="flex max-h-[85vh] flex-col rounded-t-floating border-t border-edge-strong bg-surface-raised shadow-floating"
      >
        <div className="flex min-h-[52px] items-center justify-between border-b border-edge px-4">
          <h2 className="text-title text-ink">Session options</h2>
          <button ref={doneRef} type="button" onClick={onClose} className="min-h-[44px] rounded-control px-3 text-body font-medium text-accent-5">
            Done
          </button>
        </div>

        <div className="overflow-y-auto pb-[env(safe-area-inset-bottom)]">
          <SectionTitle>Place</SectionTitle>
          <button type="button" onClick={onOpenPlace} className={`${ROW} text-ink hover:bg-edge`}>
            <span className={`min-w-0 flex-1 truncate ${place.kind === 'folder' ? 'font-mono' : ''}`}>{placeLabel}</span>
            <IconChevronRight size={16} className="shrink-0 text-ink-muted" />
          </button>

          {showWorktree && (
            <label className={`${ROW} cursor-pointer text-ink`}>
              <span className="flex-1">Work in a worktree</span>
              <input
                type="checkbox"
                role="switch"
                checked={useWorktree}
                onChange={e => { onWorktreeChange(e.target.checked) }}
                className="h-6 w-6 accent-primary-6"
              />
            </label>
          )}

          <SectionTitle>Agent</SectionTitle>
          {PROVIDERS.map(p => {
            const { available } = providerAvailability(health, p.id)
            const current = p.id === provider
            return (
              <button
                key={p.id}
                type="button"
                disabled={!available}
                aria-pressed={current}
                onClick={() => { if (!current) onProviderChange(p.id) }}
                className={`${ROW} ${available ? 'text-ink hover:bg-edge' : 'cursor-not-allowed text-ink-muted'}`}
              >
                <span className="flex-1">{p.label}<span className="ml-2 text-meta text-ink-muted">{available ? p.description : 'not installed'}</span></span>
                {current && <IconCheck size={16} stroke={2.5} className="shrink-0 text-accent-5" />}
              </button>
            )
          })}

          {availableModels.length > 0 && (
            <>
              <SectionTitle>Model</SectionTitle>
              {availableModels.map(m => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={m.id === currentModel}
                  onClick={() => { onModelChange(m.id) }}
                  className={`${ROW} text-ink hover:bg-edge`}
                >
                  <span className="flex-1 truncate">{m.label}</span>
                  {m.id === currentModel && <IconCheck size={16} stroke={2.5} className="shrink-0 text-accent-5" />}
                </button>
              ))}
            </>
          )}

          <SectionTitle>Permission mode</SectionTitle>
          {permissionModesFor(provider).map(m => (
            <button
              key={m.id}
              type="button"
              aria-pressed={m.id === permissionMode}
              onClick={() => { onPermissionModeChange(m.id) }}
              className={`${ROW} hover:bg-edge`}
            >
              <span className="flex-1">
                <span className={m.dangerous ? 'text-warning-5' : 'text-ink'}>{m.label}</span>
                <span className="block text-meta text-ink-muted">{m.description}</span>
              </span>
              {m.id === permissionMode && <IconCheck size={16} stroke={2.5} className="shrink-0 text-accent-5" />}
            </button>
          ))}
          {provider !== 'claude' && <p className="px-4 pt-1 pb-4 text-meta text-ink-muted">Skip permissions is Claude-only.</p>}
        </div>
      </div>
    </div>
  )
}
