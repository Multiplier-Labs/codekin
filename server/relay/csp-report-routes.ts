/**
 * `POST /api/csp-report`: where browsers send Content-Security-Policy
 * violation reports (`report-uri` and the Reporting API's `report-to`).
 *
 * Unauthenticated, since browsers send reports without credentials. The caller
 * rate-limits it per IP. Only the directive and the blocked host are logged:
 * a report's document URL, referrer and script sample can carry session ids,
 * tokens or transcript text.
 */

import express, { Router } from 'express'

export const CSP_REPORT_PATH = '/api/csp-report'
export const MAX_CSP_REPORT_BYTES = 8 * 1024

/** At most this many violations are logged from one request (a Reporting API batch). */
const MAX_LOGGED_PER_REQUEST = 10

export interface CspViolation {
  directive: string
  blocked: string
}

export function createCspReportRouter(log: (line: string) => void = line => { console.warn(line) }): Router {
  const router = Router()
  router.post(
    CSP_REPORT_PATH,
    express.json({
      type: ['application/csp-report', 'application/reports+json', 'application/json'],
      limit: MAX_CSP_REPORT_BYTES,
    }),
    (req, res) => {
      for (const violation of parseCspReports(req.body).slice(0, MAX_LOGGED_PER_REQUEST)) {
        log(`[relay] CSP violation: ${violation.directive} blocked ${violation.blocked}`)
      }
      res.status(204).end()
    },
  )
  // Oversized or malformed bodies end here, quietly: they are browser noise
  // (or probing), not relay errors worth a stack trace.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error handlers by arity
  router.use(CSP_REPORT_PATH, (err: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(typeof err.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 400).end()
  })
  return router
}

/**
 * Reduce either report format to directive + blocked host. Unrecognised
 * bodies yield nothing.
 */
export function parseCspReports(body: unknown): CspViolation[] {
  const raw: Array<Record<string, unknown>> = []
  if (Array.isArray(body)) {
    // Reporting API: [{ type: 'csp-violation', body: { effectiveDirective, blockedURL } }]
    for (const entry of body) {
      if (isRecord(entry) && entry.type === 'csp-violation' && isRecord(entry.body)) raw.push(entry.body)
    }
  } else if (isRecord(body) && isRecord(body['csp-report'])) {
    // report-uri: { "csp-report": { "effective-directive", "violated-directive", "blocked-uri" } }
    raw.push(body['csp-report'])
  }

  return raw.map(r => ({
    directive: directiveName(r.effectiveDirective ?? r['effective-directive'] ?? r['violated-directive']),
    blocked: blockedSource(r.blockedURL ?? r['blocked-uri']),
  }))
}

function directiveName(value: unknown): string {
  // violated-directive may carry the whole directive ("img-src 'self' data:").
  const name = typeof value === 'string' ? value.trim().split(/\s+/)[0] : ''
  return /^[a-z-]{1,40}$/.test(name) ? name : 'unknown'
}

/** The blocked origin's host, or the CSP keyword (`inline`, `eval`, `data`, …). Never a path or query. */
function blockedSource(value: unknown): string {
  if (typeof value !== 'string' || value === '') return 'unknown'
  if (/^[a-z-]{1,20}$/.test(value)) return value
  try {
    const url = new URL(value)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'wss:' || url.protocol === 'ws:') {
      return url.host
    }
    return url.protocol.replace(/:$/, '')
  } catch {
    return 'unknown'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
