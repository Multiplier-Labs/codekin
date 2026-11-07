/**
 * Origin-header validation for incoming WebSocket connections.
 *
 * Browsers always send an Origin header on WebSocket handshakes, so a
 * missing Origin in production indicates a non-browser client (curl,
 * proxies, or attackers attempting to bypass the cross-site WebSocket
 * hijacking check). In production we reject those.
 *
 * Dev mode stays relaxed so CLI tools and local scripts continue to work.
 *
 * Besides `CORS_ORIGIN`, a **same-origin** handshake is accepted when the
 * server is reached by `localhost` or an IP literal: the page was served by
 * this very server (`codekin start`, the service, the desktop app), so it is
 * not a cross-site request. Before this, a server serving its own frontend
 * without `CORS_ORIGIN` set (the default `http://localhost:5173` is the Vite
 * dev server) closed its own page's WebSocket. Same-origin by *domain name*
 * is not accepted, because DNS rebinding can make an attacker's domain
 * resolve to this host; deployments on a domain keep setting `CORS_ORIGIN`.
 */

/** `localhost` or an IPv4 / bracketed IPv6 literal: names DNS rebinding can't forge. */
function isLiteralLocalHost(hostname: string): boolean {
  if (hostname === 'localhost') return true
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) return true
  return hostname.startsWith('[') && hostname.endsWith(']')
}

/**
 * Whether `origin` is the page origin of a request whose `Host` header is
 * `host`, and that host is localhost or an IP literal.
 */
export function isLiteralSameOrigin(origin: string, host: string | undefined): boolean {
  if (!host) return false
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.host.toLowerCase() !== host.toLowerCase()) return false
  return isLiteralLocalHost(url.hostname.toLowerCase())
}

export function isWsOriginAllowed(
  origin: string | undefined,
  corsOrigin: string,
  isProduction: boolean,
  host?: string,
): boolean {
  if (typeof origin === 'string' && origin && isLiteralSameOrigin(origin, host)) return true
  if (isProduction) {
    return typeof origin === 'string' && origin === corsOrigin
  }
  // Dev: accept missing Origin (CLI tools); reject only mismatched non-empty Origin.
  if (!origin) return true
  return origin === corsOrigin
}
