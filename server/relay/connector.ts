/**
 * Local connector: runs on a developer machine, holds an outbound
 * WebSocket to the hosted relay hub, keeps the machine marked online, and
 * serves proxied REST requests against the local Codekin server.
 *
 * Session streaming attaches to the same socket in a later phase.
 */

import WebSocket from 'ws'
import { envelope, parseEnvelope } from './relay-protocol.js'
import type { ConnectorHello, ConnectorHelloAck, ProxyRequest, RelayError } from './relay-protocol.js'
import { executeProxyRequest, resolveLocalTarget } from './connector-proxy.js'
import type { FetchLike, LocalServerTarget } from './connector-proxy.js'

export interface ConnectorOptions {
  /** Hosted relay origin, e.g. https://app.codekin.ai */
  relayUrl: string
  machineId: string
  machineSecret: string
  connectorVersion: string
  localCodekinVersion?: string
  /** Local Codekin server to proxy to; resolved from env/token file by default. */
  localTarget?: LocalServerTarget
  /** Injectable fetch, for tests. */
  fetchImpl?: FetchLike
  /** Called on lifecycle events for CLI output. */
  onStatus?: (status: ConnectorStatus, detail?: string) => void
  /** Called for each proxied request, for CLI output. */
  onProxy?: (method: string, path: string, status: number | string) => void
}

export type ConnectorStatus =
  | 'connecting'
  | 'connected'
  | 'auth_failed'
  | 'disconnected'
  | 'reconnect_scheduled'
  | 'stopped'

const HEARTBEAT_INTERVAL_MS = 30_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
const CLOSE_AUTH_FAILED = 4001

/** Convert the https:// relay origin to the wss:// connector endpoint. */
export function connectorWsUrl(relayUrl: string): string {
  const url = new URL(relayUrl)
  url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:'
  url.pathname = '/relay/connector'
  url.search = ''
  return url.toString()
}

export class RelayConnector {
  private ws: WebSocket | null = null
  private heartbeat: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = BACKOFF_MIN_MS
  private stopped = false
  private localTarget: LocalServerTarget

  constructor(private opts: ConnectorOptions) {
    this.localTarget = opts.localTarget ?? resolveLocalTarget()
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    this.clearTimers()
    this.ws?.close(1000, 'connector stopped')
    this.ws = null
    this.opts.onStatus?.('stopped')
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  private clearTimers(): void {
    if (this.heartbeat) { clearInterval(this.heartbeat); this.heartbeat = null }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null }
  }

  private connect(): void {
    if (this.stopped) return
    this.opts.onStatus?.('connecting', connectorWsUrl(this.opts.relayUrl))
    const ws = new WebSocket(connectorWsUrl(this.opts.relayUrl))
    this.ws = ws

    ws.on('open', () => {
      const hello: ConnectorHello = {
        machineId: this.opts.machineId,
        machineSecret: this.opts.machineSecret,
        connectorVersion: this.opts.connectorVersion,
        localCodekinVersion: this.opts.localCodekinVersion,
        capabilities: { restProxy: true, wsProxy: false, fileUpload: false, providers: [] },
      }
      ws.send(JSON.stringify(envelope('hello', hello)))
    })

    ws.on('message', (data: Buffer | string) => {
      const msg = parseEnvelope(typeof data === 'string' ? data : data.toString('utf-8'))
      if (!msg) return
      if (msg.kind === 'hello_ack') {
        this.backoffMs = BACKOFF_MIN_MS
        const ack = msg.payload as ConnectorHelloAck
        this.opts.onStatus?.('connected', ack.displayName)
        this.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(envelope('ping', {})))
          }
        }, HEARTBEAT_INTERVAL_MS)
        this.heartbeat.unref()
      } else if (msg.kind === 'request') {
        void this.handleProxyRequest(ws, msg.id, msg.payload as ProxyRequest)
      } else if (msg.kind === 'error') {
        const err = msg.payload as RelayError
        this.opts.onStatus?.('disconnected', `${err.code}: ${err.message}`)
      }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers()
      this.ws = null
      if (code === CLOSE_AUTH_FAILED) {
        // Credential rejected — retrying would loop forever on a revoked machine
        this.opts.onStatus?.('auth_failed', reason.toString() || 'credential rejected')
        this.stopped = true
        return
      }
      if (this.stopped) return
      this.opts.onStatus?.('disconnected', `code ${code}`)
      this.scheduleReconnect()
    })

    ws.on('error', () => {
      // close follows; reconnect is handled there
    })
  }

  /**
   * Serve one proxied request. The allowlist check lives in
   * executeProxyRequest, so a hub that asks for a disallowed path gets an
   * error envelope back rather than a local call.
   */
  private async handleProxyRequest(ws: WebSocket, id: string | undefined, request: ProxyRequest): Promise<void> {
    if (!id) return
    const outcome = await executeProxyRequest(request, {
      target: this.localTarget,
      fetchImpl: this.opts.fetchImpl,
    })
    if (ws.readyState !== WebSocket.OPEN) return

    if ('error' in outcome) {
      this.opts.onProxy?.(request.method, request.path, outcome.error.code)
      ws.send(JSON.stringify(envelope('error', outcome.error, { id })))
      return
    }
    this.opts.onProxy?.(request.method, request.path, outcome.response.status)
    ws.send(JSON.stringify(envelope('response', outcome.response, { id })))
  }

  private scheduleReconnect(): void {
    // Exponential backoff with full jitter (spec §11.3)
    const delay = Math.floor(Math.random() * this.backoffMs) + BACKOFF_MIN_MS
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.opts.onStatus?.('reconnect_scheduled', `${delay}ms`)
    this.reconnectTimer = setTimeout(() => { this.connect(); }, delay)
  }
}
