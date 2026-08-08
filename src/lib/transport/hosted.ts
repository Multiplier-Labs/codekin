/**
 * Hosted relay transport: REST calls to a paired machine travel over the
 * /relay/browser WebSocket instead of the local /cc proxy.
 *
 * The outer auth session is the control plane's own cookie session (GitHub
 * sign-in), so session expiry is detected against /api/me rather than
 * Authelia. Session streaming (`openSocket`) lands in the next phase.
 */

import type { CodekinTransport } from './types'
import { RelayConnection, RelayRequestError, decodeBody, encodeBody } from './relay-client'

/** Control-plane sign-in entry point. */
const LOGIN_PATH = '/api/auth/github/start'

export class HostedRelayTransport implements CodekinTransport {
  readonly machineId: string
  private connection: RelayConnection
  private redirecting = false

  constructor(machineId: string, connection?: RelayConnection) {
    this.machineId = machineId
    this.connection = connection ?? new RelayConnection({ machineId })
  }

  /** Open the underlying relay socket (idempotent). */
  connect(): void {
    this.connection.connect()
  }

  /** Tear down the relay socket — call when switching machines. */
  close(): void {
    this.connection.close()
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? encodeBody(init.body) : undefined

    try {
      const proxied = await this.connection.request(method, path, body)
      const bytes = decodeBody(proxied.body)
      return new Response(bytes ? bytes.slice().buffer : null, {
        status: proxied.status,
        headers: proxied.headers,
      })
    } catch (err) {
      // Relay-level failures have no HTTP analogue on the machine; surface
      // them as 502 so callers' existing !res.ok paths handle them.
      const relayError = err instanceof RelayRequestError ? err : null
      return new Response(
        JSON.stringify({
          error: relayError?.message ?? 'Relay request failed',
          relayCode: relayError?.code ?? 'relay_error',
        }),
        { status: 502, headers: { 'content-type': 'application/json' } },
      )
    }
  }

  async authFetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetch(path, init)
    // A machine-level 401 means the connector's local token is wrong — a
    // machine problem, not an expired browser session. Only the control
    // plane can invalidate the browser session, so probe it explicitly.
    if (res.status === 502 && !(await this.checkAuthSession())) {
      this.redirectToLogin()
      throw new Error('Session expired')
    }
    return res
  }

  wsUrl(): string {
    throw new Error('Session streaming over the hosted relay is not available yet')
  }

  openSocket(): WebSocket {
    throw new Error('Session streaming over the hosted relay is not available yet')
  }

  async checkAuthSession(): Promise<boolean> {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (res.status === 401) return false
      return true
    } catch {
      // Network error — don't treat as auth failure
      return true
    }
  }

  redirectToLogin(): void {
    if (this.redirecting) return
    this.redirecting = true
    window.location.href = LOGIN_PATH
  }

  /**
   * Absolute URL for display. In hosted mode the machine's own address is
   * not reachable from the browser, so this returns the hosted-app form;
   * features that need a machine-public URL (webhooks) stay local-only.
   */
  externalUrl(path: string): string {
    return `${location.protocol}//${location.host}${path}`
  }
}
