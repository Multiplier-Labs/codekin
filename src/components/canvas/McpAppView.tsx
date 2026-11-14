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
 * - call a tool on its own server: run by the session's agent CLI without a
 *   model turn. Claude Code applies the session's permission rules (an
 *   approval, when needed, appears in the chat); elsewhere Codekin asks
 *   here first. The result goes to the app, not the agent;
 * - update the model's context, change display mode: accepted, inline only.
 *
 * Loaded lazily: ext-apps and the MCP protocol code stay out of the main bundle.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { AppBridge, PostMessageTransport } from '@modelcontextprotocol/ext-apps/app-bridge'
import { IconAlertTriangle, IconLoader2, IconShieldLock } from '@tabler/icons-react'
import { relativeTime } from '../../lib/canvas'
import type { AppToolOutcome } from '../../hooks/useCanvas'
import { AppConfirmDialog, type AppConfirmRequest } from './AppConfirmDialog'

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
  /** Run a tool on the app's server; `confirmed` once the user approved it here. Absent: apps can't call tools. */
  onCallTool?: (tool: string, args: Record<string, unknown>, confirmed: boolean) => Promise<AppToolOutcome>
}

const INIT_TIMEOUT_MS = 10_000

function scheme(): 'light' | 'dark' {
  return document.documentElement.dataset.scheme === 'dark' ? 'dark' : 'light'
}

/** MCP tool names: what an app may ask to run, and what Codekin shows. */
const TOOL_NAME = /^[A-Za-z0-9_.-]{1,64}$/
let confirmSeq = 0

const toolError = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

export default function McpAppView({ origin, content, onSendMessage, onCallTool }: Props) {
  const record = useMemo(() => {
    try { return JSON.parse(content) as AppRecord } catch { return null }
  }, [content])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }>({ status: 'loading' })
  const [height, setHeight] = useState<number | null>(null)
  /** Requests waiting for the user, oldest first; the first is shown. */
  const [confirms, setConfirms] = useState<AppConfirmRequest[]>([])
  const sendRef = useRef(onSendMessage)
  const callRef = useRef(onCallTool)
  useEffect(() => { sendRef.current = onSendMessage; callRef.current = onCallTool })
  /** Tool calls running now (names), shown under the header. */
  const [running, setRunning] = useState<string[]>([])
  /** The last call the session's permission rules refused, explained under the header. */
  const [refused, setRefused] = useState<string | null>(null)

  useEffect(() => {
    const win = frameRef.current?.contentWindow
    if (!record || !win) return
    let initialized = false
    const bridge = new AppBridge(
      null,
      { name: 'Codekin', version: '1.0.0' },
      { openLinks: {}, message: { text: {} }, updateModelContext: { text: {} }, logging: {}, ...(onCallTool ? { serverTools: {} } : {}) },
      { hostContext: { theme: scheme(), displayMode: 'inline', availableDisplayModes: ['inline'], platform: 'web', locale: navigator.language } },
    )
    // Each request waits its turn: a new one never replaces the one on screen.
    const pending = new Set<AppConfirmRequest>()
    const ask = (kind: AppConfirmRequest['kind'], text: string, tool?: string) => new Promise<boolean>(resolve => {
      const request: AppConfirmRequest = {
        id: ++confirmSeq, kind, text, tool,
        resolve: (ok) => {
          if (!pending.delete(request)) return
          setConfirms(q => q.filter(r => r !== request))
          resolve(ok)
        },
      }
      pending.add(request)
      setConfirms(q => [...q, request])
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
    bridge.oncalltool = async (params) => {
      const call = callRef.current
      // Tool names are checked before they are shown or sent anywhere.
      if (!TOOL_NAME.test(params.name)) return toolError('That is not a tool name.')
      if (!call) return toolError(`Codekin can't run ${params.name} for this app here. Ask the agent instead.`)
      const args = params.arguments ?? {}
      setRunning(r => [...r, params.name])
      try {
        let outcome = await call(params.name, args, false)
        if (!outcome.ok && outcome.needsConfirmation) {
          if (!await ask('tool', JSON.stringify(args, null, 2), params.name)) return toolError('The user declined this tool call.')
          outcome = await call(params.name, args, true)
        }
        if (!outcome.ok && outcome.refused) setRefused(params.name)
        return outcome.ok ? outcome.result as never : toolError(outcome.error)
      } finally {
        setRunning(r => { const i = r.indexOf(params.name); return i < 0 ? r : [...r.slice(0, i), ...r.slice(i + 1)] })
      }
    }
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
      // Requests still on screen are declined, so the app isn't left waiting.
      for (const request of [...pending]) request.resolve(false)
      clearTimeout(timer)
      observer.disconnect()
      void bridge.close()
    }
  }, [record, origin, !!onCallTool]) // eslint-disable-line react-hooks/exhaustive-deps -- the bridge reads the latest callbacks through refs

  if (!record) return <p className="m-8 text-body text-error-5" role="alert">This MCP App record can't be read.</p>

  return (
    <div className="relative flex min-h-0 flex-1 flex-col gap-2 px-6 py-4">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-meta text-ink-muted">
        <IconShieldLock size={15} aria-hidden />
        <span>Interactive content from <span className="font-bold text-ink">{record.server}</span> · runs in a sandbox with no network</span>
        <span className="text-ink-faint">· {record.tool}{record.at ? `, ${relativeTime(record.at)}` : ''} · view restored, not re-run</span>
      </div>
      {refused && (
        <div className="flex items-start gap-1.5 rounded-control border border-edge bg-surface px-2.5 py-1.5 text-meta text-ink-muted" role="note">
          <IconShieldLock size={15} className="mt-0.5 shrink-0 text-warning-5" aria-hidden />
          <span className="min-w-0 flex-1">
            The session's permission rules didn't let the app run <span className="font-mono text-ink">{refused}</span>, the same answer the agent would get.
            To let it, allow <span className="font-mono text-ink">mcp__{record.server}__{refused}</span> in Claude Code's permissions, or change the session's permission mode.
          </span>
          <button type="button" onClick={() => { setRefused(null) }} className="shrink-0 text-ink-muted hover:text-ink" aria-label="Dismiss">×</button>
        </div>
      )}
      {running.length > 0 && (
        <div className="flex items-center gap-1.5 text-meta text-ink-muted" role="status">
          <IconLoader2 size={14} className="animate-spin" aria-hidden />
          The app is running {[...new Set(running)].join(', ')}. If the agent asks for approval, answer it in the chat.
        </div>
      )}
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

      {confirms[0] && <AppConfirmDialog request={confirms[0]} server={record.server} waiting={confirms.length - 1} />}
    </div>
  )
}
