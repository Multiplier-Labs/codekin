/**
 * Transport layer between the frontend and a Codekin server.
 *
 * Paths given to `fetch`/`authFetch`/`externalUrl` are server-side paths
 * (e.g. '/api/sessions/list', '/auth-verify'). Each implementation maps them
 * onto its own wire format: the local transport prefixes them with '/cc'
 * (nginx/Vite proxy to the local server), while a hosted relay transport
 * routes them through the relay hub to a paired machine.
 */
export interface CodekinTransport {
  /** Plain fetch against the Codekin server. */
  fetch(path: string, init?: RequestInit): Promise<Response>

  /**
   * Fetch that additionally detects an expired hosting-environment auth
   * session (Authelia in local mode). On expiry it redirects to login and
   * rejects with `Error('Session expired')`.
   */
  authFetch(path: string, init?: RequestInit): Promise<Response>

  /**
   * URL for the session-stream WebSocket. The auth token is never part of
   * this URL — it is sent as a post-connect `auth` message.
   */
  wsUrl(): string

  /** Open the session-stream WebSocket (caller performs the Codekin `auth` handshake). */
  openSocket(): WebSocket

  /** Probe whether the hosting environment's auth session is still valid. */
  checkAuthSession(): Promise<boolean>

  /** Send the user to the hosting environment's login flow. */
  redirectToLogin(): void

  /** Absolute browser-facing URL for a server path (display only, e.g. webhook setup). */
  externalUrl(path: string): string
}
