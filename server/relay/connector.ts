/**
 * Local connector: runs on a developer machine, holds an outbound
 * WebSocket to the hosted relay hub, keeps the machine marked online,
 * serves proxied REST requests, and bridges session streams to the local
 * Codekin server.
 */

import WebSocket from 'ws'
import { ENROLMENT_FEATURE, envelope, INTENTS_FEATURE, parseEnvelope, RELAY_ERROR, STREAM_CLOSE } from './relay-protocol.js'
import type {
  ConnectorHello,
  EnrolRequest,
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
import { WebhookReplayGuard } from './connector-webhook-guard.js'
import { EnrolmentError } from './enrolment.js'
import type { MachineEnrolment } from './enrolment.js'
import { TrustStoreError } from './trust-store.js'
import type { IntentDecision, IntentVerifier } from './intent-verify.js'
import { describeIntentRefusal } from './connector-stream.js'

/** The relay error for a refused intent (signed-intents spec §6.4, "Refusals"). */
function intentError(verdict: IntentDecision): RelayError {
  return {
    code: RELAY_ERROR.notPermitted,
    message: describeIntentRefusal(verdict.reason),
    detail: verdict.reason ?? 'intent_required',
    ...(verdict.nonce ? { intentNonce: verdict.nonce } : {}),
    ...(verdict.machineTime !== undefined ? { machineTime: verdict.machineTime } : {}),
  }
}

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
  /** Replay protection for forwarded GitHub deliveries; persisted by default. */
  webhookGuard?: WebhookReplayGuard
  /** The machine identity public key (base64url SPKI), advertised in hello. */
  identityKey?: string
  /** Called with the owner's relay user id from hello_ack, for the trust store. */
  onOwner?: (ownerUserId: string) => void
  /** Answers enrol_* frames (enrolment.ts); without it the connector doesn't advertise enrolment. */
  enrolment?: Pick<MachineEnrolment, 'handle'>
  /** Checks signed intents on everything the relay delivers (intent-verify.ts). */
  intents?: Pick<IntentVerifier, 'checkRequest' | 'checkChannelOpen' | 'checkFrame'>
}

export type ConnectorStatus =
  | 'connecting'
  | 'connected'
  /** Connected, but the relay refuses traffic until this connector is updated. */
  | 'update_required'
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
  private webhookGuard: WebhookReplayGuard

  constructor(private opts: ConnectorOptions) {
    this.localTarget = opts.localTarget ?? resolveLocalTarget()
    this.webhookGuard = opts.webhookGuard ?? new WebhookReplayGuard()
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
        capabilities: {
          restProxy: true, wsProxy: true, fileUpload: true, providers: [],
          features: [
            ...(this.opts.enrolment ? [ENROLMENT_FEATURE] : []),
            ...(this.opts.intents ? [INTENTS_FEATURE] : []),
          ],
        },
        ...(this.opts.identityKey ? { identityKey: this.opts.identityKey } : {}),
      }
      ws.send(JSON.stringify(envelope('hello', hello)))
    })

    ws.on('message', (data: Buffer | string) => {
      const msg = parseEnvelope(typeof data === 'string' ? data : data.toString('utf-8'))
      if (!msg) return
      if (msg.kind === 'hello_ack') {
        this.backoffMs = BACKOFF_MIN_MS
        const ack = msg.payload as ConnectorHelloAck
        if (typeof ack.ownerUserId === 'string' && ack.ownerUserId && this.opts.onOwner) {
          try { this.opts.onOwner(ack.ownerUserId) } catch { /* the trust store must not break the connection */ }
        }
        if (ack.updateRequired) {
          // Stay connected (so the hosted UI shows "update required" rather
          // than offline) and keep the heartbeat; the relay refuses traffic.
          this.opts.onStatus?.('update_required', `needs ${ack.updateRequired.minimum} or later: ${ack.updateRequired.reason}`)
        } else {
          this.opts.onStatus?.('connected', ack.displayName)
        }
        this.heartbeat = setInterval(() => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(envelope('ping', {})))
          }
        }, HEARTBEAT_INTERVAL_MS)
        this.heartbeat.unref()
        void this.advertiseSessions(ws)
      } else if (msg.kind === 'request') {
        void this.handleProxyRequest(ws, msg.id, msg.payload as ProxyRequest)
      } else if (msg.kind === 'enrol_commit' || msg.kind === 'enrol_reveal' || msg.kind === 'enrol_status') {
        this.handleEnrolment(ws, msg.kind, msg.id, msg.payload as EnrolRequest)
      } else if (msg.kind === 'stream_open') {
        this.openChannel(ws, msg.channelId, msg.payload as StreamOpen)
      } else if (msg.kind === 'stream_data') {
        if (msg.channelId) {
          const payload = msg.payload as StreamData
          this.channels.get(msg.channelId)?.send(payload.data, payload.intent)
        }
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
    // The signature is checked before anything else looks at the request.
    const verdict = this.opts.intents?.checkRequest(request)
    if (verdict && !verdict.forward) {
      this.opts.onProxy?.(request.method, request.path, verdict.reason ?? RELAY_ERROR.notPermitted)
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(envelope('error', intentError(verdict), { id })))
      return
    }
    // A forwarded GitHub delivery is accepted once, and only while fresh
    // (connector-webhook-guard.ts): the signature alone does not stop a relay
    // from sending a delivery it saw again.
    let deliveryId: string | null = null
    if (request.principal?.role === 'webhook') {
      const body = request.body ? Buffer.from(request.body, 'base64') : undefined
      const verdict = this.webhookGuard.check(request.headers, body)
      if (!verdict.ok) {
        this.opts.onProxy?.(request.method, request.path, RELAY_ERROR.notPermitted)
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(envelope('error', { code: RELAY_ERROR.notPermitted, message: verdict.reason }, { id })))
        }
        return
      }
      deliveryId = verdict.deliveryId
    }
    const outcome = await executeProxyRequest(request, {
      target: this.localTarget,
      fetchImpl: this.opts.fetchImpl,
    })
    if (deliveryId && 'response' in outcome && outcome.response.status >= 200 && outcome.response.status < 300) {
      this.webhookGuard.record(deliveryId)
    }
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
   * Answer one enrolment frame from this machine's own state. Refusals go
   * back as `error` frames; nothing here reaches the local server.
   */
  private handleEnrolment(ws: WebSocket, kind: string, id: string | undefined, request: EnrolRequest | undefined): void {
    if (!id || ws.readyState !== WebSocket.OPEN) return
    if (!this.opts.enrolment) {
      ws.send(JSON.stringify(envelope('error', { code: RELAY_ERROR.enrolUnavailable, message: 'This computer cannot confirm browsers' }, { id })))
      return
    }
    try {
      const reply = this.opts.enrolment.handle(kind, request?.principal, request?.payload)
      ws.send(JSON.stringify(envelope(reply.kind, reply.payload, { id })))
    } catch (err) {
      const code = err instanceof EnrolmentError ? err.code : RELAY_ERROR.enrolUnavailable
      const message = err instanceof EnrolmentError || err instanceof TrustStoreError ? err.message : 'Enrolment failed on this computer'
      if (!(err instanceof EnrolmentError)) console.warn(`[connector] enrolment ${kind} failed: ${err instanceof Error ? err.message : String(err)}`)
      ws.send(JSON.stringify(envelope('error', { code, message }, { id })))
    }
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
    // A webhook principal never streams: deliveries are one request each.
    if (!principal || principal.role === 'webhook') {
      ws.send(
        JSON.stringify(
          envelope('error', { code: RELAY_ERROR.forbidden, message: 'Channel carried no principal' }, { channelId }),
        ),
      )
      return
    }
    const intents = this.opts.intents
    const opened = intents?.checkChannelOpen(principal, open.intent)
    if (opened && !opened.forward) {
      ws.send(JSON.stringify(envelope('error', intentError(opened), { channelId })))
      return
    }
    const policy: ChannelPolicy = {
      role: principal.role === 'owner' ? 'owner' : 'grantee',
      grants: principal.grants as GrantMap,
      userId: principal.userId,
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
        onDenied: (reason, permission, refusal) => {
          this.opts.onStream?.('denied', channelId, refusal?.detail ?? reason)
          send('error', { code: RELAY_ERROR.notPermitted, message: reason, permission, ...refusal })
        },
      },
      this.opts.socketFactory,
      policy,
      intents ? (frame, intent, channelSession) => intents.checkFrame(principal, frame, intent, channelSession) : undefined,
    )

    this.channels.set(channelId, channel)
    channel.open()
  }

  private closeChannel(channelId: string | undefined, payload?: StreamClose): void {
    if (!channelId) return
    const channel = this.channels.get(channelId)
    if (!channel) return
    this.channels.delete(channelId)
    const reason = payload?.reason ?? 'browser closed the channel'
    this.opts.onStream?.('close', channelId, `relay: ${reason}`)
    channel.close(payload?.code ?? STREAM_CLOSE.normal, reason)
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
