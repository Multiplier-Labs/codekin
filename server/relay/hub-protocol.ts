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
const base = { version: z.literal(1), id: id.optional(), channelId: id.optional() }
const frame = <K extends string, S extends z.ZodType>(kind: K, payload: S) => z.object({ ...base, kind: z.literal(kind), payload })
const streamData = frame('stream_data', z.object({ data: z.string().max(MAX_PROXY_BODY_BYTES) })).extend({ channelId: id })
const streamClose = frame('stream_close', z.object({
  // Close codes are ultimately passed to ws.close(), which rejects reserved values.
  code: z.number().int().refine(n => (n >= 1000 && n <= 1014 && ![1004, 1005, 1006].includes(n)) || (n >= 3000 && n <= 4999)).optional(),
  reason: z.string().refine(s => Buffer.byteLength(s) <= 123).optional(),
})).extend({ channelId: id })

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
  })),
  frame('response', z.object({
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string().max(200), text).refine(h => Object.keys(h).length <= 100), body,
  })).extend({ id }),
  frame('error', z.object({ code: z.string().max(100), message: text })),
  frame('event', z.object({ sessions: summary.optional(), status: version.optional() })),
  streamData, streamClose, frame('ping', empty), frame('pong', empty),
])

const browser = z.discriminatedUnion('kind', [
  frame('hello', z.object({ machineId: id, clientVersion: version.optional() })),
  frame('request', z.object({ method: z.string().min(1).max(32), path: text, contentType: z.string().max(1024).optional(), body })).extend({ id }),
  frame('stream_open', empty).extend({ channelId: id }),
  streamData, streamClose, frame('ping', empty), frame('pong', empty),
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
