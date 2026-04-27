/**
 * Origin-header validation for incoming WebSocket connections.
 *
 * Browsers always send an Origin header on WebSocket handshakes, so a
 * missing Origin in production indicates a non-browser client (curl,
 * proxies, or attackers attempting to bypass the cross-site WebSocket
 * hijacking check). In production we reject those.
 *
 * Dev mode stays relaxed so CLI tools and local scripts continue to work.
 */
export function isWsOriginAllowed(
  origin: string | undefined,
  corsOrigin: string,
  isProduction: boolean,
): boolean {
  if (isProduction) {
    return typeof origin === 'string' && origin === corsOrigin
  }
  // Dev: accept missing Origin (CLI tools); reject only mismatched non-empty Origin.
  if (!origin) return true
  return origin === corsOrigin
}
