/**
 * An MCP App in Canvas (design handoff C12, docs/CANVAS-SPEC.md §8).
 *
 * The app document runs in the sandbox page's proxy mode (a separate origin,
 * then an inner frame with an opaque origin and no network). Codekin hosts it
 * with ext-apps' AppBridge: it hands the app the stored tool input and
 * result, so reopening restores the view without running the tool again.
 * What the app asks of the host goes through Codekin's own chrome:
 *
 * - open a link, or send a message as you: shown and confirmed first;
 * - call a tool: refused for now (app-initiated calls are a later slice);
 * - update the model's context, change display mode: accepted, inline only.
 *
 * Loaded lazily: ext-apps and the MCP protocol code stay out of the main bundle.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import { IconAlertTriangle, IconExternalLink, IconLoader2, IconMessage, IconShieldLock } from '@tabler/icons-react'
import { relativeTime } from '../../lib/canvas'

interface AppRecord {
  server: string
  tool: string
  toolInput: Record<string, unknown>
  result: { content: unknown[]; structuredContent?: unknown; _meta?: unknown; isError?: boolean }
  html: string
  csp?: unknown
  permissions?: unknown
  at?: string
}

interface Props {
  origin: string
  /** The stored record (JSON). */
  content: string
  /** Send a message to the agent as the user (after the user confirmed it). */
  onSendMessage: (text: string) => void
}

const INIT_TIMEOUT_MS = 10_000

function scheme(): 'light' | 'dark' {
  return document.documentElement.dataset.scheme === 'dark' ? 'dark' : 'light'
}

type Confirm = { kind: 'link' | 'message'; text: string; resolve: (ok: boolean) => void }

export default function McpAppView({ origin, content, onSendMessage }: Props) {
  const record = useMemo(() => {
    try { return JSON.parse(content) as AppRecord } catch { return null }
  }, [content])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }>({ status: 'loading' })
  const [height, setHeight] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
  const sendRef = useRef(onSendMessage)
  useEffect(() => { sendRef.current = onSendMessage })

  useEffect(() => {
    const win = frameRef.current?.contentWindow
    if (!record || !win) return
    let initialized = false
    const bridge = new AppBridge(
      null,
      { name: 'Codekin', version: '1.0.0' },
      { openLinks: {}, message: { text: {} }, updateModelContext: { text: {} }, logging: {} },
      { hostContext: { theme: scheme(), displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'web', locale: navigator.language } },
    )
    const ask = (kind: Confirm['kind'], text: string) => new Promise<boolean>(resolve => {
      setConfirm({ kind, text, resolve: (ok) => { setConfirm(null); resolve(ok) } })
    })

    bridge.addEventListener('sandboxready', () => {
      void bridge.sendSandboxResourceReady({ html: record.html, ...(record.csp ? { csp: record.csp as never } : {}), ...(record.permissions ? { permissions: record.permissions as never } : {}) })
    })
    bridge.addEventListener('initialized', () => {
      initialized = true
      setState({ status: 'ready' })
      void bridge.sendToolInput({ arguments: record.toolInput })
      void bridge.sendToolResult(record.result as never)
    })
    bridge.addEventListener('sizechange', ({ height: h }) => { if (typeof h === 'number' && h > 0) setHeight(Math.min(Math.ceil(h), 4000)) })
    bridge.onopenlink = async ({ url }) => {
      if (!/^https?:\/\//i.test(url)) return { isError: true }
      const ok = await ask('link', url)
      if (ok) window.open(url, '_blank', 'noopener,noreferrer')
      return ok ? {} : { isError: true }
    }
    bridge.onmessage = async (params) => {
      const text = (params.content as Array<{ type?: string; text?: string }>).filter(c => c.type === 'text' && c.text).map(c => c.text).join('\n')
      if (!text) return { isError: true }
      const ok = await ask('message', text)
      if (ok) sendRef.current(text)
      return ok ? {} : { isError: true }
    }
    bridge.oncalltool = async (params) => ({
      isError: true,
      content: [{ type: 'text', text: `Codekin doesn't let apps call tools yet (${params.name}). Ask the agent instead.` }],
    })
    bridge.onupdatemodelcontext = async () => ({})
    bridge.onrequestdisplaymode = async () => ({ mode: 'inline' })

    void bridge.connect(new PostMessageTransport(win, win)).catch((err: unknown) => {
      setState({ status: 'error', message: err instanceof Error ? err.message : String(err) })
    })
    const timer = setTimeout(() => {
      if (!initialized) setState({ status: 'error', message: `The app didn't start. The sandbox at ${origin} may be unreachable, or the app may need network access, which Codekin doesn't grant.` })
    }, INIT_TIMEOUT_MS)

    // Theme follows Codekin's light/dark scheme.
    const observer = new MutationObserver(() => { void bridge.sendHostContextChange({ theme: scheme() }) })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] })

    return () => {
      clearTimeout(timer)
      observer.disconnect()
      void bridge.close()
    }
  }, [record, origin])

  if (!record) return <p className="m-8 text-body text-error-5" role="alert">This MCP App record can't be read.</p>

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-2 px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-ink-muted">
        <IconShieldLock size={15} aria-hidden />
        <span>Interactive content from <span className="font-bold text-ink">{record.server}</span> · runs in a sandbox with no network</span>
        <span className="text-ink-faint">· {record.tool}{record.at ? `, ${relativeTime(record.at)}` : ''} · view restored, not re-run</span>
      </div>
      <div className="relative flex rounded-floating border border-edge-strong bg-surface-raised p-[5px]" style={{ minHeight: 240, height: height ? height + 10 : undefined, flex: height ? undefined : '1 1 0%' }}>
        <iframe
          ref={frameRef}
          src={`${origin}/index.html?mcp-app`}
          title={`${record.tool} from ${record.server} (sandboxed)`}
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 rounded-control border border-edge bg-page"
        />
        {state.status !== 'ready' && (
          <div className="absolute inset-[5px] flex items-center justify-center rounded-control bg-page p-6 text-meta">
            {state.status === 'loading'
              ? <span className="flex items-center gap-2 text-ink-muted" role="status"><IconLoader2 size={18} className="animate-spin" /> Starting the app…</span>
              : <span className="flex max-w-[520px] items-start gap-2 text-error-5" role="alert"><IconAlertTriangle size={18} className="mt-0.5 shrink-0" /><span>{state.message}</span></span>}
          </div>
        )}
      </div>

      {confirm && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-page/60 p-6" role="dialog" aria-modal="true" aria-label={confirm.kind === 'link' ? 'Open a link' : 'Send a message as you'}>
          <div className="w-full max-w-[460px] rounded-floating border border-edge-strong bg-surface-raised p-4 shadow-floating">
            <div className="flex items-center gap-2 text-body font-bold text-ink">
              {confirm.kind === 'link' ? <IconExternalLink size={18} className="text-warning-5" /> : <IconMessage size={18} className="text-warning-5" />}
              {confirm.kind === 'link' ? `${record.server} wants to open a link` : `${record.server} wants to send a message as you`}
            </div>
            <div className={`mt-3 max-h-[240px] overflow-y-auto rounded-control border border-edge bg-page px-3 py-2 text-meta text-ink ${confirm.kind === 'link' ? 'break-all font-mono' : 'whitespace-pre-wrap'}`}>{confirm.text}</div>
            <p className="mt-2 text-meta text-ink-muted">
              {confirm.kind === 'link' ? 'It opens in a new tab.' : 'It goes to the agent as your message and shows in the chat.'}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => { confirm.resolve(false) }} className="rounded-control px-3 py-1.5 text-meta text-ink-muted hover:text-ink">Cancel</button>
              <button type="button" autoFocus onClick={() => { confirm.resolve(true) }} className="rounded-control bg-primary-fill px-3 py-1.5 text-meta font-medium text-on-primary-fill hover:opacity-90">
                {confirm.kind === 'link' ? 'Open link' : 'Send message'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
