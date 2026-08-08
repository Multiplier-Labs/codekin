/**
 * Browser-side client for the relay's /relay/browser WebSocket.
 *
 * One connection is bound to one machine (the hub enforces this at hello
 * time) and multiplexes proxied REST calls over it by envelope id. The
 * session cookie authenticates the upgrade, so nothing auth-related travels
 * in the URL or in application frames.
 */

export const RELAY_PROTOCOL_VERSION = 1

export interface RelayProxyResponse {
  status: number
  headers: Record<string, string>
  body?: string
}

export interface RelayErrorPayload {
  code: string
  message: string
}

/** Thrown by `request()` when the relay or the machine refuses the call. */
export class RelayRequestError extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.name = 'RelayRequestError'
    this.code = code
  }
}

export type RelayConnectionState = 'connecting' | 'open' | 'closed'

interface Pending {
  resolve: (value: RelayProxyResponse) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
}

/** Callbacks for one proxied session stream. */
export interface ChannelHandlers {
  /** The machine's local socket is open and authenticated. */
  onReady: () => void
  /** A frame from the local server. */
  onData: (data: string) => void
  /** The channel ended — no further callbacks follow. */
  onClose: (code: number, reason: string) => void
  onError: (error: RelayErrorPayload) => void
}

/** Close code reported when the relay socket itself goes away. */
const CLOSE_RELAY_GONE = 4002

const REQUEST_TIMEOUT_MS = 35_000
const BACKOFF_MIN_MS = 500
const BACKOFF_MAX_MS = 15_000

/** Close code the hub uses when the user may not reach the machine. */
const CLOSE_FORBIDDEN = 4003

export interface RelayConnectionOptions {
  machineId: string
  /** Override the socket URL (tests). Defaults to the current origin. */
  url?: string
  onStateChange?: (state: RelayConnectionState, detail?: string) => void
  /** Called when the machine's online flag arrives with hello_ack. */
  onMachineStatus?: (online: boolean, displayName: string) => void
}

export function browserRelayUrl(machineId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/relay/browser?machine=${encodeURIComponent(machineId)}`
}

export class RelayConnection {
  private ws: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private channels = new Map<string, ChannelHandlers>()
  private queued: (() => void)[] = []
  private backoffMs = BACKOFF_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false
  private nextId = 1
  private state: RelayConnectionState = 'closed'
  private opts: RelayConnectionOptions

  constructor(opts: RelayConnectionOptions) {
    this.opts = opts
  }

  get connectionState(): RelayConnectionState {
    return this.state
  }

  connect(): void {
    if (this.ws || this.closedByUs) return
    this.setState('connecting')

    const ws = new WebSocket(this.opts.url ?? browserRelayUrl(this.opts.machineId))
    this.ws = ws

    ws.onopen = () => {
      ws.send(
        JSON.stringify({
          version: RELAY_PROTOCOL_VERSION,
          kind: 'hello',
          payload: { machineId: this.opts.machineId },
        }),
      )
    }

    ws.onmessage = event => { this.handleMessage(event.data as string) }

    ws.onclose = event => {
      this.ws = null
      this.failAllPending(new RelayRequestError('disconnected', 'Relay connection closed'))
      this.failAllChannels('relay connection closed')
      if (this.closedByUs) {
        this.setState('closed')
        return
      }
      if (event.code === CLOSE_FORBIDDEN) {
        // Retrying cannot fix an access decision.
        this.closedByUs = true
        this.setState('closed', 'no access to this machine')
        return
      }
      this.setState('closed', `code ${event.code}`)
      this.scheduleReconnect()
    }

    ws.onerror = () => {
      // close follows; reconnect is handled there
    }
  }

  close(): void {
    this.closedByUs = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.failAllPending(new RelayRequestError('disconnected', 'Relay connection closed'))
    this.failAllChannels('relay connection closed')
    this.ws?.close(1000, 'client closed')
    this.ws = null
    this.setState('closed')
  }

  /**
   * Issue a proxied REST call. Requests made before the socket is ready are
   * queued rather than rejected, so callers need not await connection.
   */
  request(method: string, path: string, body?: string, contentType?: string): Promise<RelayProxyResponse> {
    return new Promise<RelayProxyResponse>((resolve, reject) => {
      const id = String(this.nextId++)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RelayRequestError('timeout', 'The relay did not respond in time'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer })

      const send = () => {
        this.ws?.send(
          JSON.stringify({
            version: RELAY_PROTOCOL_VERSION,
            kind: 'request',
            id,
            payload: { method, path, body, contentType },
          }),
        )
      }

      if (this.state === 'open' && this.ws?.readyState === WebSocket.OPEN) {
        send()
      } else {
        this.queued.push(send)
        this.connect()
      }
    })
  }

  /**
   * Open a session stream channel. The caller owns `channelId` (it is scoped
   * to this connection) and must call `closeChannel` when done.
   */
  openChannel(channelId: string, handlers: ChannelHandlers): void {
    this.channels.set(channelId, handlers)
    this.sendOrQueue({ kind: 'stream_open', channelId, payload: {} })
  }

  /** Relay a frame onto an open channel. */
  sendChannelData(channelId: string, data: string): void {
    if (!this.channels.has(channelId)) return
    this.sendOrQueue({ kind: 'stream_data', channelId, payload: { data } })
  }

  /** Close a channel; its handlers stop firing immediately. */
  closeChannel(channelId: string, code?: number, reason?: string): void {
    if (!this.channels.delete(channelId)) return
    this.sendOrQueue({ kind: 'stream_close', channelId, payload: { code, reason } })
  }

  private sendOrQueue(frame: { kind: string; channelId?: string; id?: string; payload: unknown }): void {
    const send = () => {
      this.ws?.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, ...frame }))
    }
    if (this.state === 'open' && this.ws?.readyState === WebSocket.OPEN) {
      send()
    } else {
      this.queued.push(send)
      this.connect()
    }
  }

  private handleMessage(raw: string): void {
    let msg: { kind?: string; id?: string; channelId?: string; payload?: unknown }
    try {
      msg = JSON.parse(raw) as typeof msg
    } catch {
      return
    }

    if (msg.kind === 'hello_ack') {
      const ack = msg.payload as { online?: boolean; displayName?: string }
      this.backoffMs = BACKOFF_MIN_MS
      this.setState('open')
      this.opts.onMachineStatus?.(ack.online === true, ack.displayName ?? this.opts.machineId)
      const queued = this.queued
      this.queued = []
      for (const send of queued) send()
      return
    }

    if (msg.channelId) {
      this.handleChannelFrame(msg.channelId, msg.kind, msg.payload)
      return
    }

    if (!msg.id) return
    const entry = this.pending.get(msg.id)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(msg.id)

    if (msg.kind === 'error') {
      const err = msg.payload as Partial<RelayErrorPayload>
      entry.reject(new RelayRequestError(err.code ?? 'relay_error', err.message ?? 'Relay error'))
      return
    }
    if (msg.kind === 'response') {
      entry.resolve(msg.payload as RelayProxyResponse)
    }
  }

  private handleChannelFrame(channelId: string, kind: string | undefined, payload: unknown): void {
    const handlers = this.channels.get(channelId)
    if (!handlers) return

    if (kind === 'event' && (payload as { status?: string } | undefined)?.status === 'open') {
      handlers.onReady()
      return
    }
    if (kind === 'stream_data') {
      const data = (payload as { data?: unknown }).data
      if (typeof data === 'string') handlers.onData(data)
      return
    }
    if (kind === 'stream_close') {
      const close = payload as { code?: number; reason?: string }
      this.channels.delete(channelId)
      handlers.onClose(close.code ?? 1000, close.reason ?? 'closed')
      return
    }
    if (kind === 'error') {
      const err = payload as Partial<RelayErrorPayload>
      const error = { code: err.code ?? 'relay_error', message: err.message ?? 'Relay error' }
      this.channels.delete(channelId)
      handlers.onError(error)
      handlers.onClose(CLOSE_RELAY_GONE, error.message)
    }
  }

  private failAllChannels(reason: string): void {
    for (const [channelId, handlers] of [...this.channels]) {
      this.channels.delete(channelId)
      handlers.onClose(CLOSE_RELAY_GONE, reason)
    }
  }

  private failAllPending(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this.pending.clear()
    this.queued = []
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return
    const delay = Math.floor(Math.random() * this.backoffMs) + BACKOFF_MIN_MS
    this.backoffMs = Math.min(this.backoffMs * 2, BACKOFF_MAX_MS)
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private setState(state: RelayConnectionState, detail?: string): void {
    this.state = state
    this.opts.onStateChange?.(state, detail)
  }
}

/** Decode a base64 relay body into bytes suitable for a Response. */
export function decodeBody(body: string | undefined): Uint8Array | null {
  if (!body) return null
  const binary = atob(body)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** Encode a request body string as base64 for the relay envelope. */
export function encodeBody(body: string): string {
  const bytes = new TextEncoder().encode(body)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
