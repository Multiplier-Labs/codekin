/**
 * A live preview in Canvas (docs/CANVAS-SPEC.md §9): a dev server on this
 * machine, framed through Codekin's preview proxy on its own origin.
 *
 * The toolbar has back/forward/reload, the page's path, viewport sizes, the
 * element picker and the console; servers Codekin started also have their
 * output and Stop/Restart. When the server isn't answering, the frame is
 * replaced by its status, so a stopped server never shows a stale page.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IconAlertTriangle, IconArrowLeft, IconArrowRight, IconClick, IconDeviceDesktop, IconDeviceMobile, IconDeviceTablet,
  IconExternalLink, IconInfoCircle, IconLoader2, IconPlayerPlay, IconPlayerStop, IconRefresh, IconRotateClockwise, IconSend, IconTerminal2, IconX,
} from '@tabler/icons-react'
import type { PreviewApi } from '../../hooks/useCanvas'
import type { CanvasItem, PreviewState, PreviewTarget } from '../../types'
import type { CanvasSelectionKind } from '../../lib/canvasContext'
import {
  consoleContext, entryUrl, parseFromPreview, pickedContext, previewOrigin, serverLogContext,
  type ConsoleEntry, type ToPreview,
} from '../../lib/previewProtocol'

interface Props {
  item: CanvasItem
  /** The item's content: its PreviewTarget (JSON). */
  content: string
  preview: PreviewApi
  onAttach: (what: CanvasSelectionKind, excerpt: string, label: string, ask: boolean) => void
  isMobile?: boolean
}

const HOSTED = import.meta.env.VITE_APP_MODE === 'hosted'
const VIEWPORTS = { full: null, tablet: 820, phone: 390 } as const
type Viewport = keyof typeof VIEWPORTS
const MAX_CONSOLE = 200
/** After the page loads, how long to wait for the preview script before saying it isn't connected. */
const CONNECT_GRACE_MS = 4000

const SERVER_BTN = 'flex h-8 shrink-0 items-center gap-1 rounded-control px-2 text-meta text-ink hover:bg-surface-raised'
const ICON_BTN = 'density-icon-btn inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-control text-ink-muted hover:bg-surface-raised hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent'

function parseTarget(content: string): PreviewTarget | null {
  try {
    const t = JSON.parse(content) as PreviewTarget
    return typeof t.port === 'number' && typeof t.path === 'string' ? t : null
  } catch {
    return null
  }
}

export function PreviewView({ item, content, preview, onAttach, isMobile }: Props) {
  const target = useMemo(() => parseTarget(content), [content])
  const state = preview.state(item.id)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // Ask for the proxy whenever the item (or where it points) changes.
  const openPreview = preview.open
  useEffect(() => { openPreview(item.id) }, [item.id, content, openPreview])

  const origin = state?.proxyPort ? previewOrigin(state.proxyPort, window.location) : null
  const mixed = window.location.protocol === 'https:'
  const running = state?.status === 'running'
  const showFrame = !HOSTED && !mixed && running && !!origin && !!state.entry

  /** Path the frame was last sent to (by us); `current` is where the app says it is now. */
  const [loadPath, setLoadPath] = useState(target?.path ?? '/')
  const [current, setCurrent] = useState<{ path: string; title: string } | null>(null)
  const [pathDraft, setPathDraft] = useState<string | null>(null)
  const [generation, setGeneration] = useState(0)
  const [viewport, setViewport] = useState<Viewport>('full')
  const [connected, setConnected] = useState(false)
  const [loadedUnconnected, setLoadedUnconnected] = useState(false)
  const [picking, setPicking] = useState(false)
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([])
  const [drawer, setDrawer] = useState<'console' | 'server' | null>(null)

  // The item points somewhere new: start there.
  useEffect(() => {
    setLoadPath(target?.path ?? '/') // eslint-disable-line react-hooks/set-state-in-effect -- follows the item's target
    setCurrent(null)
  }, [target?.path, target?.port])

  // Each time the frame (re)mounts it starts unconnected, with an empty console.
  const frameKey = `${origin ?? ''}|${state?.entry ?? ''}|${generation}|${showFrame ? 'on' : 'off'}`
  useEffect(() => {
    setConnected(false) // eslint-disable-line react-hooks/set-state-in-effect -- reset per frame load
    setLoadedUnconnected(false)
    setPicking(false)
    setConsoleEntries([])
  }, [frameKey])

  const src = showFrame && origin && state.entry ? entryUrl(origin, state.entry, loadPath) : null

  const post = useCallback((msg: ToPreview) => {
    if (origin) frameRef.current?.contentWindow?.postMessage(msg, origin)
  }, [origin])

  useEffect(() => {
    if (!origin) return
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow || event.origin !== origin) return
      const msg = parseFromPreview(event.data)
      if (!msg) return
      switch (msg.type) {
        case 'codekin-preview:ready':
          setConnected(true)
          setLoadedUnconnected(false)
          post({ type: 'codekin-preview:hello' })
          break
        case 'codekin-preview:location':
          setCurrent({ path: msg.path, title: msg.title })
          break
        case 'codekin-preview:console':
          setConsoleEntries(prev => [...prev, { level: msg.level, message: msg.message, path: msg.path, at: Date.now() }].slice(-MAX_CONSOLE))
          break
        case 'codekin-preview:picked': {
          const { label, excerpt } = pickedContext(msg.picked, target?.port ?? state?.targetPort ?? 0)
          onAttach('element', excerpt, label, true)
          break
        }
        case 'codekin-preview:pick-ended':
          setPicking(false)
          break
      }
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [origin, post, onAttach, target?.port, state?.targetPort])

  const onFrameLoad = () => {
    // The app may block the preview script (a strict CSP): the page still works, the tools don't.
    setTimeout(() => { setConnected(c => { if (!c) setLoadedUnconnected(true); return c }) }, CONNECT_GRACE_MS)
  }

  const togglePick = () => {
    const next = !picking
    setPicking(next)
    post({ type: 'codekin-preview:pick', on: next })
  }
  const reload = () => {
    if (connected) post({ type: 'codekin-preview:reload' })
    else setGeneration(g => g + 1)
  }
  const navigate = (raw: string) => {
    const path = raw.trim() || '/'
    setPathDraft(null)
    setLoadPath(path.startsWith('/') ? path : `/${path}`)
    setGeneration(g => g + 1)
  }
  const openInTab = () => {
    if (origin && state?.entry) window.open(entryUrl(origin, state.entry, current?.path ?? loadPath), '_blank', 'noopener,noreferrer')
  }

  // Server output: fetched when the drawer opens on it, then kept current by broadcasts.
  const requestLogs = preview.requestLogs
  useEffect(() => { if (drawer === 'server') requestLogs(item.id) }, [drawer, item.id, requestLogs])

  if (!target) return <p className="m-8 text-body text-error-5" role="alert">This preview item can't be read.</p>

  const errors = consoleEntries.filter(e => e.level === 'error').length
  const warnings = consoleEntries.length - errors
  const config = state?.config ?? target.config
  const canStart = !!config && !state?.managed && state?.status !== 'running' && state?.status !== 'starting'
  const shownPath = pathDraft ?? current?.path ?? loadPath
  const logs = preview.logs(item.id)
  const width = VIEWPORTS[viewport]
  const note = state?.notice
    || (running ? state.error : undefined)
    || (showFrame && loadedUnconnected
      ? 'This page didn\'t connect to Codekin (it may block added scripts), so the picker, console and back/forward are off. If it stays blank, this browser may not reach the preview port.'
      : undefined)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Toolbar */}
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-edge bg-surface px-2 py-1">
        <button type="button" className={ICON_BTN} disabled={!connected} onClick={() => { post({ type: 'codekin-preview:history', go: -1 }) }} title="Back" aria-label="Back"><IconArrowLeft size={17} /></button>
        <button type="button" className={ICON_BTN} disabled={!connected} onClick={() => { post({ type: 'codekin-preview:history', go: 1 }) }} title="Forward" aria-label="Forward"><IconArrowRight size={17} /></button>
        <button type="button" className={ICON_BTN} disabled={!showFrame} onClick={reload} title="Reload" aria-label="Reload"><IconRefresh size={17} /></button>
        <form
          className="flex min-w-[140px] flex-1 items-center rounded-control border border-edge bg-page px-2 focus-within:border-focus"
          onSubmit={(e) => { e.preventDefault(); navigate(shownPath) }}
        >
          <span className="shrink-0 font-mono text-meta text-ink-faint">localhost:{state?.targetPort ?? target.port}</span>
          <input
            value={shownPath}
            onChange={(e) => { setPathDraft(e.target.value) }}
            onBlur={() => { setPathDraft(null) }}
            aria-label="Page path"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent py-1 font-mono text-meta text-ink outline-none"
          />
        </form>
        {!isMobile && (
          <div className="flex items-center" role="radiogroup" aria-label="Viewport">
            {([['full', IconDeviceDesktop, 'Full width'], ['tablet', IconDeviceTablet, 'Tablet (820 px)'], ['phone', IconDeviceMobile, 'Phone (390 px)']] as const).map(([v, Icon, label]) => (
              <button key={v} type="button" role="radio" aria-checked={viewport === v} onClick={() => { setViewport(v) }} title={label} aria-label={label}
                className={`${ICON_BTN} ${viewport === v ? 'bg-primary-11 text-ink' : ''}`}>
                <Icon size={17} />
              </button>
            ))}
          </div>
        )}
        <button type="button" onClick={togglePick} disabled={!connected} aria-pressed={picking}
          title={connected ? 'Pick an element to point the agent at (Esc cancels)' : 'The picker needs the page to be connected'}
          className={`flex h-8 shrink-0 items-center gap-1.5 rounded-control px-2 text-meta disabled:opacity-40 ${picking ? 'bg-primary-fill text-on-primary-fill' : 'text-ink hover:bg-surface-raised'}`}>
          <IconClick size={16} /> {picking ? 'Picking…' : 'Pick'}
        </button>
        <button type="button" onClick={() => { setDrawer(d => (d === 'console' ? null : 'console')) }} aria-pressed={drawer === 'console'}
          title="Console" aria-label={`Console: ${errors} errors, ${warnings} warnings`}
          className={`flex h-8 shrink-0 items-center gap-1 rounded-control px-2 text-meta hover:bg-surface-raised ${errors ? 'text-error-5' : warnings ? 'text-warning-5' : 'text-ink-muted'} ${drawer === 'console' ? 'bg-surface-raised' : ''}`}>
          <IconAlertTriangle size={16} /> {errors + warnings}
        </button>
        <button type="button" onClick={() => { setDrawer(d => (d === 'server' ? null : 'server')) }} aria-pressed={drawer === 'server'}
          className={`${ICON_BTN} ${drawer === 'server' ? 'bg-surface-raised text-ink' : ''}`} title="Server output" aria-label="Server output">
          <IconTerminal2 size={17} />
        </button>
        <span className="mx-1 h-5 w-px shrink-0 bg-edge" />
        <StatusPill state={state} />
        {state?.managed && (
          <>
            <button type="button" onClick={() => { preview.restart(item.id) }} className={SERVER_BTN} title={`Restart ${config ?? 'the server'}`} aria-label="Restart server">
              <IconRotateClockwise size={15} className="text-warning-5" /> Restart
            </button>
            <button type="button" onClick={() => { preview.stop(item.id) }} className={SERVER_BTN} title={`Stop ${config ?? 'the server'}`} aria-label="Stop server">
              <IconPlayerStop size={15} className="text-error-5" /> Stop
            </button>
          </>
        )}
        {canStart && (
          <button type="button" onClick={() => { preview.launch(config) }} className={SERVER_BTN} title={state?.command ? `Run ${state.command}` : `Start ${config}`}>
            <IconPlayerPlay size={15} className="text-success-5" /> Start
          </button>
        )}
        <button type="button" onClick={openInTab} disabled={!origin || !state?.entry || HOSTED} className={ICON_BTN} title="Open in a new tab" aria-label="Open in a new tab"><IconExternalLink size={17} /></button>
      </div>

      {note && (
        <div className="flex shrink-0 items-start gap-2 border-b border-edge bg-surface px-3 py-1.5 text-meta text-ink-muted" role="note">
          <IconInfoCircle size={15} className="mt-0.5 shrink-0" aria-hidden />
          <span>{note}</span>
        </div>
      )}

      {/* The page, or its status */}
      <div className="relative flex min-h-0 flex-1 justify-center overflow-auto bg-page">
        {showFrame && src ? (
          <iframe
            key={frameKey}
            ref={frameRef}
            src={src}
            title={`Preview of localhost:${state.targetPort}`}
            onLoad={onFrameLoad}
            // Its own origin; no navigating Codekin's tab.
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads"
            className={`h-full min-h-[320px] border-edge bg-[white] ${width ? 'border-x' : 'w-full'}`}
            style={width ? { width, flex: '0 0 auto' } : undefined}
          />
        ) : (
          <PreviewStatus
            state={state}
            target={target}
            mixed={mixed}
            logs={logs}
            onStart={config && !state?.managed ? () => { preview.launch(config) } : undefined}
            onOpenTab={origin && state?.entry ? openInTab : undefined}
          />
        )}
      </div>

      {drawer && (
        <div className="flex h-[38%] min-h-[140px] shrink-0 flex-col border-t border-edge bg-surface">
          <div className="flex shrink-0 items-center gap-1 border-b border-edge px-2 py-1">
            {(['console', 'server'] as const).map(tab => (
              <button key={tab} type="button" onClick={() => { setDrawer(tab) }} aria-pressed={drawer === tab}
                className={`rounded-control px-2 py-1 text-meta ${drawer === tab ? 'bg-surface-raised font-bold text-ink' : 'text-ink-muted hover:text-ink'}`}>
                {tab === 'console' ? `Console${consoleEntries.length ? ` (${consoleEntries.length})` : ''}` : 'Server'}
              </button>
            ))}
            <span className="flex-1" />
            {drawer === 'console' && consoleEntries.length > 0 && (
              <>
                <button type="button" onClick={() => { const c = consoleContext(consoleEntries, state?.targetPort ?? target.port); onAttach('console', c.excerpt, c.label, true) }}
                  className="flex items-center gap-1 rounded-control px-2 py-1 text-meta text-primary-5 hover:bg-surface-raised">
                  <IconSend size={14} /> Send {errors ? 'errors' : 'warnings'} to agent
                </button>
                <button type="button" onClick={() => { setConsoleEntries([]) }} className="rounded-control px-2 py-1 text-meta text-ink-muted hover:text-ink">Clear</button>
              </>
            )}
            {drawer === 'server' && logs.length > 0 && (
              <button type="button" onClick={() => { const c = serverLogContext(logs, config ?? `localhost:${target.port}`); onAttach('console', c.excerpt, c.label, true) }}
                className="flex items-center gap-1 rounded-control px-2 py-1 text-meta text-primary-5 hover:bg-surface-raised">
                <IconSend size={14} /> Send output to agent
              </button>
            )}
            <button type="button" onClick={() => { setDrawer(null) }} className={ICON_BTN} aria-label="Close panel"><IconX size={15} /></button>
          </div>
          {drawer === 'console' ? <ConsoleList entries={consoleEntries} connected={connected} /> : <ServerLog lines={logs} managed={!!state?.managed || !!config} />}
        </div>
      )}
    </div>
  )
}

function StatusPill({ state }: { state: PreviewState | undefined }) {
  const status = state?.status
  const tone = status === 'running' ? 'text-success-5' : status === 'starting' ? 'text-warning-5' : status === 'crashed' ? 'text-error-5' : 'text-ink-muted'
  const label = !state ? 'Connecting…' : status === 'running' ? 'Running' : status === 'starting' ? 'Starting' : status === 'crashed' ? 'Crashed' : 'Not running'
  return (
    <span className={`flex shrink-0 items-center gap-1.5 px-1 text-meta ${tone}`} role="status">
      {status === 'starting' || !state
        ? <IconLoader2 size={14} className="animate-spin" aria-hidden />
        : <span className={`h-2 w-2 rounded-full ${status === 'running' ? 'bg-success-5' : status === 'crashed' ? 'bg-error-5' : 'bg-ink-faint'}`} aria-hidden />}
      {label}
    </span>
  )
}

function PreviewStatus({ state, target, mixed, logs, onStart, onOpenTab }: {
  state: PreviewState | undefined
  target: PreviewTarget
  mixed: boolean
  logs: string[]
  onStart?: () => void
  onOpenTab?: () => void
}) {
  const port = state?.targetPort ?? target.port
  const tail = logs.slice(-8)
  let title: string
  let body: string
  if (HOSTED) {
    title = 'Previews open on the computer running Codekin'
    body = `The dev server (localhost:${port}) runs on that computer, and the hosted web app can't reach it. Open Codekin on that computer, or in the desktop app, to see it here.`
  } else if (!state) {
    title = 'Connecting…'
    body = ''
  } else if (state.status === 'running' && mixed) {
    title = 'Open the preview in a new tab'
    body = 'This page is served over https, and browsers don\'t show an http preview inside it.'
  } else if (state.status === 'running' && !state.proxyPort) {
    title = 'The preview can\'t be shown'
    body = state.error ?? 'Codekin has no preview port for it.'
  } else if (state.status === 'starting') {
    title = `Starting ${state.config ?? 'the server'}…`
    body = state.error ?? `Waiting for port ${port} to answer.${state.command ? ` (${state.command})` : ''}`
  } else if (state.status === 'crashed') {
    title = `${state.config ?? 'The server'} stopped unexpectedly`
    body = state.error ?? ''
  } else {
    title = `Nothing answers on port ${port}`
    body = onStart
      ? `Start "${state.config ?? target.config}" from .claude/launch.json, or start the server yourself.`
      : 'Ask the agent to start the dev server; the preview comes back on its own once the port answers.'
  }
  return (
    <div className="m-auto w-full max-w-[560px] px-8 py-10">
      <div className="flex items-center gap-2 text-title font-bold text-ink">
        {(!state || state.status === 'starting') && !HOSTED && <IconLoader2 size={20} className="animate-spin text-warning-5" aria-hidden />}
        {title}
      </div>
      {body && <p className="mt-1 text-body text-ink-muted">{body}</p>}
      {(onStart || (onOpenTab && mixed)) && !HOSTED && (
        <div className="mt-4 flex gap-2">
          {onStart && state?.status !== 'starting' && (
            <button type="button" onClick={onStart} className="flex items-center gap-1.5 rounded-control bg-primary-fill px-3 py-1.5 text-meta font-medium text-on-primary-fill hover:opacity-90">
              <IconPlayerPlay size={15} /> {state?.status === 'crashed' ? 'Start again' : 'Start'}
            </button>
          )}
          {onOpenTab && mixed && (
            <button type="button" onClick={onOpenTab} className="flex items-center gap-1.5 rounded-control border border-edge-strong px-3 py-1.5 text-meta text-ink hover:bg-surface">
              <IconExternalLink size={15} /> Open in a new tab
            </button>
          )}
        </div>
      )}
      {tail.length > 0 && (state?.status === 'crashed' || state?.status === 'starting') && (
        <pre className="mt-4 max-h-[200px] overflow-auto rounded-control border border-edge bg-surface px-3 py-2 font-mono text-micro text-ink-muted whitespace-pre-wrap break-words">{tail.join('\n')}</pre>
      )}
    </div>
  )
}

function ConsoleList({ entries, connected }: { entries: ConsoleEntry[]; connected: boolean }) {
  if (!entries.length) {
    return <p className="px-3 py-2 text-meta text-ink-faint">{connected ? 'No errors or warnings on this page.' : 'The console shows once the page connects.'}</p>
  }
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto font-mono text-micro">
      {entries.map((e, i) => (
        <li key={i} className={`flex gap-2 border-b border-edge px-3 py-1 ${e.level === 'error' ? 'text-error-5' : 'text-warning-5'}`}>
          <span className="shrink-0 uppercase">{e.level}</span>
          <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-ink">{e.message}</span>
          <span className="shrink-0 text-ink-faint">{e.path}</span>
        </li>
      ))}
    </ul>
  )
}

function ServerLog({ lines, managed }: { lines: string[]; managed: boolean }) {
  const ref = useRef<HTMLPreElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: ref.current.scrollHeight }) }, [lines])
  if (!lines.length) {
    return (
      <p className="px-3 py-2 text-meta text-ink-faint">
        {managed ? 'No output yet.' : 'Codekin didn\'t start this server, so its output is wherever it runs (the agent\'s shell, or your terminal).'}
      </p>
    )
  }
  return <pre ref={ref} className="min-h-0 flex-1 overflow-auto px-3 py-2 font-mono text-micro text-ink whitespace-pre-wrap break-words">{lines.join('\n')}</pre>
}
