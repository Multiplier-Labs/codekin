/**
 * NewSessionComposer — the draft screen behind New.
 *
 * An empty composer headed "What are we working on?". The place the session
 * runs in is a chip in the composer's toolbar (beside attach), next to the
 * agent and permission controls, rather than a step in front of the first
 * keystroke. Nothing is created until Send: the caller runs the Send
 * sequence (scratch folder, clone, create) and keeps the draft if it fails.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import {
  IconPencil, IconFolder, IconGitBranch, IconCloudDownload, IconBuilding, IconChevronDown,
} from '@tabler/icons-react'
import { InputBar, type InputBarHandle } from './InputBar'
import { PlacePicker } from './PlacePicker'
import type { RepoGroup } from '../hooks/useRepos'
import type { CodingProvider, ModelOption, PermissionMode } from '../types'
import { placeHint, placeKey, samePlace, tildify, type DraftPlace } from '../lib/places'
import { browseDirs, getScratchRoot } from '../lib/ccApi'

interface Props {
  token?: string
  groups: RepoGroup[]
  isMobile: boolean
  disabled: boolean

  place: DraftPlace
  onPlaceChange: (place: DraftPlace) => void
  recent: DraftPlace[]
  /** For the hint line: `~` display and where scratch folders go. Fetched from the machine when omitted. */
  home?: string | null
  scratchRoot?: string | null

  /** Draft text to start from (kept across visits and failed sends). */
  initialText: string
  onTextChange: (text: string) => void
  /** Bump to reset the textarea to `initialText` (after a failed send). */
  resetKey: number

  provider: CodingProvider
  onProviderChange: (provider: CodingProvider) => void
  currentModel: string | null
  onModelChange: (model: string) => void
  currentEffort: string | null
  onEffortChange: (effort: string | null) => void
  availableModels: ModelOption[]
  permissionMode: PermissionMode
  onPermissionModeChange: (mode: PermissionMode) => void
  useWorktree: boolean
  onWorktreeChange: (on: boolean) => void

  /** A Send is in flight; the line says which step. */
  progress: string | null
  error: string | null
  onSend: (text: string, files: File[]) => void

  /** Rendered under the composer (environment checks, gh status). */
  children?: ReactNode
}

function PlaceIcon({ place }: { place: DraftPlace }) {
  const props = { size: 14, stroke: 2, className: 'shrink-0' }
  if (place.kind === 'scratch') return <IconPencil {...props} />
  if (place.kind === 'org') return <IconBuilding {...props} />
  if (place.kind === 'repo') return place.path ? <IconGitBranch {...props} /> : <IconCloudDownload {...props} />
  return place.git ? <IconGitBranch {...props} /> : <IconFolder {...props} />
}

/** How many recent places sit under the composer as one-click chips. */
const RECENT_CHIPS = 3

export function NewSessionComposer({
  token, groups, isMobile, disabled, place, onPlaceChange, recent, home, scratchRoot,
  initialText, onTextChange, resetKey,
  provider, onProviderChange, currentModel, onModelChange, currentEffort, onEffortChange, availableModels,
  permissionMode, onPermissionModeChange, useWorktree, onWorktreeChange,
  progress, error, onSend, children,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [machine, setMachine] = useState<{ home: string | null; scratchRoot: string | null }>({ home: null, scratchRoot: null })
  const [files, setFiles] = useState<File[]>([])
  const chipRef = useRef<HTMLButtonElement>(null)
  const pickerRef = useRef<HTMLDivElement>(null)
  const inputBarRef = useRef<InputBarHandle>(null)
  const sending = progress !== null

  // The hint shows paths as `~/…` and names the scratch folder's location;
  // both come from the machine, not the browser.
  useEffect(() => {
    if (!token || (home !== undefined && scratchRoot !== undefined)) return
    let cancelled = false
    void Promise.allSettled([browseDirs(token), getScratchRoot(token)]).then(([dirs, scratch]) => {
      if (cancelled) return
      setMachine({
        home: dirs.status === 'fulfilled' ? dirs.value.home ?? null : null,
        scratchRoot: scratch.status === 'fulfilled' ? scratch.value.effective : null,
      })
    })
    return () => { cancelled = true }
  }, [token, home, scratchRoot])
  const homeDir = home !== undefined ? home : machine.home
  const scratchDir = scratchRoot !== undefined ? scratchRoot : machine.scratchRoot

  const closePicker = useCallback((returnFocus = true) => {
    setPickerOpen(false)
    if (returnFocus) chipRef.current?.focus()
  }, [])

  // Outside clicks close the picker (Esc is handled inside it).
  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e: MouseEvent) {
      const t = e.target as Node
      if (pickerRef.current?.contains(t) || chipRef.current?.contains(t)) return
      closePicker(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [pickerOpen, closePicker])

  const pick = useCallback((next: DraftPlace) => {
    onPlaceChange(next)
    closePicker()
  }, [onPlaceChange, closePicker])

  /** Folder paths read as `~/…` once the home directory is known. */
  const labelOf = (p: DraftPlace) => p.kind === 'folder' && p.path ? tildify(p.path, homeDir) : p.label
  const recentChips = recent.filter(p => !samePlace(p, place) && p.kind !== 'org').slice(0, RECENT_CHIPS)
  const showWorktree = place.git && place.kind !== 'org'
  const hint = progress ?? placeHint(place, useWorktree, { home: homeDir, scratchRoot: scratchDir })

  const placeChip = (
    <div className="relative min-w-0">
      <button
        ref={chipRef}
        type="button"
        onClick={() => { setPickerOpen(o => !o) }}
        disabled={disabled || sending}
        aria-haspopup="dialog"
        aria-expanded={pickerOpen}
        title="Where this session runs"
        className={`flex max-w-[220px] items-center gap-1.5 rounded-control border px-2 py-0.5 text-meta transition-colors disabled:opacity-50 ${
          pickerOpen ? 'border-focus bg-surface-raised text-ink' : 'border-edge-strong text-ink-muted hover:text-ink'
        }`}
      >
        <PlaceIcon place={place} />
        <span className={`truncate ${place.kind === 'folder' ? 'font-mono' : ''}`}>{labelOf(place)}</span>
        <IconChevronDown size={12} stroke={2} className="shrink-0 opacity-70" />
      </button>
      {pickerOpen && (
        <div ref={pickerRef} className="absolute top-full left-0 z-50 mt-1.5">
          <PlacePicker
            token={token}
            groups={groups}
            recent={recent}
            current={place}
            onPick={pick}
            onClose={() => { closePicker() }}
          />
        </div>
      )}
    </div>
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-page">
      <div className={`mx-auto flex w-full max-w-[728px] flex-col ${isMobile ? 'pt-10' : 'pt-[170px]'} pb-10`}>
        <h1 className="mb-4 px-4 text-center text-head font-normal text-ink">What are we working on?</h1>

        <InputBar
          key={resetKey}
          ref={inputBarRef}
          variant="draft"
          onSendInput={(text) => {
            if (!text.trim() || sending) return
            onSend(text, files)
          }}
          isWaiting={false}
          disabled={disabled || sending}
          onEscape={() => {}}
          pendingFiles={files}
          onAddFiles={(added) => { setFiles(prev => [...prev, ...added]) }}
          onRemoveFile={(i) => { setFiles(prev => prev.filter((_, j) => j !== i)) }}
          initialValue={initialText}
          onValueChange={onTextChange}
          placeholder="Describe a task, paste an error, or drop files…"
          isMobile={isMobile}
          currentModel={currentModel}
          onModelChange={onModelChange}
          currentEffort={currentEffort}
          onEffortChange={onEffortChange}
          availableModels={availableModels}
          sessionProvider={provider}
          onProviderChange={(p) => { onProviderChange(p) }}
          currentPermissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          permissionNote={provider !== 'claude' ? 'Skip permissions is Claude-only.' : undefined}
          showWorktreeToggle={showWorktree}
          useWorktree={useWorktree}
          onWorktreeChange={showWorktree ? onWorktreeChange : undefined}
          placeSlot={placeChip}
        />

        <div className="px-4 @container">
          <p className="mx-auto max-w-[var(--measure)] px-1 text-meta text-ink-muted" role="status" aria-live="polite">
            {hint}
          </p>

          {error && (
            <div role="alert" className="mx-auto mt-2 max-w-[var(--measure)] rounded-control bg-error-10/50 px-3 py-2 text-meta text-error-4">
              {error}
            </div>
          )}

          {recentChips.length > 0 && (
            <div className="mx-auto mt-4 flex max-w-[var(--measure)] flex-wrap items-center gap-2">
              <span className="text-meta text-ink-muted">Recent</span>
              {recentChips.map(p => (
                <button
                  key={placeKey(p)}
                  type="button"
                  disabled={disabled || sending}
                  onClick={() => { onPlaceChange(p) }}
                  className="flex max-w-[240px] items-center gap-1.5 rounded-control border border-edge-strong bg-surface px-2.5 py-1 text-meta text-ink-muted transition-colors hover:text-ink disabled:opacity-50"
                >
                  <PlaceIcon place={p} />
                  <span className={`truncate ${p.kind === 'folder' ? 'font-mono' : ''}`}>{labelOf(p)}</span>
                </button>
              ))}
            </div>
          )}

          {children && <div className="mx-auto mt-8 max-w-[var(--measure)]">{children}</div>}
        </div>
      </div>
    </div>
  )
}
