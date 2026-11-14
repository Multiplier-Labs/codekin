/**
 * ContextBar — where a running session works, and + Attach.
 *
 * A thin strip above the transcript: the session's own place, one chip per
 * attached folder (× detaches it), and **+ Attach folder, repo or org**,
 * which opens the same PlacePicker the composer uses (without the scratch
 * row). The caller resolves the picked place to a folder (clone, org folder)
 * and attaches it; the strip only shows progress and errors.
 *
 * On a phone the strip scrolls sideways and the picker fills the screen.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { IconBuilding, IconChevronLeft, IconFolder, IconGitBranch, IconGitBranchDeleted, IconPencil, IconPlus, IconX } from '@tabler/icons-react'
import type { RepoGroup } from '../hooks/useRepos'
import type { AttachedPlace, SessionPlace } from '../types'
import { sessionPlaceLabel, type DraftPlace } from '../lib/places'
import { browseDirs } from '../lib/ccApi'
import { PlacePicker } from './PlacePicker'

interface Props {
  token?: string
  /** The session's own folder and place. */
  path: string
  place: SessionPlace
  attached: AttachedPlace[]
  home?: string | null
  groups: RepoGroup[]
  recent: DraftPlace[]
  isMobile?: boolean
  disabled?: boolean
  /** Resolve and attach a picked place; reports progress, throws on failure. */
  onAttach: (place: DraftPlace, onProgress: (text: string) => void) => Promise<void>
  onDetach: (path: string) => Promise<void>
  /** The session's git worktree (shown here rather than in the composer). */
  worktree?: { path: string; branch?: string }
  /** Offered when the session runs in the shared checkout of a repository. */
  onMoveToWorktree?: () => void
}

function KindIcon({ place }: { place: SessionPlace }) {
  const props = { size: 14, stroke: 2, className: 'shrink-0' }
  if (place.kind === 'scratch') return <IconPencil {...props} />
  if (place.kind === 'org') return <IconBuilding {...props} />
  return place.git ? <IconGitBranch {...props} /> : <IconFolder {...props} />
}

const CHIP = 'flex shrink-0 items-center gap-1.5 rounded-control border border-edge-strong px-2 py-0.5 text-meta text-ink-muted'

export function ContextBar({
  token, path, place, attached, home, groups, recent, isMobile = false, disabled = false, onAttach, onDetach, worktree, onMoveToWorktree,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [progress, setProgress] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [learnedHome, setLearnedHome] = useState<string | null>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const busy = progress !== null

  // `~/…` labels need the machine's home directory.
  useEffect(() => {
    if (home !== undefined || !token) return
    let cancelled = false
    void browseDirs(token).then(l => { if (!cancelled) setLearnedHome(l.home ?? null) }).catch(() => {})
    return () => { cancelled = true }
  }, [home, token])
  const homeDir = home !== undefined ? home : learnedHome
  const placeLabel = (p: string, pl: SessionPlace) => sessionPlaceLabel(p, pl, homeDir)

  // Close the popover on outside clicks (the touch screen has its own back button).
  useEffect(() => {
    if (!pickerOpen || isMobile) return
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => { document.removeEventListener('mousedown', onDown) }
  }, [pickerOpen, isMobile])

  const pick = useCallback((picked: DraftPlace) => {
    setPickerOpen(false)
    setError(null)
    setProgress('Attaching…')
    void onAttach(picked, setProgress)
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { setProgress(null) })
  }, [onAttach])

  const detach = useCallback((target: string) => {
    setError(null)
    setProgress('Detaching…')
    void onDetach(target)
      .catch((err: unknown) => { setError(err instanceof Error ? err.message : String(err)) })
      .finally(() => { setProgress(null) })
  }, [onDetach])

  const picker = (variant: 'popover' | 'screen') => (
    <PlacePicker
      token={token}
      groups={groups}
      recent={recent}
      current={{ kind: place.kind, path, git: place.git, label: placeLabel(path, place) }}
      showOrgPlaces
      allowScratch={false}
      onPick={pick}
      onClose={() => { setPickerOpen(false) }}
      variant={variant}
    />
  )

  return (
    <div ref={wrapRef} className="relative flex-shrink-0 border-b border-edge">
      <div className="flex items-center gap-1.5 overflow-x-auto px-3 py-1.5" role="toolbar" aria-label="Where this session works">
        <span className={CHIP} title={path}>
          <KindIcon place={place} />
          <span className={place.kind === 'folder' || place.kind === 'scratch' ? 'font-mono' : ''}>{placeLabel(path, place)}</span>
        </span>
        {worktree ? (
          <span className={`${CHIP} border-transparent text-primary-5`} title={`In a worktree: ${worktree.path}`}>
            <IconGitBranch size={14} stroke={2} className="shrink-0" />
            <span className="max-w-[220px] truncate font-mono">{worktree.branch ?? worktree.path.split('/').pop()}</span>
          </span>
        ) : onMoveToWorktree && (
          <button
            type="button"
            onClick={onMoveToWorktree}
            disabled={disabled || busy}
            className={`${CHIP} border-transparent hover:text-ink disabled:opacity-50`}
            title="This session works in the repository's own checkout — move it into a git worktree"
          >
            <IconGitBranchDeleted size={14} stroke={2} className="shrink-0" />
            No worktree
          </button>
        )}
        {attached.map(a => (
          <span key={a.path} className={`${CHIP} pr-1`} title={a.path}>
            <KindIcon place={a.place} />
            <span className={a.place.kind === 'folder' ? 'font-mono' : ''}>{placeLabel(a.path, a.place)}</span>
            <button
              type="button"
              onClick={() => { detach(a.path) }}
              disabled={disabled || busy}
              aria-label={`Detach ${placeLabel(a.path, a.place)}`}
              title="Detach"
              className="rounded-control p-0.5 text-ink-muted hover:bg-surface-raised hover:text-ink disabled:opacity-50"
            >
              <IconX size={12} stroke={2} />
            </button>
          </span>
        ))}
        <button
          type="button"
          onClick={() => { setPickerOpen(o => !o) }}
          disabled={disabled || busy}
          aria-haspopup="dialog"
          aria-expanded={pickerOpen}
          className={`${CHIP} border-dashed hover:text-ink disabled:opacity-50`}
        >
          <IconPlus size={14} stroke={2} className="shrink-0" />
          {progress ?? 'Attach folder, repo or org'}
        </button>
        {error && <span className="shrink-0 text-meta text-error-4" role="alert">{error}</span>}
      </div>
      {pickerOpen && !isMobile && (
        <div className="absolute left-3 top-full z-50 mt-1">{picker('popover')}</div>
      )}
      {pickerOpen && isMobile && (
        <div className="fixed inset-0 z-50 flex flex-col bg-surface-raised">
          <div className="flex min-h-[52px] items-center gap-1 border-b border-edge px-2">
            <button
              type="button"
              onClick={() => { setPickerOpen(false) }}
              className="flex min-h-[44px] items-center gap-1 rounded-control px-2 text-body text-accent-5"
            >
              <IconChevronLeft size={18} stroke={2} />
              Back
            </button>
            <h2 className="ml-1 text-title text-ink">Attach</h2>
          </div>
          <div className="min-h-0 flex-1">{picker('screen')}</div>
        </div>
      )}
    </div>
  )
}
