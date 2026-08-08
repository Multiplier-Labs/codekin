/**
 * Connector-side session streaming: one proxied channel ↔ one WebSocket to
 * the local Codekin server.
 *
 * The connector owns the local handshake. It authenticates with the machine's
 * own token and then pipes frames opaquely, so the relay never carries the
 * local credential and the browser never needs one. The browser's own `auth`
 * frame is answered locally from the cached `connected` reply rather than
 * forwarded, which lets the unmodified frontend run against a relayed socket.
 */

import WebSocket from 'ws'
import { STREAM_CLOSE } from './relay-protocol.js'
import type { LocalServerTarget } from './connector-proxy.js'
import { checkClientFrame, newChannelState, observeServerFrame } from './connector-policy.js'
import type { ChannelPolicy, ChannelState } from './connector-policy.js'

/** The local server drops sockets that do not authenticate promptly. */
const LOCAL_HANDSHAKE_TIMEOUT_MS = 10_000

export interface StreamChannelCallbacks {
  /** Local socket is open and authenticated. */
  onReady: () => void
  /** A frame from the local server, to be relayed verbatim. */
  onData: (data: string) => void
  /** The channel ended; no further callbacks follow. */
  onClose: (code: number, reason: string) => void
  /** A browser frame the grant did not permit; it was not forwarded. */
  onDenied?: (reason: string, permission?: string) => void
}

/** Convert the local server origin to its WebSocket URL. */
export function localWsUrl(origin: string): string {
  const url = new URL(origin)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = '/'
  return url.toString()
}

export type WebSocketFactory = (url: string, options?: { origin?: string }) => WebSocket

/** The local server closes with this when the Origin header is unacceptable. */
const LOCAL_CLOSE_ORIGIN_REJECTED = 4003

/**
 * A single proxied session stream. Created on `stream_open`, closed when
 * either end goes away.
 */
export class StreamChannel {
  private ws: WebSocket | null = null
  private ready = false
  private closed = false
  /** The local server's `connected` reply, replayed to the browser's auth frame. */
  private connectedFrame: string | null = null
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null

  private state: ChannelState = newChannelState()

  constructor(
    private target: LocalServerTarget,
    private callbacks: StreamChannelCallbacks,
    private createSocket: WebSocketFactory = (url, options) => new WebSocket(url, options),
    /** Owner by default: an unshared channel belongs to the machine's owner. */
    private policy: ChannelPolicy = { role: 'owner', grants: {} },
  ) {}

  /** Open the local socket and perform the local auth handshake. */
  open(): void {
    // `origin` is only sent when configured: a production local server
    // demands a matching one, a dev server accepts none at all.
    const ws = this.createSocket(
      localWsUrl(this.target.origin),
      this.target.browserOrigin ? { origin: this.target.browserOrigin } : undefined,
    )
    this.ws = ws

    this.handshakeTimer = setTimeout(() => {
      this.finish(STREAM_CLOSE.localAuthFailed, 'local handshake timed out')
    }, LOCAL_HANDSHAKE_TIMEOUT_MS)
    this.handshakeTimer.unref?.()

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.target.authToken }))
    })

    ws.on('message', (raw: Buffer | string) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf-8')
      if (!this.ready) {
        // Everything before `connected` belongs to the local handshake.
        if (this.frameType(text) !== 'connected') return
        this.ready = true
        this.connectedFrame = text
        if (this.handshakeTimer) {
          clearTimeout(this.handshakeTimer)
          this.handshakeTimer = null
        }
        this.callbacks.onReady()
        return
      }
      // Remember what the server asked, so an approval answer can be
      // classified against the tool it belongs to.
      observeServerFrame(this.state, text)
      this.callbacks.onData(text)
    })

    ws.on('close', (code: number, reason: Buffer) => {
      // A local socket that closes before `connected` was rejected: the
      // machine's own token or Origin is wrong, which no browser retry fixes.
      const closeCode = this.ready ? code : STREAM_CLOSE.localAuthFailed
      this.finish(closeCode, this.describeLocalClose(code, reason.toString()))
    })

    ws.on('error', () => {
      // close follows
    })
  }

  /**
   * Relay a browser frame to the local server. The browser's `auth` frame is
   * answered from the cached handshake instead of being forwarded — the
   * browser has no local token, and the socket is already authenticated.
   */
  send(data: string): void {
    if (this.closed) return
    if (this.frameType(data) === 'auth') {
      if (this.connectedFrame) this.callbacks.onData(this.connectedFrame)
      return
    }

    // The grant is enforced here, on the machine — the hub's own check is
    // not trusted to have been correct or to have happened at all.
    const decision = checkClientFrame(this.policy, this.state, data)
    if (!decision.allowed) {
      this.callbacks.onDenied?.(decision.reason ?? 'Not permitted', decision.permission)
      return
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(data)
    }
  }

  /** Close the local socket (browser closed the channel, or shutdown). */
  close(code: number = STREAM_CLOSE.normal, reason = 'closed'): void {
    if (this.closed) return
    this.closed = true
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    // Local close codes must be valid on the wire; 4xxx and 1000 are.
    this.ws?.close(code, reason.slice(0, 120))
    this.ws = null
  }

  private finish(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
    this.ws = null
    this.callbacks.onClose(code, reason)
  }

  /**
   * Turn a local close into something the user can act on. An Origin
   * rejection is a configuration problem on this machine, not a relay fault,
   * and the fix is a single environment variable.
   */
  private describeLocalClose(code: number, reason: string): string {
    if (code === LOCAL_CLOSE_ORIGIN_REJECTED) {
      return this.target.browserOrigin
        ? `local server rejected Origin "${this.target.browserOrigin}" — it must match the server's CORS_ORIGIN`
        : 'local server requires an Origin — set RELAY_LOCAL_ORIGIN to its CORS_ORIGIN and restart the connector'
    }
    return reason || 'local socket closed'
  }

  /** Read the `type` field of a local protocol frame without full validation. */
  private frameType(text: string): string | null {
    try {
      const parsed = JSON.parse(text) as { type?: unknown }
      return typeof parsed.type === 'string' ? parsed.type : null
    } catch {
      return null
    }
  }
}
