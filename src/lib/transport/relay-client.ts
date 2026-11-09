/**
 * Browser-side client for the relay's /relay/browser WebSocket.
 *
 * One connection is bound to one machine (the hub enforces this at hello
 * time) and multiplexes proxied REST calls over it by envelope id. The
 * session cookie authenticates the upgrade, so nothing auth-related travels
 * in the URL or in application frames.
 */

import {
  CHANNEL_OPEN_ACTION, channelOpenPayload, channelSessionAfter, frameAction, frameNeedsStepUp, framePayload, frameSession, isExemptFrame,
  requestAction, requestNeedsStepUp, requestPayload, requestSession, requestStepUpReason, frameStepUpReason,
} from '../../../server/relay/intent-actions'
import type { StepUpReason } from '../../../server/relay/intent-actions'

export const RELAY_PROTOCOL_VERSION = 1

export interface RelayProxyResponse {
  status: number
  headers: Record<string, string>
  body?: string
}

export interface RelayErrorPayload {
  code: string
  message: string
  /** For intent refusals: which check failed (an `intent_*` reason). */
  detail?: string
}

/** Thrown by `request()` when the relay or the machine refuses the call. */
export class RelayRequestError extends Error {
  readonly code: string
  /** For intent refusals: which check failed (`intent_stale`, …). */
  readonly detail?: string
  /** For `intent_stale`: the machine's clock. */
  readonly machineTime?: number
  /** For `intent_stale`: the machine key's signature over (intentNonce, machineTime). */
  readonly machineTimeSig?: string
  /** For intent refusals: the refused intent's nonce. */
  readonly intentNonce?: string
  /** For `intent_step_up_required`: the passkeys the machine accepts. */
  readonly stepUpPasskeys?: Array<{ credentialId: string; keyId: string }>

  constructor(code: string, message: string, extra: {
    detail?: string; machineTime?: number; machineTimeSig?: string; intentNonce?: string
    stepUpPasskeys?: Array<{ credentialId: string; keyId: string }>
  } = {}) {
    super(message)
    this.name = 'RelayRequestError'
    this.code = code
    if (extra.detail !== undefined) this.detail = extra.detail
    if (extra.machineTime !== undefined) this.machineTime = extra.machineTime
    if (extra.machineTimeSig !== undefined) this.machineTimeSig = extra.machineTimeSig
    if (extra.intentNonce !== undefined) this.intentNonce = extra.intentNonce
    if (extra.stepUpPasskeys !== undefined) this.stepUpPasskeys = extra.stepUpPasskeys
  }
}

/**
 * Signs messages to the machine (src/hosted/intentSigner.ts). Resolves null
 * when this browser isn't confirmed on the machine; the message then goes
 * unsigned.
 */
export interface RelaySigner {
  sign(intent: IntentInput): Promise<unknown>
  setClockOffset(ms: number): void
  /** Whether the machine's own key signed this time (so the relay didn't make it up). */
  verifyMachineTime(nonce: string, machineTime: number, sig: string): Promise<boolean>
  /** Remember the passkeys a machine named when it asked for step-up. */
  learnPasskeys?(passkeys: Array<{ credentialId: string; keyId: string }>): Promise<void>
  /** The user's standing on the machine (hello_ack): grantees sign with their own key. */
  setRole?(role: 'owner' | 'grantee'): void
}

interface IntentInput {
  action: string
  sessionId: string | null
  payload: Uint8Array
  channel?: string
  seq?: number
  nonce?: string
  ts?: number
  stepUp?: boolean
  stepUpReason?: StepUpReason
}

/** One channel's signing state: the token its signed open fixed, the next seq, and its session. */
interface SignedChannel {
  token: string
  seq: number
  session: string | null
  /** Closed by the app; frames still being signed are sent, then the close. */
  closing: boolean
}

function channelToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  let binary = ''
  for (const b of bytes) binary += String.fromCharCode(b)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function intentNonce(intent: unknown): string | undefined {
  try {
    const nonce = (JSON.parse((intent as { body: string }).body) as { nonce?: unknown }).nonce
    return typeof nonce === 'string' ? nonce : undefined
  } catch {
    return undefined
  }
}

function base64Bytes(body: string | undefined): Uint8Array | null {
  return body ? decodeBody(body) : null
}

export type RelayConnectionState = 'connecting' | 'open' | 'closed'

interface Pending {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** The envelope kind that answers this request. */
  expects: string
}

/** Enrolment frames (signed-intents spec §5.2) and the reply each expects. */
export type EnrolKind = 'enrol_commit' | 'enrol_reveal' | 'enrol_status' | 'enrol_certify' | 'enrol_revoke' | 'enrol_grant_revoke' | 'enrol_time' | 'enrol_policy'
const ENROL_REPLY: Record<EnrolKind, string> = {
  enrol_commit: 'enrol_challenge',
  enrol_reveal: 'enrol_result',
  enrol_status: 'enrol_result',
  enrol_certify: 'enrol_result',
  enrol_revoke: 'enrol_result',
  enrol_grant_revoke: 'enrol_result',
  enrol_time: 'enrol_result',
  enrol_policy: 'enrol_result',
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

/**
 * How long a resumed page waits for the relay to answer a liveness ping.
 * Mobile browsers freeze a locked tab and its socket can come back looking
 * OPEN while the TCP connection behind it is gone; without a probe the app
 * would sit on that dead socket until the OS noticed, often minutes later.
 */
const RESUME_PROBE_TIMEOUT_MS = 2_500

/** Close code the hub uses when the user may not reach the machine. */
const CLOSE_FORBIDDEN = 4003
/** Over a relay quota (browser connections per user); see server/relay/browser-hub.ts. */
const CLOSE_QUOTA = 4030

export interface RelayConnectionOptions {
  machineId: string
  /** Override the socket URL (tests). Defaults to the current origin. */
  url?: string
  onStateChange?: (state: RelayConnectionState, detail?: string) => void
  /** Called when the machine's online flag arrives with hello_ack. */
  onMachineStatus?: (online: boolean, displayName: string) => void
  /** Signs every request, channel open and frame (signed-intents spec §6.3). */
  signer?: RelaySigner
}

export function browserRelayUrl(machineId: string): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/relay/browser?machine=${encodeURIComponent(machineId)}`
}

export class RelayConnection {
  private ws: WebSocket | null = null
  private pending = new Map<string, Pending>()
  private channels = new Map<string, ChannelHandlers>()
  /** Per-channel send order while frames are being signed. */
  private chains = new Map<string, Promise<void>>()
  /** Signing state per channel (token, seq, session), when signing. */
  private signedChannels = new Map<string, SignedChannel>()
  /** Set once the machine has told us its time; the relay's guess no longer applies. */
  private machineClockKnown = false
  private queued: (() => void)[] = []
  private backoffMs = BACKOFF_MIN_MS
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false
  private nextId = 1
  private state: RelayConnectionState = 'closed'
  private opts: RelayConnectionOptions
  private probeTimer: ReturnType<typeof setTimeout> | null = null
  private lifecycleBound = false

  constructor(opts: RelayConnectionOptions) {
    this.opts = opts
  }

  get connectionState(): RelayConnectionState {
    return this.state
  }

  connect(): void {
    if (this.ws || this.closedByUs) return
    this.bindLifecycle()
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

    ws.onmessage = event => {
      // Any frame proves the socket is alive.
      this.clearProbe()
      this.handleMessage(event.data as string)
    }

    ws.onclose = event => {
      if (this.ws !== ws) return // already dropped by a failed probe
      this.ws = null
      this.clearProbe()
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
      if (event.code === CLOSE_QUOTA) {
        // Over the per-user connection limit: retrying only hits it again
        // until another tab closes.
        this.closedByUs = true
        this.setState('closed', 'too many open connections — close another Codekin tab or window, then reload')
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
    this.unbindLifecycle()
    this.clearProbe()
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
   * Re-establish the connection after the page was backgrounded or the
   * network came back. A pending backoff is skipped (the outage that caused
   * it is likely over), and an apparently open socket is probed so a dead one
   * is replaced within seconds rather than when the OS gives up on it.
   */
  resume(): void {
    if (this.closedByUs) return
    if (!this.ws) {
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = null
      }
      this.backoffMs = BACKOFF_MIN_MS
      this.connect()
      return
    }
    if (this.ws.readyState !== WebSocket.OPEN || this.state !== 'open' || this.probeTimer) return
    const ws = this.ws
    this.probeTimer = setTimeout(() => {
      this.probeTimer = null
      if (this.ws === ws) this.dropDeadSocket(ws)
    }, RESUME_PROBE_TIMEOUT_MS)
    try {
      ws.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, kind: 'ping', payload: {} }))
    } catch {
      this.clearProbe()
      this.dropDeadSocket(ws)
    }
  }

  /**
   * Abandon a socket that stopped answering and reconnect at once. Its own
   * close event may arrive much later (or never), so it is detached first.
   */
  private dropDeadSocket(ws: WebSocket): void {
    ws.onopen = null
    ws.onmessage = null
    ws.onclose = null
    try { ws.close(4000, 'unresponsive') } catch { /* already closing */ }
    this.ws = null
    this.failAllPending(new RelayRequestError('disconnected', 'Relay connection lost'))
    this.failAllChannels('relay connection lost')
    this.setState('closed', 'unresponsive')
    this.backoffMs = BACKOFF_MIN_MS
    this.connect()
  }

  private clearProbe(): void {
    if (this.probeTimer) {
      clearTimeout(this.probeTimer)
      this.probeTimer = null
    }
  }

  private readonly onPageResume = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    this.resume()
  }

  private bindLifecycle(): void {
    if (this.lifecycleBound || typeof window === 'undefined') return
    this.lifecycleBound = true
    document.addEventListener('visibilitychange', this.onPageResume)
    window.addEventListener('online', this.onPageResume)
    // iOS restores pages from the back/forward cache without a visibility change.
    window.addEventListener('pageshow', this.onPageResume)
  }

  private unbindLifecycle(): void {
    if (!this.lifecycleBound) return
    this.lifecycleBound = false
    document.removeEventListener('visibilitychange', this.onPageResume)
    window.removeEventListener('online', this.onPageResume)
    window.removeEventListener('pageshow', this.onPageResume)
  }

  /**
   * Issue a proxied REST call. Requests made before the socket is ready are
   * queued rather than rejected, so callers need not await connection.
   */
  request(method: string, path: string, body?: string, contentType?: string): Promise<RelayProxyResponse> {
    const signer = this.opts.signer
    if (!signer) return this.call('request', 'response', { method, path, body, contentType }) as Promise<RelayProxyResponse>
    let nonce: string | undefined
    let signedAt: number | undefined
    const started = performance.now()
    const bytes = base64Bytes(body)
    const stepUp = requestNeedsStepUp(method, path, bytes)
    const stepUpReason = stepUp ? requestStepUpReason(method, path, bytes) : null
    const signAndSend = async () => {
      const intent = await this.signSafely({
        action: requestAction(method, path),
        sessionId: requestSession(path),
        payload: requestPayload(method, path, contentType, bytes),
        ...(nonce ? { nonce } : {}),
        ...(signedAt !== undefined ? { ts: signedAt } : {}),
        ...(stepUp ? { stepUp } : {}),
        ...(stepUpReason ? { stepUpReason } : {}),
      })
      nonce ??= intent ? intentNonce(intent) : undefined
      if (signedAt === undefined && intent) {
        try {
          const { ts } = JSON.parse((intent as { body: string }).body) as { ts?: unknown }
          if (typeof ts === 'number' && Number.isFinite(ts)) signedAt = ts
        } catch { /* malformed signing results cannot be retried */ }
      }
      return this.call('request', 'response', { method, path, body, contentType, ...(intent ? { intent } : {}) }) as Promise<RelayProxyResponse>
    }
    return signAndSend().catch(async (err: unknown) => {
      // A machine whose clock disagrees says so once; adopt its time and retry
      // (§6.5) with the same nonce. If the first attempt actually ran and the
      // "stale" reply was forged, the machine refuses the retry as a replay;
      // and the time is only adopted when the machine's key signed it.
      if (nonce && signedAt !== undefined && performance.now() - started < 60_000 && err instanceof RelayRequestError && err.detail === 'intent_stale' && err.intentNonce === nonce && await this.adoptMachineTime(err)) {
        // Use exactly the authenticated time, never a fresh browser time.
        // A bounded retry lifetime keeps it inside nonce retention even
        // when the first attempt ran and its reply was withheld.
        signedAt = err.machineTime
        return signAndSend()
      }
      // Refusals arrive through an untrusted relay. Only retry an action we
      // independently classified as privileged, with the SAME operation
      // nonce. The machine deduplicates across this user's signing keys.
      if (stepUp && nonce && signedAt !== undefined && performance.now() - started < 60_000 && err instanceof RelayRequestError && err.detail === 'intent_step_up_required' && err.stepUpPasskeys?.length && signer.learnPasskeys) {
        await signer.learnPasskeys(err.stepUpPasskeys)
        return signAndSend()
      }
      throw err
    })
  }

  /**
   * Adopt the machine's clock from a stale refusal, if its key signed it. From
   * then on the relay's hello_ack guess no longer applies.
   */
  private async adoptMachineTime(err: { machineTime?: number; machineTimeSig?: string; intentNonce?: string }): Promise<boolean> {
    const signer = this.opts.signer
    if (!signer || err.machineTime === undefined || !err.machineTimeSig || !err.intentNonce) return false
    if (!await signer.verifyMachineTime(err.intentNonce, err.machineTime, err.machineTimeSig)) return false
    this.machineClockKnown = true
    signer.setClockOffset(err.machineTime - Date.now())
    return true
  }

  /** Never lets a signing failure lose a message: it goes unsigned instead. */
  private async signSafely(intent: IntentInput): Promise<unknown> {
    try {
      return await this.opts.signer?.sign(intent) ?? null
    } catch {
      return null
    }
  }

  /** Signing is async; each channel's frames go out in the order they were sent (§6.3). */
  private inOrder(channelId: string, step: () => Promise<void>): void {
    const prev = this.chains.get(channelId) ?? Promise.resolve()
    this.chains.set(channelId, prev.then(step).catch(() => {}))
  }

  /**
   * Send one enrolment frame to the machine and resolve with its reply
   * payload. A refusal rejects with a RelayRequestError carrying the
   * machine's code (`enrol_refused`, `enrol_unavailable`, …).
   */
  enrol(kind: EnrolKind, payload: unknown): Promise<unknown> {
    return this.call(kind, ENROL_REPLY[kind], payload)
  }

  private call(kind: string, expects: string, payload: unknown): Promise<unknown> {
    return new Promise<unknown>((resolve, reject) => {
      const id = String(this.nextId++)
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new RelayRequestError('timeout', 'The relay did not respond in time'))
      }, REQUEST_TIMEOUT_MS)

      this.pending.set(id, { resolve, reject, timer, expects })

      const send = () => {
        this.ws?.send(JSON.stringify({ version: RELAY_PROTOCOL_VERSION, kind, id, payload }))
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
    if (!this.opts.signer) {
      this.sendOrQueue({ kind: 'stream_open', channelId, payload: {} })
      return
    }
    const state: SignedChannel = { token: channelToken(), seq: 0, session: null, closing: false }
    this.signedChannels.set(channelId, state)
    this.inOrder(channelId, async () => {
      const intent = await this.signSafely({ action: CHANNEL_OPEN_ACTION, sessionId: null, payload: channelOpenPayload(), channel: state.token })
      if (!this.channels.has(channelId) && !state.closing) return
      this.sendOrQueue({ kind: 'stream_open', channelId, payload: intent ? { intent } : {} })
    })
  }

  /** Relay a frame onto an open channel. */
  sendChannelData(channelId: string, data: string): void {
    if (!this.channels.has(channelId)) return
    if (!this.opts.signer) {
      this.sendOrQueue({ kind: 'stream_data', channelId, payload: { data } })
      return
    }
    const state = this.signedChannels.get(channelId)
    if (!state) return
    // Session and position are fixed now, in send order, the same way the
    // machine tracks them (intent-actions.ts), even though signing finishes later.
    const exempt = isExemptFrame(data)
    const stepUpReason = exempt ? null : frameStepUpReason(data)
    const seq = exempt ? undefined : ++state.seq
    const before = state.session
    state.session = channelSessionAfter(data, before, seq)
    this.inOrder(channelId, async () => {
      const intent = exempt ? null : await this.signSafely({
        action: frameAction(data), sessionId: frameSession(data, before), payload: framePayload(data), channel: state.token, seq,
        ...(frameNeedsStepUp(data) ? { stepUp: true, ...(stepUpReason ? { stepUpReason } : {}) } : {}),
      })
      this.sendOrQueue({ kind: 'stream_data', channelId, payload: intent ? { data, intent } : { data } })
    })
  }

  /** Close a channel; its handlers stop firing immediately. */
  closeChannel(channelId: string, code?: number, reason?: string): void {
    if (!this.channels.delete(channelId)) return
    const state = this.signedChannels.get(channelId)
    if (!state) {
      this.sendOrQueue({ kind: 'stream_close', channelId, payload: { code, reason } })
      return
    }
    // Frames already being signed still go out, then the close.
    state.closing = true
    this.inOrder(channelId, () => {
      this.sendOrQueue({ kind: 'stream_close', channelId, payload: { code, reason } })
      this.forgetChannel(channelId)
      return Promise.resolve()
    })
  }

  private forgetChannel(channelId: string): void {
    this.chains.delete(channelId)
    this.signedChannels.delete(channelId)
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
      const ack = msg.payload as { online?: boolean; displayName?: string; serverTime?: unknown; role?: unknown }
      if (ack.role === 'owner' || ack.role === 'grantee') this.opts.signer?.setRole?.(ack.role)
      // A first guess at the clock offset, until the machine has given its own.
      if (typeof ack.serverTime === 'number' && !this.machineClockKnown) this.opts.signer?.setClockOffset(ack.serverTime - Date.now())
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
      const err = msg.payload as Partial<RelayErrorPayload> & { detail?: unknown; machineTime?: unknown; machineTimeSig?: unknown; intentNonce?: unknown; stepUpPasskeys?: unknown }
      entry.reject(new RelayRequestError(err.code ?? 'relay_error', err.message ?? 'Relay error', {
        ...(Array.isArray(err.stepUpPasskeys) ? { stepUpPasskeys: err.stepUpPasskeys as Array<{ credentialId: string; keyId: string }> } : {}),
        ...(typeof err.detail === 'string' ? { detail: err.detail } : {}),
        ...(typeof err.machineTime === 'number' ? { machineTime: err.machineTime } : {}),
        ...(typeof err.machineTimeSig === 'string' ? { machineTimeSig: err.machineTimeSig } : {}),
        ...(typeof err.intentNonce === 'string' ? { intentNonce: err.intentNonce } : {}),
      }))
      return
    }
    if (msg.kind === entry.expects) {
      entry.resolve(msg.payload)
    } else {
      entry.reject(new RelayRequestError('relay_error', `Unexpected ${msg.kind ?? 'frame'} from the relay`))
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
      this.forgetChannel(channelId)
      handlers.onClose(close.code ?? 1000, close.reason ?? 'closed')
      return
    }
    if (kind === 'error') {
      const err = payload as Partial<RelayErrorPayload> & { detail?: unknown; machineTime?: unknown; machineTimeSig?: unknown; intentNonce?: unknown }
      const error: RelayErrorPayload = {
        code: err.code ?? 'relay_error',
        message: err.message ?? 'Relay error',
        ...(typeof err.detail === 'string' ? { detail: err.detail } : {}),
      }
      // A step-up refusal names the passkey to use next time.
      if (err.detail === 'intent_step_up_required' && Array.isArray((err as { stepUpPasskeys?: unknown }).stepUpPasskeys)) {
        void this.opts.signer?.learnPasskeys?.((err as { stepUpPasskeys: Array<{ credentialId: string; keyId: string }> }).stepUpPasskeys)
      }
      // A stale-clock refusal closes this channel; fix the clock for the next one.
      if (err.detail === 'intent_stale' && typeof err.machineTime === 'number') {
        void this.adoptMachineTime({
          machineTime: err.machineTime,
          ...(typeof err.machineTimeSig === 'string' ? { machineTimeSig: err.machineTimeSig } : {}),
          ...(typeof err.intentNonce === 'string' ? { intentNonce: err.intentNonce } : {}),
        })
      }
      this.forgetChannel(channelId)
      this.channels.delete(channelId)
      handlers.onError(error)
      handlers.onClose(CLOSE_RELAY_GONE, error.message)
    }
  }

  private failAllChannels(reason: string): void {
    this.chains.clear()
    this.signedChannels.clear()
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
