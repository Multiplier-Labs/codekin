/**
 * Local connector: runs on a developer machine, holds an outbound
 * WebSocket to the hosted relay hub, keeps the machine marked online,
 * serves proxied REST requests, and bridges session streams to the local
 * Codekin server.
 */

import WebSocket from 'ws'
import { envelope, parseEnvelope, RELAY_ERROR, STREAM_CLOSE } from './relay-protocol.js'
import type {
  ConnectorHello,
  ConnectorHelloAck,
  ProxyRequest,
  RelayError,
  StreamClose,
  StreamData,
  StreamOpen,
  LocalSessionSummary,
} from './relay-protocol.js'
import { executeProxyRequest, resolveLocalTarget } from './connector-proxy.js'
import type { FetchLike, LocalServerTarget } from './connector-proxy.js'
import { StreamChannel } from './connector-stream.js'
import type { WebSocketFactory } from './connector-stream.js'
import type { ChannelPolicy } from './connector-policy.js'
import type { GrantMap } from './shares.js'

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
  /** Injectable local WebSocket factory, for tests. */
  socketFactory?: WebSocketFactory
  /** Called on lifecycle events for CLI output. */
  onStatus?: (status: ConnectorStatus, detail?: string) => void
  /** Called for each proxied request, for CLI output. */
  onProxy?: (method: string, path: string, status: number | string) => void
  /** Called when a session stream opens or closes, for CLI output. */
  onStream?: (event: 'open' | 'close' | 'denied', channelId: string, detail?: string) => void
}

export type ConnectorStatus =
  | 'connecting'
  | 'connected'
  | 'auth_failed'
  | 'disconnected'
  | 'reconnect_scheduled'
  | 'replaced'
  | 'stopped'

const HEARTBEAT_INTERVAL_MS = 30_000
const BACKOFF_MIN_MS = 1_000
const BACKOFF_MAX_MS = 60_000
const CLOSE_AUTH_FAILED = 4001
/** The hub gave this machine's slot to a newer connection. */
const CLOSE_REPLACED = 4009

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
  private channels = new Map<string, StreamChannel>()

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
    this.closeAllChannels('connector stopped')
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
      // Capabilities are re-advertised on every reconnect (spec §11.3).
      // Session counts follow separately, because being reachable must not
      // depend on the local server answering promptly (spec §11.4).
      const hello: ConnectorHello = {
        machineId: this.opts.machineId,
        machineSecret: this.opts.machineSecret,
        connectorVersion: this.opts.connectorVersion,
        localCodekinVersion: this.opts.localCodekinVersion,
        capabilities: { restProxy: true, wsProxy: true, fileUpload: true, providers: [] },
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
        void this.advertiseSessions(ws)
      } else if (msg.kind === 'request') {
        void this.handleProxyRequest(ws, msg.id, msg.payload as ProxyRequest)
      } else if (msg.kind === 'stream_open') {
        this.openChannel(ws, msg.channelId, msg.payload as StreamOpen)
      } else if (msg.kind === 'stream_data') {
        if (msg.channelId) this.channels.get(msg.channelId)?.send((msg.payload as StreamData).data)
      } else if (msg.kind === 'stream_close') {
        this.closeChannel(msg.channelId, msg.payload as StreamClose)
      } else if (msg.kind === 'error') {
        const err = msg.payload as RelayError
        this.opts.onStatus?.('disconnected', `${err.code}: ${err.message}`)
      }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers()
      this.ws = null
      // Local sockets outlive nothing: without the relay there is no browser
      // on the other end, and a stale session would keep the CLI busy.
      this.closeAllChannels('relay disconnected')
      if (code === CLOSE_AUTH_FAILED) {
        // Credential rejected — retrying would loop forever on a revoked machine
        this.opts.onStatus?.('auth_failed', reason.toString() || 'credential rejected')
        this.stopped = true
        return
      }
      if (code === CLOSE_REPLACED) {
        // Another connector took this machine. Reconnecting would take it
        // back, and the two would trade the slot forever — so stand down.
        this.opts.onStatus?.('replaced', reason.toString() || 'another connector took over')
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


  /**
   * Report local session counts once the socket is up. Best-effort: a local
   * server that is down must not stop the connector from being reachable,
   * since being reachable is how the user learns the machine is degraded.
   */
  private async advertiseSessions(ws: WebSocket): Promise<void> {
    const sessions = await this.localSessionSummary()
    if (!sessions || ws.readyState !== WebSocket.OPEN) return
    ws.send(JSON.stringify(envelope('event', { sessions })))
  }

  /** Count local sessions, or undefined when the local server did not answer. */
  private async localSessionSummary(): Promise<LocalSessionSummary | undefined> {
    const outcome = await executeProxyRequest(
      { method: 'GET', path: '/api/sessions/list', principal: { userId: 'connector', role: 'owner', grants: {} } },
      { target: this.localTarget, fetchImpl: this.opts.fetchImpl, timeoutMs: 3_000 },
    )
    if ('error' in outcome || !outcome.response.body) return undefined
    try {
      const parsed = JSON.parse(Buffer.from(outcome.response.body, 'base64').toString()) as {
        sessions?: { active?: boolean }[]
      }
      if (!Array.isArray(parsed.sessions)) return undefined
      return { total: parsed.sessions.length, active: parsed.sessions.filter(s => s.active).length }
    } catch {
      return undefined
    }
  }

  /** Open a local session socket for a channel the hub asked for. */
  private openChannel(ws: WebSocket, channelId: string | undefined, open?: StreamOpen): void {
    if (!channelId || this.channels.has(channelId)) return

    const principal = open?.principal
    if (!principal) {
      ws.send(
        JSON.stringify(
          envelope('error', { code: RELAY_ERROR.forbidden, message: 'Channel carried no principal' }, { channelId }),
        ),
      )
      return
    }
    const policy: ChannelPolicy = {
      role: principal.role === 'owner' ? 'owner' : 'grantee',
      grants: principal.grants as GrantMap,
    }

    const send = (kind: 'event' | 'stream_data' | 'stream_close' | 'error', payload: unknown) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(envelope(kind, payload, { channelId })))
      }
    }

    const channel = new StreamChannel(
      this.localTarget,
      {
        onReady: () => {
          this.opts.onStream?.('open', channelId)
          send('event', { status: 'open' })
        },
        onData: data => { send('stream_data', { data }) },
        onClose: (code, reason) => {
          this.channels.delete(channelId)
          this.opts.onStream?.('close', channelId, `${code} ${reason}`)
          send('stream_close', { code, reason })
        },
        onDenied: (reason, permission) => {
          this.opts.onStream?.('denied', channelId, reason)
          send('error', { code: RELAY_ERROR.notPermitted, message: reason, permission })
        },
      },
      this.opts.socketFactory,
      policy,
    )

    this.channels.set(channelId, channel)
    channel.open()
  }

  private closeChannel(channelId: string | undefined, payload?: StreamClose): void {
    if (!channelId) return
    const channel = this.channels.get(channelId)
    if (!channel) return
    this.channels.delete(channelId)
    channel.close(payload?.code ?? STREAM_CLOSE.normal, payload?.reason ?? 'browser closed the channel')
  }

  /** Drop every local session socket (relay disconnect / shutdown). */
  private closeAllChannels(reason: string): void {
    for (const [channelId, channel] of this.channels) {
      this.channels.delete(channelId)
      channel.close(STREAM_CLOSE.normal, reason)
    }
  }

  private scheduleReconnect(): void {
    // Exponential backoff with full jitter (spec §11.3)
    const delay = Math.floor(Math.random() * this.backoffMs) + BACKOFF_MIN_MS
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.opts.onStatus?.('reconnect_scheduled', `${delay}ms`)
    this.reconnectTimer = setTimeout(() => { this.connect(); }, delay)
  }
}
