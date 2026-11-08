/**
 * Relay wire protocol (spec §7): JSON envelopes over WebSocket, shared by
 * the hub, the connector, and the browser client.
 */

import type { SignedGrant, SignedIntent } from './intent-actions.js'

export const RELAY_PROTOCOL_VERSION = 1

export type RelayEnvelopeKind =
  | 'hello'
  | 'hello_ack'
  | 'request'
  | 'response'
  | 'stream_open'
  | 'stream_data'
  | 'stream_close'
  | 'event'
  /** Connector → hub: the machine's intent policy changed (§6.8). */
  | 'intent_policy'
  | 'error'
  | 'ping'
  | 'pong'
  /** Enrolment ceremony (signed-intents spec §5.2): browser → connector… */
  | 'enrol_commit'
  | 'enrol_reveal'
  | 'enrol_status'
  | 'enrol_certify'
  | 'enrol_revoke'
  | 'enrol_grant_revoke'
  | 'enrol_time'
  | 'enrol_policy'
  /** …and connector → browser, each answering one request by id. */
  | 'enrol_challenge'
  | 'enrol_result'

export interface RelayEnvelope<T = unknown> {
  version: typeof RELAY_PROTOCOL_VERSION
  /** Correlates request/response pairs. */
  id?: string
  /** Identifies long-lived streams (proxied Codekin WebSocket sessions). */
  channelId?: string
  kind: RelayEnvelopeKind
  payload: T
}

/**
 * A machine's live session counts, re-advertised on every (re)connect so the
 * hub's view survives a relay restart without waiting for a browser to ask
 * (spec §11.3).
 */
export interface LocalSessionSummary {
  total: number
  active: number
}

/** Connector → hub, first message on the socket. */
export interface ConnectorHello {
  machineId: string
  machineSecret: string
  connectorVersion: string
  localCodekinVersion?: string
  capabilities: {
    restProxy: boolean
    wsProxy: boolean
    fileUpload: boolean
    providers: string[]
    /**
     * Security features this connector enforces (`ConnectorCapability`). The
     * relay believes a claim only at or above that feature's version floor.
     */
    features?: string[]
  }
  /** Omitted when the local server could not be reached at connect time. */
  sessions?: LocalSessionSummary
  /**
   * The machine identity public key (base64url SPKI, P-256), from
   * relay-identity.json. The relay keeps it as a hint for browsers; they
   * trust only the key they pin during enrolment.
   */
  identityKey?: string
  /**
   * The machine's intent policy (signed-intents spec §6.8), resent as an
   * `intent_policy` frame whenever it changes. A report about the machine's
   * own enforcement: a forged one only weakens that owner's own machine.
   */
  intentPolicy?: 'off' | 'warn' | 'required'
}

/** Hub → connector on successful auth. */
export interface ConnectorHelloAck {
  machineId: string
  displayName: string
  /**
   * Present when the relay won't serve this connector until it is updated.
   * The socket stays open; every request and channel is refused with
   * `connector_update_required`.
   */
  updateRequired?: { minimum: string; missing: string[]; reason: string }
  /**
   * The relay user who owns this machine. Machines paired before
   * pair/complete returned it record it in their trust store from here.
   */
  ownerUserId?: string
  /** The workspace requires a passkey for privileged actions (signed-intents spec §6.6). */
  requirePasskeyStepUp?: boolean
  /**
   * The workspace requires confirmed devices and this machine doesn't yet
   * (§6.8): requests and channels are refused, enrolment still works.
   */
  unconfirmed?: boolean
  /** The relay accepts `intent_policy` frames (§6.8); older relays close the socket on them. */
  policyReports?: boolean
}

/** Browser → hub, first message on a /relay/browser socket. */
export interface BrowserHello {
  /** Machine whose local Codekin server this socket proxies to. */
  machineId: string
  clientVersion?: string
}

/** Hub → browser on successful auth + ACL check. */
export interface BrowserHelloAck {
  machineId: string
  displayName: string
  online: boolean
}

/**
 * The caller's standing on a machine, attached by the hub to everything it
 * forwards. The connector re-checks against this rather than trusting that
 * the hub filtered correctly (spec §5.2).
 */
export interface RelayPrincipal {
  userId: string
  /**
   * `webhook` is a GitHub delivery the relay received for this machine
   * (docs/SELF-HOSTED-RELAY.md, "GitHub webhooks"). It reaches exactly one
   * local route, and the local server checks GitHub's HMAC signature, which
   * the relay cannot produce. `userId` is then the machine owner.
   */
  role: 'owner' | 'grantee' | 'webhook'
  /** Session id → permissions. Empty for owners. */
  grants: Record<string, string[]>
  /**
   * Grantees: the owner-signed grants behind `grants` (signed-intents spec
   * §6.7). The machine uses the intersection of these and `grants`, and the
   * grantee's own frames must be signed by a key a grant names.
   */
  signedGrants?: SignedGrant[]
}

/**
 * A proxied REST call. Travels browser → hub → connector; the hub attaches
 * the principal from the socket's binding, so a client cannot claim
 * permissions it was not granted.
 */
export interface ProxyRequest {
  method: string
  /** Local server path including query string, e.g. '/api/sessions/list?x=1'. */
  path: string
  /** Who is asking. Absent only from legacy frames, which are refused. */
  principal?: RelayPrincipal
  /**
   * Content type of `body`. This is the only browser-supplied header that
   * crosses the relay — everything else (notably Authorization) is the
   * connector's to set, so a browser cannot forge local credentials.
   */
  contentType?: string
  /** base64-encoded request body, omitted when there is none. */
  body?: string
  /** The browser's signed intent for this request (signed-intents spec §6.3). */
  intent?: SignedIntent
  /**
   * GitHub delivery headers, honoured only for `webhook` principals and only
   * those named in WEBHOOK_FORWARDED_HEADERS.
   */
  headers?: Record<string, string>
}

/** The one local route a `webhook` principal may reach. */
export const WEBHOOK_LOCAL_PATH = '/api/webhooks/github'

/** Request headers the connector passes to the local webhook route. */
export const WEBHOOK_FORWARDED_HEADERS = ['x-github-event', 'x-github-delivery', 'x-hub-signature-256'] as const

export interface ProxyResponse {
  status: number
  headers: Record<string, string>
  /** base64-encoded response body, omitted when empty. */
  body?: string
}

/**
 * Open a proxied session-stream channel: the connector opens the local
 * Codekin WebSocket, performs the local `auth` handshake with its own
 * token, and pipes frames opaquely from then on.
 *
 * Channel ids are scoped to the socket that created them; the hub maps a
 * browser's id onto a hub-generated id before it reaches a connector, so
 * ids from one browser can never name another's channel.
 */
export interface StreamOpen {
  /** Who the channel belongs to, so the connector can police its frames. */
  principal?: RelayPrincipal
  /** The browser's signed `channel:open` intent (signed-intents spec §6.3). */
  intent?: SignedIntent
}

/** Connector → browser once the local socket is open and authenticated. */
export interface StreamReady {
  status: 'open'
}

/** One frame in either direction, passed through without interpretation. */
export interface StreamData {
  /** The local Codekin protocol frame, verbatim JSON text. */
  data: string
  /** The browser's signed intent for this frame (browser → machine only). */
  intent?: SignedIntent
}

export interface StreamClose {
  code?: number
  reason?: string
}

export interface RelayError {
  code: string
  message: string
  /** For intent refusals: which check failed (an `intent_*` reason). */
  detail?: string
  /** For intent refusals: the refused intent's nonce, so the browser can match it. */
  intentNonce?: string
  /** For `intent_stale`: the machine's clock, so the browser can correct its own (§6.5). */
  machineTime?: number
  /** For `intent_stale`: the machine key's signature over (intentNonce, machineTime). */
  machineTimeSig?: string
  /** For `intent_step_up_required`: the passkeys this machine accepts for the signer. */
  stepUpPasskeys?: Array<{ credentialId: string; keyId: string }>
}

/** Error codes used on the request/response and stream paths (spec §7.4). */
export const RELAY_ERROR = {
  machineOffline: 'machine_offline',
  forbidden: 'forbidden',
  pathNotAllowed: 'path_not_allowed',
  timeout: 'timeout',
  bodyTooLarge: 'body_too_large',
  badRequest: 'bad_request',
  localUnreachable: 'local_unreachable',
  localUnauthorized: 'local_unauthorized',
  tooManyChannels: 'too_many_channels',
  unknownChannel: 'unknown_channel',
  notPermitted: 'not_permitted',
  connectorUpdateRequired: 'connector_update_required',
  /**
   * The workspace requires confirmed devices and this machine doesn't yet
   * (§6.8): confirm a browser on it. Updating Codekin won't help.
   */
  devicesUnconfirmed: 'devices_unconfirmed',
  /** The machine turned an enrolment request down (bad proof, not the owner, too many pending). */
  enrolRefused: 'enrol_refused',
  /** The machine can't enrol right now (no identity key, owner unknown, device list unreadable). */
  enrolUnavailable: 'enrol_unavailable',
} as const

/** Browser → connector enrolment frames, and the connector's replies. */
export const ENROL_REQUEST_KINDS = ['enrol_commit', 'enrol_reveal', 'enrol_status', 'enrol_certify', 'enrol_revoke', 'enrol_grant_revoke', 'enrol_time', 'enrol_policy'] as const
export type EnrolRequestKind = (typeof ENROL_REQUEST_KINDS)[number]

export function isEnrolRequestKind(kind: string): kind is EnrolRequestKind {
  return (ENROL_REQUEST_KINDS as readonly string[]).includes(kind)
}
export const ENROL_REPLY_KINDS = ['enrol_challenge', 'enrol_result'] as const
export type EnrolReplyKind = (typeof ENROL_REPLY_KINDS)[number]

/** Advertised by connectors that verify signed intents (in `capabilities.features`). */
export const INTENTS_FEATURE = 'intents'

/**
 * A connector advertises this in `capabilities.features` when it answers
 * enrol_* frames. It is protocol support, not a security claim, so it has no
 * version floor; the hub only uses it to answer old connectors at once
 * instead of letting the request time out.
 */
export const ENROLMENT_FEATURE = 'enrolment'

/** What the hub forwards to the connector: the browser's payload plus who sent it. */
export interface EnrolRequest {
  principal: RelayPrincipal
  payload: unknown
}

/** Close codes on proxied stream channels, mirroring the local server's conventions. */
export const STREAM_CLOSE = {
  /** The local server rejected the connector's credential. */
  localAuthFailed: 4001,
  /** The machine went offline while the channel was open. */
  machineGone: 4002,
  normal: 1000,
} as const

/** Channels a single browser socket may hold open at once. */
export const MAX_CHANNELS_PER_CLIENT = 4

/** Max size of a proxied request or response body, before base64 expansion. */
export const MAX_PROXY_BODY_BYTES = 8 * 1024 * 1024

/** A proxied request unanswered for this long is failed with `timeout`. */
export const PROXY_REQUEST_TIMEOUT_MS = 30_000

export function envelope<T>(kind: RelayEnvelopeKind, payload: T, extra?: Partial<RelayEnvelope<T>>): RelayEnvelope<T> {
  return { version: RELAY_PROTOCOL_VERSION, kind, payload, ...extra }
}

/** Parse an incoming frame; returns null on malformed input. */
export function parseEnvelope(data: unknown): RelayEnvelope | null {
  try {
    const raw = typeof data === 'string' ? data : String(data)
    const msg = JSON.parse(raw) as { version?: unknown; kind?: unknown }
    if (msg.version !== (RELAY_PROTOCOL_VERSION as number) || typeof msg.kind !== 'string') return null
    return msg as RelayEnvelope
  } catch {
    return null
  }
}
