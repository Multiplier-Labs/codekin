/**
 * Report uncaught errors in the hosted app to the relay
 * (`POST /api/telemetry/errors`), which scrubs them and forwards them to the
 * error tracker if one is configured (docs/RELAY-HARDENING.md §2).
 *
 * The page sees session content, so only an exception type, a short message
 * and stack frames are sent: no breadcrumbs, DOM text, console output,
 * request data or session replay. Errors that don't come from the app's own
 * bundle (extensions, injected scripts) are ignored.
 */

const ENDPOINT = '/api/telemetry/errors'
const MAX_PER_PAGE = 5
const MAX_MESSAGE = 200
const MAX_FRAMES = 30

interface Frame {
  filename: string
  function?: string
  lineno?: number
  colno?: number
}

export interface BrowserErrorReport {
  type: string
  message: string
  frames: Frame[]
}

/** Parse Chrome (`at fn (url:1:2)`) and Safari/Firefox (`fn@url:1:2`) stacks; paths only. */
export function stackFrames(stack: string | undefined, origin = window.location.origin): Frame[] {
  if (!stack) return []
  const frames: Frame[] = []
  for (const line of stack.split('\n')) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line) ?? /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line)
    if (!m) continue
    let filename = m[2]
    if (filename.startsWith(`${origin}/`)) filename = filename.slice(origin.length)
    frames.push({
      filename: filename.replace(/[?#].*$/, ''),
      ...(m[1] ? { function: m[1] } : {}),
      lineno: Number(m[3]),
      colno: Number(m[4]),
    })
    if (frames.length >= MAX_FRAMES) break
  }
  return frames
}

/** The report for an error, or null when it doesn't come from the app's bundle. */
export function toReport(error: unknown, origin = window.location.origin): BrowserErrorReport | null {
  if (!(error instanceof Error)) return null
  const frames = stackFrames(error.stack, origin)
  // Our code is served from /assets/ on this origin; anything else is an
  // extension or injected script, and not ours to report.
  if (!frames.some(f => f.filename.startsWith('/assets/'))) return null
  return {
    type: (error.name || 'Error').slice(0, 100),
    message: error.message.slice(0, MAX_MESSAGE),
    frames,
  }
}

let installed = false

export function installErrorReporting(post: (report: BrowserErrorReport) => void = postReport): () => void {
  if (installed) return () => {}
  installed = true
  const seen = new Set<string>()
  let sent = 0

  const report = (error: unknown) => {
    if (sent >= MAX_PER_PAGE) return
    const r = toReport(error)
    if (!r) return
    const key = `${r.type}:${r.message}`
    if (seen.has(key)) return
    seen.add(key)
    sent += 1
    post(r)
  }
  const onError = (event: ErrorEvent) => { report(event.error) }
  const onRejection = (event: PromiseRejectionEvent) => { report(event.reason) }
  window.addEventListener('error', onError)
  window.addEventListener('unhandledrejection', onRejection)
  return () => {
    window.removeEventListener('error', onError)
    window.removeEventListener('unhandledrejection', onRejection)
    installed = false
  }
}

function postReport(report: BrowserErrorReport): void {
  void fetch(ENDPOINT, {
    method: 'POST',
    credentials: 'same-origin',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(report),
  }).catch(() => {
    // Reporting must never cause its own error loop.
  })
}
