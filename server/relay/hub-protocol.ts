/** Runtime validation for untrusted messages entering either relay hub. */
import { z } from 'zod'
import type { WebSocket } from 'ws'
import { MAX_PROXY_BODY_BYTES, parseEnvelope } from './relay-protocol.js'
import type { RelayEnvelope } from './relay-protocol.js'

const id = z.string().min(1).max(200)
const version = z.string().max(100)
const summary = z.object({ total: z.number().int().nonnegative(), active: z.number().int().nonnegative() })
const body = z.string().max(Math.ceil(MAX_PROXY_BODY_BYTES / 3) * 4).optional()
const text = z.string().max(16 * 1024)
const empty = z.object({})
const b64 = z.string().max(1024).regex(/^[A-Za-z0-9_-]*$/)
// A signed intent (signed-intents spec §6.1). Bounded here; verified on the connector.
const intent = z.object({
  body: z.string().max(4096),
  sig: b64.optional(),
  webauthn: z.object({ credentialId: b64, authenticatorData: b64, clientDataJSON: b64.max(4096), signature: b64 }).optional(),
}).optional()
const passkeyProof = z.object({ credentialId: b64, authenticatorData: b64, clientDataJSON: b64.max(4096), signature: b64 })
const base = { version: z.literal(1), id: id.optional(), channelId: id.optional() }
const frame = <K extends string, S extends z.ZodType>(kind: K, payload: S) => z.object({ ...base, kind: z.literal(kind), payload })
// Stream frames are bounded by the socket's maxPayload (relay-server.ts). A
// tighter cap here would only drop the whole connector at a lower size, e.g.
// on a large session replay, without protecting anything more.
const streamData = frame('stream_data', z.object({ data: z.string(), intent })).extend({ channelId: id })
const streamClose = frame('stream_close', z.object({
  // Close codes are ultimately passed to ws.close(), which rejects reserved values.
  code: z.number().int().refine(n => (n >= 1000 && n <= 1014 && ![1004, 1005, 1006].includes(n)) || (n >= 3000 && n <= 4999)).optional(),
  reason: z.string().refine(s => Buffer.byteLength(s) <= 123).optional(),
})).extend({ channelId: id })
// Connector closes report a local socket's result, including 1005/1006. They
// are forwarded as channel metadata, never passed to ws.close() by the hub.
const connectorStreamClose = streamClose.extend({ payload: z.object({
  code: z.number().int().min(1000).max(4999).optional(),
  reason: text.optional(),
}) })

const connector = z.discriminatedUnion('kind', [
  frame('hello', z.object({
    machineId: id, machineSecret: z.string().min(1).max(1024),
    // Old connectors may omit these; version floors handle that case.
    connectorVersion: version.optional(), localCodekinVersion: version.optional(),
    capabilities: z.object({
      restProxy: z.boolean().optional(), wsProxy: z.boolean().optional(), fileUpload: z.boolean().optional(),
      providers: z.array(version).max(100).optional(), features: z.array(version).max(100).optional(),
    }).optional(),
    sessions: summary.optional(),
    // Validated as a P-256 SPKI where it is stored (connector-hub.ts).
    identityKey: z.string().max(256).optional(),
  })),
  frame('response', z.object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string().max(200), text).refine(h => Object.keys(h).length <= 100), body,
  })).extend({ id }),
  frame('error', z.object({
    code: z.string().max(100), message: text,
    // Channel denials name the missing permission; intent refusals say which
    // check failed (signed-intents spec §6.4) so the browser can react.
    permission: z.string().max(100).optional(), detail: z.string().max(100).optional(),
    intentNonce: z.string().max(100).optional(), machineTime: z.number().optional(), machineTimeSig: b64.optional(),
    stepUpPasskeys: z.array(z.object({ credentialId: b64, keyId: b64 })).max(20).optional(),
  })),
  frame('event', z.object({ sessions: summary.optional(), status: version.optional() })),
  streamData, connectorStreamClose, frame('ping', empty), frame('pong', empty),
  frame('enrol_challenge', z.object({ enrolId: id, machineKey: b64, nonceM: b64, signature: b64 })).extend({ id }),
  frame('enrol_result', z.object({
    enrolId: id, state: z.enum(['awaiting_code', 'approved', 'rejected', 'expired']), keyId: b64.optional(), signature: b64.optional(),
    machineKey: b64.optional(), passkeys: z.array(z.object({ credentialId: b64, keyId: b64 })).max(20).optional(),
  })).extend({ id }),
])

const browser = z.discriminatedUnion('kind', [
  frame('hello', z.object({ machineId: id, clientVersion: version.optional() })),
  frame('request', z.object({ method: z.string().min(1).max(32), path: text, contentType: z.string().max(1024).optional(), body, intent })).extend({ id }),
  frame('stream_open', z.object({ intent })).extend({ channelId: id }),
  streamData, streamClose, frame('ping', empty), frame('pong', empty),
  // Enrolment (signed-intents spec §5.2). Checked for real on the connector;
  // bounded here so nothing oversized reaches it.
  frame('enrol_commit', z.object({ commit: b64 })).extend({ id }),
  frame('enrol_reveal', z.object({
    enrolId: id, spki: b64, label: z.string().max(256), nonceB: b64, pop: b64,
    passkeys: z.array(z.object({ credentialId: b64, cosePublicKey: z.string().max(2048), rpId: z.string().max(253) })).max(3),
    passkeyProofs: z.array(passkeyProof).max(3).optional(),
  })).extend({ id }),
  frame('enrol_status', z.object({ enrolId: id })).extend({ id }),
  frame('enrol_certify', z.object({ spki: b64, label: z.string().max(256), intent })).extend({ id }),
  frame('enrol_revoke', z.object({ keyId: z.string().max(64), intent })).extend({ id }),
  frame('enrol_grant_revoke', z.object({ grantId: id, intent })).extend({ id }),
])

/** Validate fields before any cast, database binding, or socket operation. */
export function parseHubEnvelope(data: string, peer: 'browser' | 'connector'): RelayEnvelope | null {
  const parsed = (peer === 'browser' ? browser : connector).safeParse(parseEnvelope(data))
  return parsed.success ? parsed.data as RelayEnvelope : null
}

/** Contain failures to one peer, including asynchronous request handlers. Never log wire data. */
export function onHubMessage(socket: WebSocket, handle: (data: Buffer) => void | Promise<void>): void {
  const failed = () => {
    console.warn('[relay] socket handler failed; closing connection')
    socket.close(1011, 'relay handler failed')
  }
  socket.on('message', data => {
    if (socket.readyState !== socket.OPEN) return
    try { void Promise.resolve(handle(Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data))).catch(failed) } catch { failed() }
  })
}
