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
import { IconAlertTriangle, IconExternalLink, IconLoader2, IconMessage, IconShieldLock, IconTool } from '@tabler/icons-react'
import { relativeTime } from '../../lib/canvas'
import type { AppToolOutcome } from '../../hooks/useCanvas'

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

type Confirm = { kind: 'link' | 'message' | 'tool'; text: string; tool?: string; resolve: (ok: boolean) => void }

const toolError = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] })

export default function McpAppView({ origin, content, onSendMessage, onCallTool }: Props) {
  const record = useMemo(() => {
    try { return JSON.parse(content) as AppRecord } catch { return null }
  }, [content])
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }>({ status: 'loading' })
  const [height, setHeight] = useState<number | null>(null)
  const [confirm, setConfirm] = useState<Confirm | null>(null)
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
    const ask = (kind: Confirm['kind'], text: string, tool?: string) => new Promise<boolean>(resolve => {
      setConfirm({ kind, text, tool, resolve: (ok) => { setConfirm(null); resolve(ok) } })
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
      if (!call) return toolError(`Codekin can't run ${params.name} for this app here. Ask the agent instead.`)
      const args = params.arguments ?? {}
      setRunning(r => [...r, params.name])
      try {
        let outcome = await call(params.name, args, false)
        if (!outcome.ok && outcome.needsConfirmation) {
          if (!await ask('tool', JSON.stringify(args, null, 2), params.name)) return toolError('The user declined this tool call.')
          outcome = await call(params.name, args, true)
        }
        if (!outcome.ok && outcome.error.startsWith('The tool did not run')) setRefused(params.name)
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

      {confirm && (
        <div className="absolute inset-0 z-30 flex items-center justify-center bg-page/60 p-6" role="dialog" aria-modal="true" aria-label={confirm.kind === 'link' ? 'Open a link' : confirm.kind === 'tool' ? 'Run a tool' : 'Send a message as you'}>
          <div className="w-full max-w-[460px] rounded-floating border border-edge-strong bg-surface-raised p-4 shadow-floating">
            <div className="flex items-center gap-2 text-body font-bold text-ink">
              {confirm.kind === 'link' ? <IconExternalLink size={18} className="text-warning-5" /> : confirm.kind === 'tool' ? <IconTool size={18} className="text-warning-5" /> : <IconMessage size={18} className="text-warning-5" />}
              {confirm.kind === 'link' ? `${record.server} wants to open a link` : confirm.kind === 'tool' ? `${record.server} wants to run ${confirm.tool}` : `${record.server} wants to send a message as you`}
            </div>
            <div className={`mt-3 max-h-[240px] overflow-y-auto rounded-control border border-edge bg-page px-3 py-2 text-meta text-ink ${confirm.kind === 'link' ? 'break-all font-mono' : confirm.kind === 'tool' ? 'whitespace-pre-wrap font-mono' : 'whitespace-pre-wrap'}`}>{confirm.text}</div>
            <p className="mt-2 text-meta text-ink-muted">
              {confirm.kind === 'link' ? 'It opens in a new tab.'
                : confirm.kind === 'tool' ? `It runs on this computer with these arguments, through the session's connection to ${record.server}. The result goes to the app, not the agent.`
                : 'It goes to the agent as your message and shows in the chat.'}
            </p>
            <div className="mt-3 flex justify-end gap-2">
              <button type="button" onClick={() => { confirm.resolve(false) }} className="rounded-control px-3 py-1.5 text-meta text-ink-muted hover:text-ink">Cancel</button>
              <button type="button" autoFocus onClick={() => { confirm.resolve(true) }} className="rounded-control bg-primary-fill px-3 py-1.5 text-meta font-medium text-on-primary-fill hover:opacity-90">
                {confirm.kind === 'link' ? 'Open link' : confirm.kind === 'tool' ? 'Run tool' : 'Send message'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
