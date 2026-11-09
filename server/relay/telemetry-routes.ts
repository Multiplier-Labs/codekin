/**
 * `POST /api/telemetry/errors`: browser errors from the hosted app, forwarded
 * to the error-reporting service by the relay (docs/RELAY-HARDENING.md §2).
 *
 * Going through the relay keeps the page's CSP at `connect-src 'self'`, keeps
 * the visitor's IP away from the reporting service, and puts the relay's
 * scrubbing between the browser and the outside. Only an exception type, a
 * short message and stack frames are accepted; anything else in the body is
 * ignored. Without a reporter the body is read and dropped.
 */

import { scrubText, scrubErrorMessage } from './error-scrub.js'
import express, { Router } from 'express'
import type { ErrorReporter, ReportFrame } from './error-reporting.js'
import { MAX_BROWSER_MESSAGE, cleanFilename } from './error-reporting.js'

export const TELEMETRY_ERRORS_PATH = '/api/telemetry/errors'
export const MAX_TELEMETRY_BYTES = 16 * 1024

export function createTelemetryRouter(publicUrl: string, reporter: ErrorReporter | null): Router {
  const expectedOrigin = new URL(publicUrl).origin
  const router = Router()

  router.post(TELEMETRY_ERRORS_PATH, express.json({ limit: MAX_TELEMETRY_BYTES }), (req, res) => {
    // Only the app itself reports: a page elsewhere, or a script outside a
    // browser, can't fill the error tracker in our name. Browsers send
    // Origin on every POST, same-origin ones included.
    const origin = req.get('origin')
    const fetchSite = req.get('sec-fetch-site')
    if (origin !== expectedOrigin || (fetchSite !== undefined && fetchSite !== 'same-origin')) {
      res.status(403).end()
      return
    }
    const report = parseBrowserReport(req.body)
    if (!report) {
      res.status(400).end()
      return
    }
    reporter?.capture({ ...report, tags: { source: 'browser' } })
    res.status(204).end()
  })

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error handlers by arity
  router.use(TELEMETRY_ERRORS_PATH, (err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 400).end()
  })

  return router
}

/** Accept `{ type, message, frames }` with bounded, well-typed fields; anything else is dropped. */
export function parseBrowserReport(body: unknown): { type: string; message: string; frames: ReportFrame[] } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const b = body as Record<string, unknown>
  if (typeof b.type !== 'string' || typeof b.message !== 'string') return null
  const frames: ReportFrame[] = []
  if (Array.isArray(b.frames)) {
    for (const f of b.frames.slice(0, 50)) {
      if (!f || typeof f !== 'object') continue
      const frame = f as Record<string, unknown>
      if (typeof frame.filename !== 'string') continue
      frames.push({
        filename: cleanFilename(frame.filename),
        ...(typeof frame.function === 'string' ? { function: scrubText(frame.function).slice(0, 200) } : {}),
        ...(Number.isInteger(frame.lineno) ? { lineno: frame.lineno as number } : {}),
        ...(Number.isInteger(frame.colno) ? { colno: frame.colno as number } : {}),
      })
    }
  }
  return {
    type: scrubText(b.type).slice(0, 100),
    message: scrubErrorMessage(b.type, b.message).slice(0, MAX_BROWSER_MESSAGE),
    frames,
  }
}
