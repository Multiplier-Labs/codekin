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
import { safeCloseCode, safeCloseReason } from './connector-frames.js'
import type { LocalServerTarget } from './connector-proxy.js'
import { adaptServerFrame, checkClientFrame, checkServerFrame, hasPermission, newChannelState, observeServerFrame, stampReviewIdentity } from './connector-policy.js'
import type { ChannelPolicy, ChannelState } from './connector-policy.js'
import type { IntentDecision } from './intent-verify.js'
import type { IntentRefusal } from './intent-actions.js'

const INTENT_REFUSAL_TEXT: Record<IntentRefusal, string> = {
  intent_required: 'This computer only accepts actions signed by a browser confirmed on it',
  intent_malformed: 'The signed action could not be read',
  intent_unknown_key: 'This browser is not confirmed on this computer',
  intent_wrong_signer: 'The signed action came from another account',
  intent_bad_signature: 'The signature on this action is not valid',
  intent_wrong_machine: 'The signed action was meant for another computer',
  intent_wrong_action: 'The signed action does not match what arrived',
  intent_wrong_payload: 'The signed action does not match what arrived',
  intent_wrong_session: 'The signed action was meant for another session',
  intent_stale: "The signed action is too old, or this browser's clock is off",
  intent_replayed: 'This signed action was already used',
  intent_replay_unavailable: 'Replay protection is recovering or its storage is unavailable. After upgrading, wait ten minutes; otherwise check this computer’s storage.',
  intent_unsupported: 'This computer cannot check this kind of signature yet',
  intent_wrong_channel: 'The signed action was meant for another connection',
  intent_out_of_order: 'The signed action arrived out of order',
  intent_rate_limited: 'Too many signed actions at once; slow down',
  intent_step_up_required: 'This action needs your passkey (Face ID, Touch ID or your security key)',
}

/** A sentence for the browser to show for an intent refusal. */
export function describeIntentRefusal(reason: IntentRefusal | undefined): string {
  return INTENT_REFUSAL_TEXT[reason ?? 'intent_required']
}

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
  onDenied?: (reason: string, permission?: string, refusal?: IntentRefusalInfo) => void
}

/** What an intent refusal adds to the error the browser gets. */
export interface IntentRefusalInfo {
  detail: string
  intentNonce?: string
  machineTime?: number
  machineTimeSig?: string
  stepUpPasskeys?: Array<{ credentialId: string; keyId: string }>
}

/**
 * Checks a client frame's signed intent before the channel policy sees it
 * (connector.ts wires in IntentVerifier.checkFrame with this channel's state).
 */
export type FrameGate = (frame: string, intent: unknown) => IntentDecision

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

/** What the local server answers a ping with. */
const PONG = JSON.stringify({ type: 'pong' })

/**
 * Frames a second forwarded to the local socket. The local server allows 60
 * in a fixed window; a sliding window of 50 keeps every one of its windows
 * under that, whatever the alignment.
 */
export const LOCAL_FRAMES_PER_SECOND = 50

/** At most `limit` events in any `windowMs`. */
export class SlidingBudget {
  private times: number[] = []
  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}
  allow(): boolean {
    const t = this.now()
    while (this.times.length > 0 && t - this.times[0] >= this.windowMs) this.times.shift()
    if (this.times.length >= this.limit) return false
    this.times.push(t)
    return true
  }
}

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
  private budget = new SlidingBudget(LOCAL_FRAMES_PER_SECOND, 1000)

  constructor(
    private target: LocalServerTarget,
    private callbacks: StreamChannelCallbacks,
    private createSocket: WebSocketFactory = (url, options) => new WebSocket(url, options),
    /** Owner by default: an unshared channel belongs to the machine's owner. */
    private policy: ChannelPolicy = { role: 'owner', grants: {} },
    private gate?: FrameGate,
    /** Asked before session output is relayed: a reason ends the channel (a removed device). */
    private ended?: () => string | null,
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
      if (this.closed) return
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
      // The local server fans some frames out to every socket, including
      // this one; a grantee only sees what their grant covers.
      if (this.policy.role === 'grantee' && this.state.sessionId
        && !hasPermission(this.policy, this.state.sessionId, 'view')) {
        this.close(STREAM_CLOSE.normal, 'Session access ended')
        this.callbacks.onClose(STREAM_CLOSE.normal, 'Session access ended')
        return
      }
      const endedBecause = this.ended?.()
      if (endedBecause) {
        this.close(STREAM_CLOSE.normal, endedBecause)
        this.callbacks.onClose(STREAM_CLOSE.normal, endedBecause)
        return
      }
      if (!checkServerFrame(this.policy, this.state, text)) return
      // Remember what the server asked, so an approval answer can be
      // classified against the tool it belongs to. Only frames that passed
      // the check above are tracked, so prompts stay bound to this session.
      observeServerFrame(this.state, text)
      this.callbacks.onData(adaptServerFrame(this.policy, text))
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
  send(data: string, intent?: unknown): void {
    if (this.closed) return
    const type = this.frameType(data)
    if (type === 'auth') {
      if (this.connectedFrame) this.callbacks.onData(this.connectedFrame)
      return
    }
    // ping and resize carry nothing and need no intent, so they never reach
    // the local server: a relay could otherwise spend the local socket's
    // message budget with them and get a signed frame silently dropped there.
    if (type === 'ping') {
      this.callbacks.onData(PONG)
      return
    }
    if (type === 'resize') return
    // Stay under the local server's limit (60 a second, over which it drops
    // frames silently), and refuse visibly instead: a frame dropped there
    // after its intent was accepted would leave the session tracking wrong.
    if (!this.budget.allow()) {
      this.callbacks.onDenied?.('Too many messages at once', undefined, { detail: 'intent_rate_limited' })
      return
    }

    // The signature first (signed-intents spec §6.4); then the grant.
    if (this.gate) {
      const verdict = this.gate(data, intent)
      if (!verdict.forward) {
        this.callbacks.onDenied?.(describeIntentRefusal(verdict.reason), undefined, {
          detail: verdict.reason ?? 'intent_required',
          ...(verdict.nonce ? { intentNonce: verdict.nonce } : {}),
          ...(verdict.machineTime !== undefined ? { machineTime: verdict.machineTime } : {}),
          ...(verdict.machineTimeSig ? { machineTimeSig: verdict.machineTimeSig } : {}),
          ...(verdict.stepUpPasskeys ? { stepUpPasskeys: verdict.stepUpPasskeys } : {}),
        })
        return
      }
    }

    // The grant is enforced here, on the machine — the hub's own check is
    // not trusted to have been correct or to have happened at all.
    const decision = checkClientFrame(this.policy, this.state, data)
    if (!decision.allowed) {
      this.callbacks.onDenied?.(decision.reason ?? 'Not permitted', decision.permission)
      return
    }

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(stampReviewIdentity(this.policy, data))
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
    // Local close codes and reasons must be valid on the wire, or `ws` throws.
    this.ws?.close(safeCloseCode(code), safeCloseReason(reason, 'closed'))
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
