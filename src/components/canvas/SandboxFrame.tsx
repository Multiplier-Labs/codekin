/**
 * Content that runs code, framed from the sandbox origin (design handoff
 * C11, docs/CANVAS-SPEC.md §8). An inset well marks the boundary, a quiet
 * label above it says who wrote what runs inside, and Codekin's own actions
 * (Ask about a chart selection) stay outside it.
 *
 * Messages are accepted only from the framed window and the sandbox origin,
 * and are parsed as untrusted data.
 */

import { useEffect, useRef, useState } from 'react'
import { IconAlertTriangle, IconLoader2, IconMessageQuestion, IconShieldLock } from '@tabler/icons-react'
import { parseFromSandbox, type SandboxKind, type ToSandbox } from '../../lib/sandboxProtocol'

const READY_TIMEOUT_MS = 8000

interface Props {
  origin: string
  kind: SandboxKind
  content: string
  /** "the agent", "you", or an MCP server name: who wrote what runs here. */
  author: string
  /** A chart selection: attach it to the next message (ask: bring the composer up). */
  onSelection?: (label: string, excerpt: string, ask: boolean) => void
}

function scheme(): 'light' | 'dark' {
  return document.documentElement.dataset.scheme === 'dark' ? 'dark' : 'light'
}

export function SandboxFrame({ origin, kind, content, author, onSelection }: Props) {
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }>({ status: 'loading' })
  const [selection, setSelection] = useState<{ label: string; excerpt: string } | null>(null)
  const [frameReady, setFrameReady] = useState(false)
  const renderId = useRef(0)

  // Messages from the sandbox: only its window, only its origin.
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== frameRef.current?.contentWindow) return
      const msg = parseFromSandbox(event.data)
      if (!msg) return
      if (msg.type === 'codekin-sandbox:ready') { setFrameReady(true); return }
      if (msg.id !== String(renderId.current)) return
      if (msg.type === 'codekin-sandbox:rendered') setState({ status: 'ready' })
      else if (msg.type === 'codekin-sandbox:error') setState({ status: 'error', message: msg.message })
      else if (msg.type === 'codekin-sandbox:selection') setSelection({ label: msg.label, excerpt: msg.excerpt })
      else setSelection(null)
    }
    window.addEventListener('message', onMessage)
    return () => { window.removeEventListener('message', onMessage) }
  }, [origin])

  // Not ready in time: the sandbox address isn't reachable from this browser.
  useEffect(() => {
    if (frameReady) return
    const timer = setTimeout(() => {
      setState(s => (s.status === 'loading' ? { status: 'error', message: `The sandbox at ${origin} did not answer. Check that it is reachable from this browser.` } : s))
    }, READY_TIMEOUT_MS)
    return () => { clearTimeout(timer) }
  }, [frameReady, origin])

  // Post the content once the frame is ready, and again when it or the theme changes.
  useEffect(() => {
    if (!frameReady) return
    const send = () => {
      renderId.current += 1
      setSelection(null)
      const msg: ToSandbox = { type: 'codekin-sandbox:render', id: String(renderId.current), kind, content, scheme: scheme() }
      frameRef.current?.contentWindow?.postMessage(msg, origin)
    }
    send()
    const observer = new MutationObserver(send)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-scheme'] })
    return () => { observer.disconnect() }
  }, [frameReady, kind, content, origin])

  const what = kind === 'chart' ? 'Interactive chart' : 'Interactive page'
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 px-6 py-4">
      <div className="flex items-center gap-1.5 text-meta text-ink-muted">
        <IconShieldLock size={15} aria-hidden />
        <span>{what} written by {author} · runs in a sandbox{kind === 'html' ? ' with no network' : ''}</span>
      </div>
      <div className="relative flex min-h-[320px] flex-1 rounded-floating border border-edge-strong bg-surface-raised p-[5px]">
        <iframe
          ref={frameRef}
          src={`${origin}/index.html`}
          title={`${what} (sandboxed)`}
          // The sandbox origin is not Codekin's, so allowing its own origin
          // keeps it isolated while letting its module scripts load.
          sandbox="allow-scripts allow-same-origin"
          referrerPolicy="no-referrer"
          className="min-h-0 w-full flex-1 rounded-control border border-edge bg-page"
        />
        {state.status !== 'ready' && (
          <div className="absolute inset-[5px] flex items-center justify-center rounded-control bg-page p-6 text-meta">
            {state.status === 'loading'
              ? <span className="flex items-center gap-2 text-ink-muted" role="status"><IconLoader2 size={18} className="animate-spin" /> Rendering…</span>
              : (
                <span className="flex max-w-[520px] items-start gap-2 text-error-5" role="alert">
                  <IconAlertTriangle size={18} className="mt-0.5 shrink-0" />
                  <span>{state.message}</span>
                </span>
              )}
          </div>
        )}
      </div>
      {selection && onSelection && (
        <div className="flex items-center gap-2 text-meta" role="toolbar" aria-label="Chart selection">
          <span className="min-w-0 flex-1 truncate font-bold text-ink">{selection.label}</span>
          <button type="button" onClick={() => { onSelection(selection.label, selection.excerpt, true) }}
            className="flex items-center gap-1.5 rounded-control bg-primary-fill px-3 py-1 font-medium text-on-primary-fill hover:opacity-90">
            <IconMessageQuestion size={15} aria-hidden /> Ask about this
          </button>
          <button type="button" onClick={() => { onSelection(selection.label, selection.excerpt, false) }}
            className="rounded-control border border-edge-strong bg-page px-3 py-1 text-ink hover:border-focus">Add to prompt</button>
        </div>
      )}
    </div>
  )
}
