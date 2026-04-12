/**
 * Model picker for workflow modals.
 *
 * - ≤5 models: simple button row (same style as the existing picker)
 * - >5 models: searchable dropdown with recent selections on top
 *
 * Mirrors the search + recents UX from the chat InputBar ModelDropdown.
 */

import { useState, useRef, useEffect } from 'react'
import { IconSearch, IconChevronDown } from '@tabler/icons-react'
import type { ModelOption } from '../../types'

const RECENTS_KEY = 'codekin.workflowRecentModels'
const MAX_RECENTS = 5

function getRecents(): string[] {
  try { return JSON.parse(localStorage.getItem(RECENTS_KEY) || '[]') } catch { return [] }
}

function addRecent(id: string) {
  if (!id) return
  const next = getRecents().filter(m => m !== id)
  next.unshift(id)
  localStorage.setItem(RECENTS_KEY, JSON.stringify(next.slice(0, MAX_RECENTS)))
}

const btnClass = (selected: boolean) =>
  `rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${
    selected
      ? 'border-accent-6 bg-accent-9/40 text-accent-2'
      : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
  }`

// ---------------------------------------------------------------------------
// Inline button row (≤5 models)
// ---------------------------------------------------------------------------

function InlinePicker({ models, selected, onSelect }: {
  models: ModelOption[]; selected: string; onSelect: (id: string) => void
}) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {models.map(m => (
        <button
          key={m.id}
          type="button"
          onClick={() => onSelect(m.id)}
          className={btnClass(selected === m.id)}
        >
          {m.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Searchable dropdown (>5 models)
// ---------------------------------------------------------------------------

function SearchablePicker({ models, selected, onSelect }: {
  models: ModelOption[]; selected: string; onSelect: (id: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [activeIndex, setActiveIndex] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  // Close on outside click
  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  // Focus search on open
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const recents = getRecents().filter(id => models.some(m => m.id === id))

  const filtered = query
    ? models.filter(m =>
        m.id.toLowerCase().includes(query.toLowerCase()) ||
        m.label.toLowerCase().includes(query.toLowerCase())
      )
    : models

  // Exclude recents from the "All Models" section to avoid duplicates
  const allWithoutRecents = (!query && recents.length > 0)
    ? filtered.filter(m => !recents.includes(m.id))
    : filtered

  const visibleList = (!query && recents.length > 0)
    ? [...recents.map(id => models.find(m => m.id === id)).filter(Boolean) as ModelOption[], ...allWithoutRecents]
    : filtered

  // Scroll active item into view
  useEffect(() => {
    const el = itemRefs.current[activeIndex]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const handleSelect = (id: string) => {
    addRecent(id)
    onSelect(id)
    setOpen(false)
    setQuery('')
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!visibleList.length) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex(i => Math.min(i + 1, visibleList.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex(i => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const m = visibleList[activeIndex]
      if (m) handleSelect(m.id)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const selectedLabel = models.find(m => m.id === selected)?.label ?? selected ?? 'Default'

  return (
    <div className="relative" ref={containerRef}>
      {/* Trigger button */}
      <button
        type="button"
        onClick={() => { setOpen(o => !o); setActiveIndex(0) }}
        className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[13px] font-medium transition-colors ${
          selected
            ? 'border-accent-6 bg-accent-9/40 text-accent-2'
            : 'border-neutral-7 bg-neutral-10 text-neutral-3 hover:border-neutral-6 hover:text-neutral-2'
        }`}
      >
        {selectedLabel}
        <IconChevronDown size={14} stroke={2} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full mt-1 left-0 z-50 w-[280px] max-h-[320px] rounded-lg border border-neutral-6 bg-neutral-8 shadow-lg flex flex-col">
          {/* Search */}
          <div className="p-2 border-b border-neutral-7">
            <div className="relative">
              <IconSearch size={14} stroke={2} className="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-5" />
              <input
                ref={inputRef}
                value={query}
                onChange={e => { setQuery(e.target.value); setActiveIndex(0) }}
                onKeyDown={handleKeyDown}
                placeholder="Search models..."
                className="w-full bg-neutral-7 text-[13px] pl-7 pr-2 py-1.5 rounded-md outline-none text-neutral-2 placeholder:text-neutral-5"
              />
            </div>
          </div>

          {/* List */}
          <div className="overflow-y-auto py-1">
            {!query && recents.length > 0 && (
              <div className="mb-1">
                <div className="px-3 py-1 text-[11px] text-neutral-5 uppercase tracking-wide">Recent</div>
                {recents.map((id, idx) => {
                  const m = models.find(x => x.id === id)
                  if (!m) return null
                  return (
                    <button
                      key={`recent-${m.id}`}
                      ref={el => { itemRefs.current[idx] = el }}
                      type="button"
                      onClick={() => handleSelect(m.id)}
                      className={`w-full text-left px-3 py-1.5 text-[13px] transition-colors ${
                        idx === activeIndex ? 'bg-neutral-7' : 'hover:bg-neutral-7'
                      } ${m.id === selected ? 'text-accent-3' : 'text-neutral-2'}`}
                    >
                      {m.label}
                    </button>
                  )
                })}
              </div>
            )}

            <div>
              {!query && (
                <div className="px-3 py-1 text-[11px] text-neutral-5 uppercase tracking-wide">All Models</div>
              )}
              {allWithoutRecents.length === 0 && (
                <div className="px-3 py-2 text-[13px] text-neutral-5">No models match your search</div>
              )}
              {allWithoutRecents.map((m, idx) => {
                const baseIndex = (!query && recents.length > 0) ? recents.length : 0
                const index = baseIndex + idx
                return (
                  <button
                    key={m.id}
                    ref={el => { itemRefs.current[index] = el }}
                    type="button"
                    onClick={() => handleSelect(m.id)}
                    className={`w-full text-left px-3 py-1.5 text-[13px] transition-colors ${
                      index === activeIndex ? 'bg-neutral-7' : 'hover:bg-neutral-7'
                    } ${m.id === selected ? 'text-accent-3' : 'text-neutral-2'}`}
                  >
                    {m.label}
                  </button>
                )
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

interface WorkflowModelPickerProps {
  models: ModelOption[]
  selected: string
  onSelect: (modelId: string) => void
  loading?: boolean
}

/** Model picker that switches between inline buttons (≤5) and searchable dropdown (>5). */
export function WorkflowModelPicker({ models, selected, onSelect, loading }: WorkflowModelPickerProps) {
  if (loading) {
    return <div className="text-[13px] text-neutral-5">Loading models...</div>
  }

  if (models.length === 0) {
    return <div className="text-[13px] text-neutral-5">No models available</div>
  }

  if (models.length <= 5) {
    return <InlinePicker models={models} selected={selected} onSelect={onSelect} />
  }

  return <SearchablePicker models={models} selected={selected} onSelect={onSelect} />
}
