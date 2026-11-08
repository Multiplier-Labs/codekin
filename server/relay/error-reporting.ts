/**
 * Optional error reporting for the relay (docs/RELAY-HARDENING.md §2).
 *
 * Off unless RELAY_ERROR_DSN is set. Events go to any service that speaks the
 * Sentry ingest API (GlitchTip, Sentry), in the envelope format, with no SDK:
 * every field sent is built here, from an error's type, message and stack
 * frames, so nothing else (request bodies, headers, cookies, query strings,
 * relay frame payloads) can ride along. Messages are scrubbed of anything
 * that looks like a credential before they leave.
 */

import { randomUUID } from 'crypto'
import { homedir } from 'os'

export interface ErrorDsn {
  envelopeUrl: string
  publicKey: string
}

export interface ReportFrame {
  filename: string
  function?: string
  lineno?: number
  colno?: number
}

export interface ErrorReport {
  type: string
  message: string
  /** Most recent call first, as V8 prints them. */
  frames: ReportFrame[]
  /** Low-cardinality labels only (route pattern, method): never ids or paths. */
  tags?: Record<string, string>
}

import { scrubText, scrubErrorMessage } from './error-scrub.js'
export { scrubText, scrubValue } from './error-scrub.js'

export const MAX_SERVER_MESSAGE = 500
export const MAX_BROWSER_MESSAGE = 200
const MAX_FRAMES = 50

/** Parse `https://<key>@host[:port][/path]/<project>` into the envelope endpoint. */
export function parseDsn(dsn: string): ErrorDsn | null {
  let url: URL
  try {
    url = new URL(dsn.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  let publicKey: string
  try { publicKey = decodeURIComponent(url.username) } catch { return null }
  const parts = url.pathname.split('/').filter(Boolean)
  const project = parts.pop()
  if (!publicKey || !project || !/^\d+$/.test(project)) return null
  const prefix = parts.length > 0 ? `/${parts.join('/')}` : ''
  return { envelopeUrl: `${url.protocol}//${url.host}${prefix}/api/${project}/envelope/`, publicKey }
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** Parse V8 (`at fn (file:1:2)`) and Safari/Firefox (`fn@file:1:2`) stack lines. */
export function parseStack(stack: string | undefined): ReportFrame[] {
  if (!stack) return []
  const frames: ReportFrame[] = []
  for (const line of stack.split('\n')) {
    const v8 = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?\s*$/.exec(line)
    const gecko = v8 ? null : /^\s*(.*?)@(.+?):(\d+):(\d+)\s*$/.exec(line)
    const m = v8 ?? gecko
    if (!m) continue
    frames.push({
      filename: m[2],
      ...(m[1] ? { function: m[1] } : {}),
      lineno: Number(m[3]),
      colno: Number(m[4]),
    })
    if (frames.length >= MAX_FRAMES) break
  }
  return frames
}

/**
 * Keep a frame's file as a path with no origin, query or hash, and with the
 * home directory and working directory taken out.
 */
export function cleanFilename(filename: string, cwd = process.cwd(), home = homedir()): string {
  let name = filename.replace(/^file:\/\//, '')
  try {
    if (/^https?:\/\//.test(name)) name = new URL(name).pathname
  } catch {
    return '[unknown]'
  }
  name = name.replace(/[?#].*$/, '')
  if (cwd && name.startsWith(`${cwd}/`)) name = name.slice(cwd.length + 1)
  else if (home && name.startsWith(`${home}/`)) name = `~/${name.slice(home.length + 1)}`
  return truncate(scrubText(name), 300)
}

export function reportFromError(err: unknown, tags?: Record<string, string>): ErrorReport {
  const error = err instanceof Error ? err : new Error(typeof err === 'string' ? err : 'Non-error thrown')
  return {
    type: error.name || 'Error',
    message: error.message,
    frames: parseStack(error.stack),
    ...(tags ? { tags } : {}),
  }
}

export interface ErrorReporterOptions {
  release: string
  environment: string
  /** `node` for the relay itself, `javascript` for tunnelled browser errors. */
  platform: 'node' | 'javascript'
  maxMessage?: number
  /** Events sent per minute at most; the rest are dropped. */
  maxPerMinute?: number
  send?: (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<unknown>
  log?: (line: string) => void
}

export class ErrorReporter {
  private windowStart = 0
  private sentInWindow = 0
  private readonly send: NonNullable<ErrorReporterOptions['send']>
  private readonly log: (line: string) => void

  constructor(private dsn: ErrorDsn, private opts: ErrorReporterOptions) {
    this.send = opts.send ?? ((url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(5000) }))
    this.log = opts.log ?? (line => { console.warn(line) })
  }

  /** The event exactly as it would be sent. Exposed for tests. */
  buildEvent(report: ErrorReport): Record<string, unknown> {
    const maxMessage = this.opts.maxMessage ?? MAX_SERVER_MESSAGE
    const frames = report.frames
      .slice(0, MAX_FRAMES)
      .map(f => ({
        filename: cleanFilename(f.filename),
        ...(f.function ? { function: truncate(scrubText(f.function), 200) } : {}),
        ...(Number.isInteger(f.lineno) ? { lineno: f.lineno } : {}),
        ...(Number.isInteger(f.colno) ? { colno: f.colno } : {}),
        in_app: !f.filename.includes('node_modules'),
      }))
      .reverse() // Sentry wants the crashing frame last.
    const tags: Record<string, string> = {}
    for (const [k, v] of Object.entries(report.tags ?? {})) {
      tags[truncate(scrubText(k), 32)] = truncate(scrubText(v), 64)
    }
    return {
      event_id: randomUUID().replace(/-/g, ''),
      timestamp: Date.now() / 1000,
      platform: this.opts.platform,
      level: 'error',
      release: this.opts.release,
      environment: this.opts.environment,
      tags,
      exception: {
        values: [{
          type: truncate(scrubText(report.type), 100),
          value: truncate(scrubErrorMessage(report.type, report.message), maxMessage),
          ...(frames.length > 0 ? { stacktrace: { frames } } : {}),
        }],
      },
    }
  }

  /** Queue a report. Never throws; returns false when rate-limited. */
  capture(report: ErrorReport): boolean {
    const now = Date.now()
    if (now - this.windowStart >= 60_000) {
      this.windowStart = now
      this.sentInWindow = 0
    }
    if (this.sentInWindow >= (this.opts.maxPerMinute ?? 30)) return false
    this.sentInWindow += 1

    let event: Record<string, unknown>
    try {
      event = this.buildEvent(report)
    } catch {
      return false
    }
    const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date(now).toISOString() })
    const body = `${header}\n${JSON.stringify({ type: 'event' })}\n${JSON.stringify(event)}\n`
    try {
      this.send(this.dsn.envelopeUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': `Sentry sentry_version=7, sentry_key=${this.dsn.publicKey}, sentry_client=codekin-relay/${this.opts.release}`,
        },
        body,
      }).then(response => {
        if (response && typeof response === 'object' && 'ok' in response && response.ok === false) {
          // Never read or log the response body or the configured endpoint.
          this.log('[relay] error report not delivered: HTTP refusal')
        }
      }).catch(() => {
        this.log('[relay] error report not delivered: transport failure')
      })
      return true
    } catch {
      this.log('[relay] error report not delivered: sender failure')
      return false
    }
  }
}

/** Build a reporter from a DSN string, or null when unset or invalid. */
export function createErrorReporter(
  dsn: string | undefined,
  opts: ErrorReporterOptions,
): ErrorReporter | null {
  if (!dsn?.trim()) return null
  const parsed = parseDsn(dsn)
  if (!parsed) {
    console.warn('[relay] Ignoring error-reporting DSN: expected https://<key>@<host>/<project-id>')
    return null
  }
  return new ErrorReporter(parsed, opts)
}
