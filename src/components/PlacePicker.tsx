/**
 * PlacePicker — choose where a new session runs.
 *
 * One searchable list with four views (root, an owner's repos, a folder
 * browser, and search results), driven entirely from the keyboard on the
 * search input: ↑↓ move, ⏎ activates, → opens, ← / Backspace go back while
 * the query is empty, Esc closes. Rows, views and keys are modelled in
 * lib/placePicker.ts; this component renders them and performs the actions
 * (listing folders, the native folder dialog).
 *
 * The caller positions it (a popover under the composer's place chip, or a
 * full-height screen on touch) and closes it on outside clicks.
 */

import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import {
  IconPencil, IconFolder, IconFolderPlus, IconFolderCheck, IconGitBranch, IconCloudDownload,
  IconBuilding, IconChevronLeft, IconChevronRight, IconCheck, IconSearch, IconDeviceDesktop,
} from '@tabler/icons-react'
import type { RepoGroup } from '../hooks/useRepos'
import { useDirBrowser } from '../hooks/useDirBrowser'
import { getNativeFolderPickerAvailable, pickFolderNative } from '../lib/ccApi'
import { placeFromPath, placeKey, samePlace, tildify, type DraftPlace } from '../lib/places'
import {
  INITIAL_PICKER_STATE, enterView, flatRows, isPathQuery, pickerKey, pickerModel, splitPathQuery,
  type PickerKey, type PickerRow, type RowAction, type RowIcon,
} from '../lib/placePicker'

interface Props {
  token?: string
  groups: RepoGroup[]
  recent: DraftPlace[]
  current: DraftPlace
  /** Offer whole-organization places (phase 2). */
  showOrgPlaces?: boolean
  onPick: (place: DraftPlace) => void
  onClose: () => void
  /** `popover` under a chip (desktop); `screen` fills its container (touch). */
  variant?: 'popover' | 'screen'
  className?: string
  style?: CSSProperties
}

const PICKER_KEYS = new Set<string>(['ArrowDown', 'ArrowUp', 'Enter', 'ArrowRight', 'ArrowLeft', 'Backspace', 'Escape'])
/** Delay before completing a typed path, so each keystroke doesn't list a folder. */
const PATH_DEBOUNCE_MS = 120

function RowGlyph({ icon }: { icon: RowIcon }) {
  const props = { size: 15, stroke: 1.8, className: 'shrink-0 text-ink-muted' }
  switch (icon) {
    case 'scratch': return <IconPencil {...props} />
    case 'folder': return <IconFolder {...props} />
    case 'folder-plus': return <IconFolderPlus {...props} />
    case 'folder-check': return <IconFolderCheck {...props} className="shrink-0 text-accent-5" />
    case 'repo': return <IconGitBranch {...props} />
    case 'remote': return <IconCloudDownload {...props} />
    case 'org': return <IconBuilding {...props} />
    case 'local': return <IconDeviceDesktop {...props} />
    case 'back': return <IconChevronLeft {...props} />
  }
}

/** `~ / Documents / site` crumbs for a folder, each with the path it opens. */
function crumbsFor(path: string, home: string | null): { label: string; path: string }[] {
  const shown = tildify(path, home)
  const parts = shown.split('/').filter(Boolean)
  const crumbs: { label: string; path: string }[] = []
  let acc = shown.startsWith('~') ? (home ?? '') : ''
  parts.forEach((part, i) => {
    if (i === 0 && part === '~') {
      crumbs.push({ label: '~', path: home ?? '/' })
      return
    }
    acc = `${acc}/${part}`
    crumbs.push({ label: part, path: acc })
  })
  if (!shown.startsWith('~')) crumbs.unshift({ label: '/', path: '/' })
  return crumbs
}

export function PlacePicker({
  token, groups, recent, current, showOrgPlaces = false, onPick, onClose, variant = 'popover', className = '', style,
}: Props) {
  const browser = useDirBrowser(token)
  const [state, setState] = useState(INITIAL_PICKER_STATE)
  const [nativeAvailable, setNativeAvailable] = useState(false)
  const [refusedPath, setRefusedPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const uid = useId()
  const { open: openDir } = browser

  // Learn the home directory and the allowed roots up front: `~` queries and
  // the out-of-bounds refusal need them before the user browses anywhere.
  useEffect(() => { void openDir() }, [openDir])

  useEffect(() => {
    if (!token) return
    let cancelled = false
    void getNativeFolderPickerAvailable(token).then(ok => { if (!cancelled) setNativeAvailable(ok) })
    return () => { cancelled = true }
  }, [token])

  // Complete a typed path: list the folder it points into.
  const pathQuery = state.view.name === 'root' && isPathQuery(state.query.trim()) ? state.query.trim() : null
  useEffect(() => {
    if (!pathQuery) return
    const { dir } = splitPathQuery(pathQuery, browser.home)
    if (dir === browser.path) return
    const timer = setTimeout(() => {
      void openDir(dir).then(listing => {
        setRefusedPath(listing ? null : dir)
      })
    }, PATH_DEBOUNCE_MS)
    return () => { clearTimeout(timer) }
  }, [pathQuery, browser.home, browser.path, openDir])

  const listing = browser.path !== null
    ? { path: browser.path, dirs: browser.dirs, gitDirs: browser.gitDirs, git: browser.git }
    : null
  const model = pickerModel(state, {
    groups, recent, showOrgPlaces, listing, roots: browser.roots, home: browser.home,
    // Only a refusal of the folder the query points into counts.
    refusedPath: pathQuery && refusedPath && refusedPath === splitPathQuery(pathQuery, browser.home).dir
      && browser.error?.includes('outside') ? refusedPath : null,
  })
  const rows = useMemo(() => flatRows(model), [model])
  const highlight = rows.length ? Math.min(state.highlight, rows.length - 1) : -1
  const rowDomId = (i: number) => `${uid}-row-${i}`

  // Keep the highlighted row visible while moving with the keyboard.
  useEffect(() => {
    if (highlight < 0) return
    const el = document.getElementById(rowDomId(highlight))
    // jsdom has no scrollIntoView.
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' })
  // rowDomId is derived from uid, which is stable.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlight, uid])

  const goRoot = useCallback(() => { setState(enterView({ name: 'root' })) }, [])

  const browseTo = useCallback((path?: string) => {
    setState(enterView({ name: 'browse' }))
    void openDir(path)
  }, [openDir])

  const perform = useCallback(async (action: RowAction) => {
    setActionError(null)
    switch (action.type) {
      case 'pick':
        onPick(action.place)
        return
      case 'open-owner':
        setState(enterView({ name: 'owner', owner: action.owner }))
        return
      case 'browse':
        browseTo(action.path)
        return
      case 'back':
        goRoot()
        return
      case 'up': {
        const path = browser.path
        const atTop = !path || path === '/' || browser.roots.includes(path)
        if (atTop) { goRoot(); return }
        setState(s => ({ ...s, highlight: 1 }))
        await browser.up()
        return
      }
      case 'choose-folder': {
        if (!nativeAvailable || !token) { browseTo(); return }
        setBusy(true)
        try {
          const picked = await pickFolderNative(token)
          if (!picked) return
          // The dialog can return any folder; listing it checks the bounds and git state.
          const info = await openDir(picked)
          if (!info) { setActionError('That folder is outside your home and the repos root.'); return }
          onPick(placeFromPath(info.path, info.git ?? false, info.home ?? browser.home))
        } catch (err) {
          setActionError(err instanceof Error ? err.message : 'Could not open the folder dialog')
        } finally {
          setBusy(false)
        }
      }
    }
  }, [browseTo, browser, goRoot, nativeAvailable, onPick, openDir, token])

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (!PICKER_KEYS.has(e.key) || e.nativeEvent.isComposing) return
    const result = pickerKey(state, rows, e.key as PickerKey)
    if (!result.handled) return
    e.preventDefault()
    e.stopPropagation()
    if (result.close) { onClose(); return }
    setState(result.state)
    if (result.action) void perform(result.action)
  }

  function onQueryChange(query: string) {
    // In owner and browse views row 0 is "back"; land on the first real row.
    setState(s => ({ ...s, query, highlight: s.view.name === 'root' ? 0 : 1 }))
  }

  const currentKey = placeKey(current)
  const isCurrent = (row: PickerRow) =>
    row.action.type === 'pick' && (placeKey(row.action.place) === currentKey || samePlace(row.action.place, current))

  let index = -1
  const frame = variant === 'popover'
    ? 'w-[400px] max-w-[calc(100vw-32px)] rounded-floating border border-edge-strong bg-surface-raised shadow-floating'
    : 'flex h-full w-full flex-col bg-surface-raised'

  return (
    <div
      role="dialog"
      aria-label="Where should this session run?"
      className={`${frame} ${className}`}
      style={style}
    >
      <div className="p-2 pb-1">
        <label htmlFor={`${uid}-q`} className="sr-only">Search places</label>
        <div className="flex items-center gap-2 rounded-control border border-focus bg-page px-2.5">
          <IconSearch size={14} className="shrink-0 text-ink-muted" />
          <input
            ref={inputRef}
            id={`${uid}-q`}
            autoFocus
            autoComplete="off"
            spellCheck={false}
            value={state.query}
            onChange={e => { onQueryChange(e.target.value) }}
            onKeyDown={onKeyDown}
            placeholder={model.placeholder}
            role="combobox"
            aria-expanded="true"
            aria-controls={`${uid}-list`}
            aria-activedescendant={highlight >= 0 ? rowDomId(highlight) : undefined}
            className="density-row min-w-0 flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-muted"
          />
          {(busy || browser.loading) && (
            <span className="h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-ink-muted border-t-transparent" aria-hidden="true" />
          )}
        </div>
      </div>

      {state.view.name === 'browse' && browser.path && (
        <nav aria-label="Folder path" className="flex flex-wrap items-center gap-0.5 px-3 pb-1 font-mono text-meta text-ink-muted">
          {crumbsFor(browser.path, browser.home).map((c, i, all) => (
            <span key={`${c.path}:${i}`} className="flex items-center gap-0.5">
              <button
                type="button"
                tabIndex={-1}
                onMouseDown={e => { e.preventDefault() }}
                onClick={() => { browseTo(c.path) }}
                className={`rounded-control px-0.5 hover:bg-edge hover:text-ink ${i === all.length - 1 ? 'text-ink' : ''}`}
              >
                {c.label}
              </button>
              {i < all.length - 1 && c.label !== '/' && <span aria-hidden="true">/</span>}
            </span>
          ))}
        </nav>
      )}

      <div
        ref={listRef}
        id={`${uid}-list`}
        role="listbox"
        aria-label="Places"
        className={`overflow-y-auto px-2 pb-1 ${variant === 'popover' ? 'max-h-[360px]' : 'flex-1'}`}
      >
        {model.sections.map((section, si) => (
          <div key={si} role="group" aria-label={section.title}>
            {section.title && section.rows.length > 0 && (
              <div className="px-2 pt-2 pb-0.5 text-micro uppercase tracking-wide text-ink-muted">{section.title}</div>
            )}
            {section.rows.map(row => {
              index++
              const i = index
              const active = i === highlight
              const selected = isCurrent(row)
              return (
                <button
                  key={row.id}
                  id={rowDomId(i)}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  onMouseDown={e => { e.preventDefault() }}
                  onMouseMove={() => { if (!active) setState(s => ({ ...s, highlight: i })) }}
                  onClick={() => { void perform(row.action) }}
                  className={`density-row flex w-full items-center gap-2 rounded-control px-2 text-left text-body ${active ? 'bg-edge text-ink' : 'text-ink'}`}
                >
                  <RowGlyph icon={row.icon} />
                  <span className={`truncate ${row.mono ? 'font-mono' : ''} ${row.accent ? 'text-accent-5' : ''}`}>{row.label}</span>
                  {row.meta && <span className="truncate text-meta text-ink-muted">{row.meta}</span>}
                  <span className="ml-auto flex shrink-0 items-center gap-1.5">
                    {row.tag && (
                      <span className="rounded-control border border-edge px-1 text-micro text-ink-muted">{row.tag}</span>
                    )}
                    {selected && <IconCheck size={14} stroke={2} className="text-accent-5" aria-label="current place" />}
                    {row.opens && <IconChevronRight size={13} className="text-ink-muted" aria-hidden="true" />}
                  </span>
                </button>
              )
            })}
          </div>
        ))}
        {model.notices.map(n => (
          <p
            key={n.id}
            role={n.tone === 'error' ? 'alert' : undefined}
            className={`px-2 py-2 text-meta ${n.tone === 'error' ? 'text-error-5' : 'text-ink-muted'}`}
          >
            {n.text}
          </p>
        ))}
        {actionError && <p role="alert" className="px-2 py-2 text-meta text-error-5">{actionError}</p>}
        {state.view.name === 'browse' && browser.error && !browser.loading && (
          <p role="alert" className="px-2 py-2 text-meta text-error-5">{browser.error}</p>
        )}
      </div>

      <div className="border-t border-edge px-3 py-1.5 text-micro text-ink-muted">{model.footer}</div>
    </div>
  )
}
