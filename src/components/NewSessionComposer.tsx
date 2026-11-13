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
  IconPencil, IconFolder, IconGitBranch, IconCloudDownload, IconBuilding, IconChevronDown, IconAdjustmentsHorizontal, IconChevronLeft,
} from '@tabler/icons-react'
import { InputBar, type InputBarHandle } from './InputBar'
import { SessionOptionsSheet } from './SessionOptionsSheet'
import { PlacePicker } from './PlacePicker'
import type { RepoGroup } from '../hooks/useRepos'
import { PERMISSION_MODES, type CodingProvider, type ModelOption, type PermissionMode } from '../types'
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
  /** Touch: the options sheet, and the place picker pushed over it. */
  const [sheetOpen, setSheetOpen] = useState(false)
  const [placeScreenOpen, setPlaceScreenOpen] = useState(false)
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
    if (isMobile) { setPlaceScreenOpen(false); return }
    closePicker()
  }, [onPlaceChange, closePicker, isMobile])

  /** Folder paths read as `~/…` once the home directory is known. */
  const labelOf = (p: DraftPlace) => p.kind === 'folder' && p.path ? tildify(p.path, homeDir) : p.label
  const recentChips = recent.filter(p => !samePlace(p, place)).slice(0, RECENT_CHIPS)
  // Worktrees start from a repository root; a subfolder of one runs in place.
  // For an org the switch means one worktree per repository.
  const showWorktree = place.kind === 'org' || (place.git && !place.inRepo)
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
            showOrgPlaces
            onPick={pick}
            onClose={() => { closePicker() }}
          />
        </div>
      )}
    </div>
  )

  // Touch: one Options button names all three choices.
  const modelLabel = currentModel ? availableModels.find(m => m.id === currentModel)?.label ?? currentModel : null
  const modeLabel = PERMISSION_MODES.find(m => m.id === permissionMode)?.label ?? permissionMode
  const optionsButton = (
    <button
      type="button"
      onClick={() => { setSheetOpen(true) }}
      disabled={disabled || sending}
      aria-haspopup="dialog"
      aria-expanded={sheetOpen}
      className="flex min-h-[44px] min-w-0 max-w-full items-center gap-1.5 rounded-control border border-edge-strong px-2.5 text-meta text-ink-muted disabled:opacity-50"
    >
      <IconAdjustmentsHorizontal size={16} stroke={2} className="shrink-0" />
      <span className="truncate">{[labelOf(place), modelLabel, modeLabel].filter(Boolean).join(' · ')}</span>
    </button>
  )

  const recentRow = recentChips.length > 0 && (
    <div className={`mx-auto flex max-w-[var(--measure)] items-center gap-2 ${isMobile ? 'mb-2 overflow-x-auto px-4 pb-1' : 'mt-4 flex-wrap'}`}>
      <span className="shrink-0 text-meta text-ink-muted">Recent</span>
      {recentChips.map(p => (
        <button
          key={placeKey(p)}
          type="button"
          disabled={disabled || sending}
          onClick={() => { onPlaceChange(p) }}
          className={`flex max-w-[240px] shrink-0 items-center gap-1.5 rounded-control border border-edge-strong bg-surface px-2.5 text-meta text-ink-muted transition-colors hover:text-ink disabled:opacity-50 ${isMobile ? 'min-h-[44px]' : 'py-1'}`}
        >
          <PlaceIcon place={p} />
          <span className={`truncate ${p.kind === 'folder' ? 'font-mono' : ''}`}>{labelOf(p)}</span>
        </button>
      ))}
    </div>
  )

  return (
    <div className="flex h-full flex-col overflow-y-auto bg-page">
      <div className={`mx-auto flex w-full max-w-[728px] flex-col ${isMobile ? 'pt-10' : 'pt-[170px]'} pb-10`}>
        <h1 className="mb-4 px-4 text-center text-head font-normal text-ink">What are we working on?</h1>

        {isMobile && recentRow}

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
          // On touch these live in the options sheet, behind one button.
          currentModel={isMobile ? null : currentModel}
          onModelChange={isMobile ? undefined : onModelChange}
          currentEffort={currentEffort}
          onEffortChange={isMobile ? undefined : onEffortChange}
          availableModels={availableModels}
          sessionProvider={isMobile ? undefined : provider}
          onProviderChange={isMobile ? undefined : (p) => { onProviderChange(p) }}
          currentPermissionMode={isMobile ? undefined : permissionMode}
          onPermissionModeChange={isMobile ? undefined : onPermissionModeChange}
          permissionNote={provider !== 'claude' ? 'Skip permissions is Claude-only.' : undefined}
          showWorktreeToggle={!isMobile && showWorktree}
          useWorktree={useWorktree}
          onWorktreeChange={!isMobile && showWorktree ? onWorktreeChange : undefined}
          placeSlot={isMobile ? optionsButton : placeChip}
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

          {!isMobile && recentRow}

          {children && <div className="mx-auto mt-8 max-w-[var(--measure)]">{children}</div>}
        </div>
      </div>

      {isMobile && sheetOpen && !placeScreenOpen && (
        <SessionOptionsSheet
          place={place}
          placeLabel={labelOf(place)}
          onOpenPlace={() => { setPlaceScreenOpen(true) }}
          showWorktree={showWorktree}
          useWorktree={useWorktree}
          onWorktreeChange={onWorktreeChange}
          provider={provider}
          onProviderChange={onProviderChange}
          currentModel={currentModel}
          availableModels={availableModels}
          onModelChange={onModelChange}
          permissionMode={permissionMode}
          onPermissionModeChange={onPermissionModeChange}
          onClose={() => { setSheetOpen(false) }}
        />
      )}
      {isMobile && placeScreenOpen && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface-raised">
          <div className="flex min-h-[52px] items-center gap-1 border-b border-edge px-2">
            <button
              type="button"
              onClick={() => { setPlaceScreenOpen(false) }}
              className="flex min-h-[44px] items-center gap-1 rounded-control px-2 text-body text-accent-5"
            >
              <IconChevronLeft size={18} stroke={2} />
              Options
            </button>
            <h2 className="ml-1 text-title text-ink">Place</h2>
          </div>
          <div className="min-h-0 flex-1">
            <PlacePicker
              token={token}
              groups={groups}
              recent={recent}
              current={place}
              showOrgPlaces
              onPick={pick}
              onClose={() => { setPlaceScreenOpen(false) }}
              variant="screen"
            />
          </div>
        </div>
      )}
    </div>
  )
}
