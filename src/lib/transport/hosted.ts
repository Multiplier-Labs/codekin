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
import { RelayWebSocket } from './relay-socket'

/** Control-plane sign-in entry point. */
const LOGIN_PATH = '/api/auth/github/start'

/**
 * Encode a request body for the relay envelope.
 *
 * Strings take the fast path; FormData/Blob/ArrayBuffer bodies (file uploads)
 * are serialized through a throwaway Request, which also yields the multipart
 * content type with its generated boundary. An explicit Content-Type from the
 * caller wins, since that is what a direct fetch would have sent.
 */
async function encodeRequestBody(
  init?: RequestInit,
): Promise<{ body?: string; contentType?: string }> {
  if (init?.body == null) return {}

  const explicitType = new Headers(init.headers).get('content-type') ?? undefined
  if (typeof init.body === 'string') {
    return { body: encodeBody(init.body), contentType: explicitType }
  }

  const probe = new Request('http://relay.invalid/', { method: 'POST', body: init.body })
  const bytes = new Uint8Array(await probe.arrayBuffer())
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return { body: btoa(binary), contentType: explicitType ?? probe.headers.get('content-type') ?? undefined }
}

export class HostedRelayTransport implements CodekinTransport {
  readonly machineId: string
  private connection: RelayConnection
  private redirecting = false
  /** Channel ids only need to be unique within this connection. */
  private nextChannel = 0

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
    const { body, contentType } = await encodeRequestBody(init)

    try {
      const proxied = await this.connection.request(method, path, body, contentType)
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

  /**
   * There is no browser-visible URL for a relayed session socket — the
   * stream is a channel on the relay connection. Returned for display and
   * diagnostics only.
   */
  wsUrl(): string {
    return `relay://${this.machineId}`
  }

  /**
   * Open a session stream to the machine. The returned object behaves as a
   * WebSocket for the members the app uses; the connector performs the local
   * auth handshake, so the app's own `auth` frame is answered from the
   * machine's cached `connected` reply.
   */
  openSocket(): WebSocket {
    const channelId = `ch-${++this.nextChannel}`
    return new RelayWebSocket(this.connection, channelId) as unknown as WebSocket
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
