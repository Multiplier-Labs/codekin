/**
 * Local connector: runs on a developer machine, holds an outbound
 * WebSocket to the hosted relay hub, keeps the machine marked online,
 * serves proxied REST requests, and bridges session streams to the local
 * Codekin server.
 */

import WebSocket from 'ws'
import { asProxyRequest, asStreamClose, asStreamData, asStreamOpen, isRecord } from './connector-frames.js'
import { ENROLMENT_FEATURE, envelope, INTENTS_FEATURE, isEnrolRequestKind, parseEnvelope, RELAY_ERROR, STREAM_CLOSE } from './relay-protocol.js'
import type {
  ConnectorHello,
  EnrolRequest,
  RelayPrincipal,
  ConnectorHelloAck,
  ProxyRequest,
  RelayError,
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

/**
 * The channel policy for a principal. A grantee acts on what the relay says
 * AND the owner signed (spec §6.7), re-read while the channel is open (on any
 * device-list change, and every frame for expiry): a revoked or expired
 * grant stops what the grantee receives, not just what they send.
 */
export function liveChannelPolicy(
  principal: RelayPrincipal,
  intents?: Partial<Pick<IntentVerifier, 'effectivePrincipal' | 'grantsVersion'>>,
): ChannelPolicy {
  const grantsOf = (): GrantMap => (intents?.effectivePrincipal?.(principal) ?? principal).grants as GrantMap
  return {
    role: principal.role === 'owner' ? 'owner' : 'grantee',
    get grants(): GrantMap {
      // Verification already caches signatures. Re-evaluate authority on
      // every use so the signed expiry is an exact deadline for output too.
      return grantsOf()
    },
    userId: principal.userId,
  }
}

/** The relay error for a refused intent (signed-intents spec §6.4, "Refusals"). */
function intentError(verdict: IntentDecision): RelayError {
  return {
    code: RELAY_ERROR.notPermitted,
    message: describeIntentRefusal(verdict.reason),
    detail: verdict.reason ?? 'intent_required',
    ...(verdict.nonce ? { intentNonce: verdict.nonce } : {}),
    ...(verdict.machineTime !== undefined ? { machineTime: verdict.machineTime } : {}),
    ...(verdict.machineTimeSig ? { machineTimeSig: verdict.machineTimeSig } : {}),
    ...(verdict.stepUpPasskeys ? { stepUpPasskeys: verdict.stepUpPasskeys } : {}),
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
  /** How often to look for a policy change to report (tests shorten it). */
  policyWatchMs?: number
  /** Checks signed intents on everything the relay delivers (intent-verify.ts). */
  intents?: Pick<IntentVerifier, 'checkRequest' | 'checkChannelOpen' | 'checkFrame'>
    & Partial<Pick<IntentVerifier, 'setRequirePasskey' | 'effectivePrincipal' | 'grantsVersion' | 'policy'>>
}

export type ConnectorStatus =
  | 'connecting'
  | 'connected'
  /** Connected, but the relay refuses traffic until this connector is updated. */
  | 'update_required'
  /** Connected, but the workspace refuses traffic until a browser is confirmed on this machine (§6.8). */
  | 'devices_unconfirmed'
  | 'auth_failed'
  | 'disconnected'
  | 'reconnect_scheduled'
  | 'replaced'
  | 'stopped'

const HEARTBEAT_INTERVAL_MS = 30_000
/** How often the connector looks for a policy change to report (the CLI may change it from another process). */
const POLICY_WATCH_MS = 5_000
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
  private policyWatch: ReturnType<typeof setInterval> | null = null
  private reportedPolicy: string | null = null
  /** From hello_ack: the relay refuses this connector until it is updated. */
  private updateRequired = false
  private displayName: string | null = null
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
    if (this.policyWatch) { clearInterval(this.policyWatch); this.policyWatch = null }
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
      const policy = this.currentPolicy()
      if (policy) hello.intentPolicy = policy
      this.reportedPolicy = policy
      ws.send(JSON.stringify(envelope('hello', hello)))
    })

    ws.on('message', (data: Buffer | string) => {
      // The relay may send anything (signed-intents spec §2): one bad frame
      // is logged and dropped, never allowed to take the connector down.
      try {
        this.handleMessage(ws, data)
      } catch (err) {
        console.warn(`[connector] dropped a relay frame: ${err instanceof Error ? err.message : String(err)}`)
      }
    })

    ws.on('close', (code: number, reason: Buffer) => {
      this.onSocketClose(code, reason)
    })

    ws.on('error', () => {
      // close follows; reconnect is handled there
    })
  }

  private handleMessage(ws: WebSocket, data: Buffer | string): void {
    const msg = parseEnvelope(typeof data === 'string' ? data : data.toString('utf-8'))
    if (!msg) return
    if (msg.kind === 'hello_ack') {
      this.backoffMs = BACKOFF_MIN_MS
      const ack = (isRecord(msg.payload) ? msg.payload : {}) as Partial<ConnectorHelloAck>
      this.updateRequired = !!ack.updateRequired
      this.displayName = typeof ack.displayName === 'string' ? ack.displayName : null
      // The workspace's "Privileged actions need a passkey" (spec §6.6).
      this.opts.intents?.setRequirePasskey?.(ack.requirePasskeyStepUp === true)
      if (typeof ack.ownerUserId === 'string' && ack.ownerUserId && this.opts.onOwner) {
        try { this.opts.onOwner(ack.ownerUserId) } catch { /* the trust store must not break the connection */ }
      }
      if (isRecord(ack.updateRequired)) {
        // Stay connected (so the hosted UI shows "update required" rather
        // than offline) and keep the heartbeat; the relay refuses traffic.
        this.opts.onStatus?.('update_required', `needs ${ack.updateRequired.minimum} or later: ${ack.updateRequired.reason}`)
      } else if (ack.unconfirmed) {
        this.opts.onStatus?.('devices_unconfirmed', 'the workspace requires confirmed devices: confirm a browser on this computer')
      } else {
        this.opts.onStatus?.('connected', ack.displayName)
      }
      this.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(envelope('ping', {})))
        }
      }, HEARTBEAT_INTERVAL_MS)
      this.heartbeat.unref()
      // Report policy changes (§6.8), so the relay can show them and apply
      // the workspace's "Require confirmed devices". Only to a relay that
      // says it understands the frame: an older one closes the socket on
      // an unknown kind (it still gets the policy in each hello).
      if (ack.policyReports === true) this.policyWatch = setInterval(() => {
        const policy = this.currentPolicy()
        if (!policy || policy === this.reportedPolicy || ws.readyState !== WebSocket.OPEN) return
        this.reportedPolicy = policy
        ws.send(JSON.stringify(envelope('intent_policy', { policy })))
      }, this.opts.policyWatchMs ?? POLICY_WATCH_MS)
      this.policyWatch?.unref()
      void this.advertiseSessions(ws)
    } else if (msg.kind === 'request') {
      const id = typeof msg.id === 'string' ? msg.id : undefined
      const request = asProxyRequest(msg.payload)
      if (!request) {
        if (id) ws.send(JSON.stringify(envelope('error', { code: RELAY_ERROR.badRequest, message: 'Malformed request' }, { id })))
        return
      }
      this.handleProxyRequest(ws, id, request).catch((err: unknown) => {
        console.warn(`[connector] request failed: ${err instanceof Error ? err.message : String(err)}`)
        if (id && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify(envelope('error', { code: RELAY_ERROR.badRequest, message: 'Request failed on this computer' }, { id })))
        }
      })
    } else if (isEnrolRequestKind(msg.kind)) {
      this.handleEnrolment(ws, msg.kind, msg.id, isRecord(msg.payload) ? msg.payload as unknown as EnrolRequest : undefined)
    } else if (msg.kind === 'stream_open') {
      this.openChannel(ws, typeof msg.channelId === 'string' ? msg.channelId : undefined, asStreamOpen(msg.payload))
    } else if (msg.kind === 'stream_data') {
      const payload = asStreamData(msg.payload)
      if (typeof msg.channelId === 'string' && payload) {
        this.channels.get(msg.channelId)?.send(payload.data, payload.intent)
      }
    } else if (msg.kind === 'stream_close') {
      this.closeChannel(typeof msg.channelId === 'string' ? msg.channelId : undefined, msg.payload)
    } else if (msg.kind === 'event' && !msg.channelId) {
      // A workspace policy change while connected (connector-hub announceWorkspacePolicy).
      const policy = (isRecord(msg.payload) ? msg.payload : {}) as { requirePasskeyStepUp?: unknown; unconfirmed?: unknown }
      if (typeof policy.requirePasskeyStepUp === 'boolean') this.opts.intents?.setRequirePasskey?.(policy.requirePasskeyStepUp)
      // The workspace refuses this machine until it requires confirmed
      // devices (§6.8), or no longer does. An update requirement outranks both.
      if (!this.updateRequired && policy.unconfirmed === true) {
        this.opts.onStatus?.('devices_unconfirmed', 'the workspace requires confirmed devices: confirm a browser on this computer')
      } else if (!this.updateRequired && policy.unconfirmed === false) {
        this.opts.onStatus?.('connected', this.displayName ?? undefined)
      }
    } else if (msg.kind === 'error') {
      const err = (isRecord(msg.payload) ? msg.payload : {}) as Partial<RelayError>
      this.opts.onStatus?.('disconnected', `${String(err.code)}: ${String(err.message)}`)
    }
  }

  private onSocketClose(code: number, reason: Buffer): void {
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
    // A grantee acts on what the relay says AND the owner signed (spec §6.7).
    const effective = this.opts.intents?.effectivePrincipal?.(request.principal)
    const outcome = await executeProxyRequest(effective && effective !== request.principal ? { ...request, principal: effective } : request, {
      target: this.localTarget,
      fetchImpl: this.opts.fetchImpl,
    })
    if (deliveryId) {
      // Accepted: remember it. Refused, or never reached the server: let a
      // genuine (re)delivery through. A timeout may have been processed, so
      // its claim stays.
      if ('response' in outcome && outcome.response.status >= 200 && outcome.response.status < 300) this.webhookGuard.record(deliveryId)
      else if ('response' in outcome || outcome.error.detail !== 'timeout') this.webhookGuard.release(deliveryId)
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


  /** The machine's intent policy, or null when it can't be read (or this connector checks no intents). */
  private currentPolicy(): 'off' | 'warn' | 'required' | null {
    try {
      return this.opts.intents?.policy?.() ?? null
    } catch {
      return null
    }
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
    if (opened && !opened.decision.forward) {
      ws.send(JSON.stringify(envelope('error', intentError(opened.decision), { channelId })))
      return
    }
    const policy = liveChannelPolicy(principal, intents)

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
      intents && opened ? (frame, intent) => intents.checkFrame(principal, frame, intent, opened.channel) : undefined,
    )

    this.channels.set(channelId, channel)
    channel.open()
  }

  private closeChannel(channelId: string | undefined, payload: unknown): void {
    if (!channelId) return
    const channel = this.channels.get(channelId)
    if (!channel) return
    this.channels.delete(channelId)
    const { code, reason } = asStreamClose(payload, 'browser closed the channel')
    this.opts.onStream?.('close', channelId, `relay: ${reason}`)
    channel.close(code, reason)
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
