/**
 * CSRF defence for cookie-authenticated REST mutations.
 *
 * SameSite=Lax keeps other *sites* from sending the session cookie on a POST,
 * but every subdomain of the registrable domain is the same site. A mutation
 * is therefore accepted only when the browser says it came from the app's
 * own origin: `Origin` when present (all current browsers send it on
 * non-GET requests), else `Sec-Fetch-Site`. Requests carrying neither are not
 * from a browser (the connector CLI's pairing calls) and hold no cookie.
 */

import type { RequestHandler } from 'express'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function createMutationOriginGuard(publicUrl: string): RequestHandler {
  const expected = new URL(publicUrl).origin
  return (req, res, next) => {
    if (SAFE_METHODS.has(req.method) || !req.path.startsWith('/api/')) {
      next()
      return
    }
    const origin = req.get('origin')
    if (origin !== undefined) {
      if (origin === expected) {
        next()
        return
      }
      res.status(403).json({ error: 'Cross-origin request refused' })
      return
    }
    const fetchSite = req.get('sec-fetch-site')
    if (fetchSite !== undefined && fetchSite !== 'same-origin' && fetchSite !== 'none') {
      res.status(403).json({ error: 'Cross-origin request refused' })
      return
    }
    next()
  }
}
