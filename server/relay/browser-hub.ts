/**
 * Browser hub: accepts authenticated WebSocket connections from the hosted
 * frontend at /relay/browser and routes proxied REST requests and session
 * streams to the machine the socket is bound to.
 *
 * Authorization happens twice and deliberately: once here, where the socket
 * is bound to a machine the signed-in user owns or holds a share on, and
 * again on the connector, which re-derives what that user may do from the
 * principal attached to every forwarded frame.
 */

import { randomUUID } from 'crypto'
import { onHubMessage, parseHubEnvelope } from './hub-protocol.js'
import type { WebSocket } from 'ws'
import type Database from 'better-sqlite3'
import {
  envelope,
  MAX_CHANNELS_PER_CLIENT,
  RELAY_ERROR,
  STREAM_CLOSE,
} from './relay-protocol.js'
import type {
  BrowserHello,
  ProxyRequest,
  ProxyResponse,
  RelayError,
  RelayPrincipal,
  StreamClose,
  StreamData,
} from './relay-protocol.js'
import type { ConnectorHub } from './connector-hub.js'
import type { SessionUser } from './relay-auth-routes.js'
import { getUserById } from './control-plane-db.js'
import { resolveMachineAccess } from './shares.js'
import type { MachineAccess } from './shares.js'
import { recordAuditEvent } from './audit.js'
import { checkRestPolicy, isServerFrameVisible } from './connector-policy.js'
import { BROWSER_FRAME_LIMIT, RateLimiter, isBackedUp } from './rate-limit.js'
import { checkQuota, UNLIMITED } from './quotas.js'
import { meterFrame } from './usage-meter.js'
import { classifyBrowserFrame, classifyRestRequest, payloadHash, sessionFromMachineFrame } from './session-audit.js'
import type { SessionAuditEvent } from './session-audit.js'
import type { UsageMeter } from './usage-meter.js'
import type { EntitlementsProvider } from './quotas.js'

const CLOSE_AUTH_FAILED = 4001
const CLOSE_FORBIDDEN = 4003
/** Sent when a client exceeds its frame budget or stops draining its socket. */
const CLOSE_OVERLOADED = 4029
/** Over a quota (browser connections per user). The client doesn't retry. */
const CLOSE_QUOTA = 4030

/** A browser that hasn't sent hello within this window is dropped. */
const HELLO_TIMEOUT_MS = 5_000

/** How often every connected client's standing is re-checked against the DB. */
const REAUTHORIZE_INTERVAL_MS = 5_000

/**
 * How often every browser socket is pinged. A socket that has not answered
 * the previous ping by the next sweep is terminated. Without this, a tab
 * that vanished without a close handshake (laptop asleep, phone off wifi)
 * keeps its channels — and the machine's channel budget — until the proxy
 * in front of the relay gives up on it, which can be a day.
 */
const HEARTBEAT_INTERVAL_MS = 30_000

/** Requests a single browser socket may have in flight. */
const MAX_INFLIGHT_PER_SOCKET = 16

interface BrowserClient {
  user: SessionUser
  /** Web session that authorized the upgrade; the socket lives no longer than it. */
  sessionId: string | null
  machineId: string
  /** The machine's workspace, whose quota limits apply to this socket. */
  workspaceId: string
  socket: WebSocket
  inflight: number
  /** Standing on this machine, resolved at hello time. */
  access: MachineAccess
  /**
   * Channel ids are namespaced per client: the browser names its channel,
   * the hub gives the connector a fresh id. One browser can therefore never
   * name — or hijack — another's channel.
   */
  channels: Map<string, string>
  /** The session each channel joined or created (local channel id → session id), for the audit log. */
  channelSessions: Map<string, string>
  /** Whether the socket has shown any sign of life since the last heartbeat sweep. */
  alive: boolean
}

/**
 * A stable string for "the standing this socket holds", used to tell a real
 * authorization change from a re-read that resolved to the same answer.
 *
 * Comparing the objects by `JSON.stringify` would fold key order into the
 * result: the grant map is built by iterating shares ordered on a
 * second-granularity timestamp, so two shares created in the same second have
 * no guaranteed order, and a reshuffle would read as a permission change and
 * close a socket that nothing had happened to — every five seconds, forever.
 * Sorting both the session ids and each permission list makes the comparison
 * depend on the grant itself and nothing else.
 */
export function accessFingerprint(access: MachineAccess): string {
  if (access.kind !== 'grantee') return access.kind
  const grants = Object.keys(access.grants)
    .sort()
    .map(sessionId => [sessionId, [...access.grants[sessionId]].sort()] as const)
  return JSON.stringify(['grantee', grants])
}

/**
 * The principal sent to the connector with every forwarded frame. Grants are
 * resolved fresh per socket, so revoking a share takes effect on the next
 * connection rather than living on in a cached token.
 */
function toPrincipal(user: SessionUser, access: MachineAccess): RelayPrincipal {
  return {
    userId: user.id,
    role: access.kind === 'owner' ? 'owner' : 'grantee',
    grants: access.kind === 'grantee' ? access.grants : {},
  }
}

export interface BrowserHubOptions {
  /** Whether a web session still exists and is unexpired (SqliteSessionStore.isAlive). */
  isSessionAlive?: (sessionId: string) => boolean
  /** Override the heartbeat period (tests). */
  heartbeatIntervalMs?: number
  /** Quota limits (docs/RELAY-HARDENING.md §6); unlimited when absent. */
  entitlements?: EntitlementsProvider
  /** Counts relayed traffic and throttles a workspace over its daily bytes. */
  meter?: UsageMeter
}

export class BrowserHub {
  private clients = new Set<BrowserClient>()
  /** Per-user frame budget: one browser cannot flood a machine (spec §11.5). */
  private frameLimiter = new RateLimiter(BROWSER_FRAME_LIMIT)
  private reauthorizeTimer: ReturnType<typeof setInterval>
  private heartbeatTimer: ReturnType<typeof setInterval>

  constructor(
    private db: Database.Database,
    private connectors: ConnectorHub,
    private options: BrowserHubOptions = {},
  ) {
    this.reauthorizeTimer = setInterval(() => { this.reauthorize(); }, REAUTHORIZE_INTERVAL_MS)
    this.reauthorizeTimer.unref()
    this.heartbeatTimer = setInterval(() => { this.heartbeat(); }, options.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS)
    this.heartbeatTimer.unref()
  }

  /**
   * Terminate sockets that did not answer the last ping, then ping the rest.
   * Browsers answer protocol pings on their own, so a live tab needs no
   * client-side code for this. Termination runs the normal close path, which
   * releases the socket's channels on the machine.
   */
  private heartbeat(): void {
    for (const client of this.clients) {
      if (!client.alive) {
        console.log(
          `[relay] browser socket unresponsive; dropping it and its ${client.channels.size} channel(s) on machine ${client.machineId}`,
        )
        client.socket.terminate()
        continue
      }
      client.alive = false
      client.socket.ping()
    }
  }

  /**
   * Re-resolve the standing of every matching client and drop those whose
   * access changed. Access is otherwise resolved once at hello and would live
   * as long as the tab: revoking a share, removing a machine, or disabling a
   * user must not leave an already-open socket working from yesterday's
   * answer. Revocation endpoints call this directly for the affected user or
   * machine; the periodic sweep catches changes made straight in the DB.
   *
   * A client whose access merely changed shape (share permissions edited) is
   * also dropped: its open channels carry the old principal, and a reconnect
   * re-derives everything.
   */
  reauthorize(filter: { userId?: string; machineId?: string } = {}): void {
    for (const client of [...this.clients]) {
      if (filter.userId && client.user.id !== filter.userId) continue
      if (filter.machineId && client.machineId !== filter.machineId) continue
      if (client.sessionId && this.options.isSessionAlive && !this.options.isSessionAlive(client.sessionId)) {
        this.revoke(client, 'session ended')
        continue
      }
      const row = getUserById(this.db, client.user.id)
      const access = row
        ? resolveMachineAccess(this.db, row, client.machineId)
        : ({ kind: 'none' } as const)
      if (accessFingerprint(access) === accessFingerprint(client.access)) continue
      if (access.kind === 'none') {
        recordAuditEvent(this.db, {
          kind: 'access_denied',
          actorUserId: client.user.id,
          machineId: client.machineId,
          metadata: { stage: 'reauthorize' },
        })
      }
      this.revoke(client, 'authorization changed')
    }
  }

  /**
   * Stop serving a client now. It leaves the client set before the close
   * handshake starts, so frames still in flight from the browser are ignored
   * rather than forwarded while the socket winds down.
   */
  private revoke(client: BrowserClient, reason: string): void {
    if (!this.clients.delete(client)) return
    for (const remoteId of client.channels.values()) {
      this.connectors.closeChannel(client.machineId, remoteId, STREAM_CLOSE.normal, reason)
    }
    client.channels.clear()
    client.socket.close(CLOSE_FORBIDDEN, reason)
  }

  /**
   * Close every live browser socket for a user (global logout/revocation),
   * optionally sparing those of one web session.
   */
  disconnectUser(userId: string, reason = 'access revoked', exceptSessionId?: string): void {
    for (const client of [...this.clients]) {
      if (client.user.id !== userId) continue
      if (exceptSessionId !== undefined && client.sessionId === exceptSessionId) continue
      this.revoke(client, reason)
    }
  }

  /** Close the sockets opened under one web session (logout). */
  disconnectSession(sessionId: string, reason = 'logged out'): void {
    for (const client of [...this.clients]) {
      if (client.sessionId === sessionId) this.revoke(client, reason)
    }
  }

  /** Number of connected browser sockets (for tests / health). */
  get clientCount(): number {
    return this.clients.size
  }

  private get entitlements(): EntitlementsProvider {
    return this.options.entitlements ?? UNLIMITED
  }

  /** Sum `measure` over one user's sockets, on every machine. */
  private countUser(userId: string, measure: (client: BrowserClient) => number): number {
    let total = 0
    for (const c of this.clients) if (c.user.id === userId) total += measure(c)
    return total
  }

  /** Wire up a fresh /relay/browser socket for an already-authenticated user. */
  handleConnection(socket: WebSocket, user: SessionUser, sessionId: string | null = null): void {
    let client: BrowserClient | null = null

    const helloTimeout = setTimeout(() => {
      socket.close(CLOSE_AUTH_FAILED, 'hello timeout')
    }, HELLO_TIMEOUT_MS)

    socket.on('pong', () => {
      if (client) client.alive = true
    })

    onHubMessage(socket, data => {
      if (client) client.alive = true
      const msg = parseHubEnvelope(data.toString(), 'browser')
      if (!msg) {
        socket.close(1008, 'invalid relay frame')
        return
      }

      if (client === null) {
        clearTimeout(helloTimeout)
        if (msg.kind !== 'hello') {
          socket.close(CLOSE_AUTH_FAILED, 'hello expected')
          return
        }
        const hello = msg.payload as Partial<BrowserHello>
        if (typeof hello.machineId !== 'string') {
          socket.close(CLOSE_AUTH_FAILED, 'machineId required')
          return
        }
        const machineId = hello.machineId
        const access = resolveMachineAccess(this.db, user, machineId)
        if (access.kind === 'none') {
          recordAuditEvent(this.db, {
            kind: 'access_denied',
            actorUserId: user.id,
            machineId,
            metadata: { stage: 'connect' },
          })
          socket.close(CLOSE_FORBIDDEN, 'no access to this machine')
          return
        }
        const machine = this.db
          .prepare('SELECT display_name, workspace_id FROM machines WHERE id = ?')
          .get(machineId) as { display_name: string; workspace_id: string }

        const socketQuota = checkQuota(this.entitlements, machine.workspace_id, 'browserSocketsPerUser', () =>
          this.countUser(user.id, () => 1))
        if (socketQuota) {
          socket.close(CLOSE_QUOTA, `quota_exceeded:${socketQuota.quota}:${socketQuota.limit}`)
          return
        }

        client = {
          user, sessionId, machineId, workspaceId: machine.workspace_id, socket, inflight: 0, access,
          channels: new Map(), channelSessions: new Map(), alive: true,
        }
        this.clients.add(client)
        socket.send(
          JSON.stringify(
            envelope('hello_ack', {
              machineId,
              displayName: machine.display_name,
              online: this.connectors.isOnline(machineId),
              role: access.kind,
              grants: access.kind === 'grantee' ? access.grants : undefined,
            }),
          ),
        )
        return
      }

      // Revoked (logout, access change): nothing more is served on this socket.
      if (!this.clients.has(client)) return

      // Past hello, every frame costs the user a token.
      if (!this.frameLimiter.tryConsume(client.user.id)) {
        socket.close(CLOSE_OVERLOADED, 'frame rate limit exceeded')
        return
      }
      meterFrame(this.options.meter, socket, client.workspaceId, 'b2m', data.length)

      if (msg.kind === 'ping') {
        socket.send(JSON.stringify(envelope('pong', {})))
        return
      }
      if (msg.kind === 'request') {
        return this.forwardRequest(client, msg.id, msg.payload as ProxyRequest)
      } else if (msg.kind === 'stream_open') {
        this.openChannel(client, msg.channelId)
      } else if (msg.kind === 'stream_data') {
        this.forwardChannelData(client, msg.channelId, msg.payload as StreamData)
      } else if (msg.kind === 'stream_close') {
        this.closeChannel(client, msg.channelId, msg.payload as StreamClose)
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimeout)
      if (!client) return
      for (const localId of [...client.channels.keys()]) {
        this.closeChannel(client, localId, { reason: 'browser disconnected' })
      }
      this.clients.delete(client)
    })

    socket.on('error', () => {
      // close follows; nothing to do
    })
  }

  private async forwardRequest(client: BrowserClient, id: string | undefined, request: ProxyRequest): Promise<void> {
    if (!id) return
    if (typeof request?.method !== 'string' || typeof request?.path !== 'string') {
      this.sendError(client.socket, id, {
        code: RELAY_ERROR.badRequest,
        message: 'method and path are required',
      })
      return
    }
    if (client.inflight >= MAX_INFLIGHT_PER_SOCKET) {
      this.sendError(client.socket, id, {
        code: RELAY_ERROR.badRequest,
        message: 'Too many requests in flight',
      })
      return
    }

    // The connector enforces this too; checking here as well means a machine
    // running an older connector is still protected by the hosted service.
    if (client.access.kind === 'grantee') {
      const permitted = checkRestPolicy({ role: 'grantee', grants: client.access.grants }, request.method, request.path)
      if (!permitted.allowed) {
        this.sendError(client.socket, id, {
          code: RELAY_ERROR.notPermitted,
          message: permitted.reason ?? 'Not permitted',
        })
        return
      }
    }

    client.inflight += 1
    try {
      // Only method/path/body/contentType cross the hub — the connector
      // supplies the local credentials, so any other browser-sent header is
      // dropped here rather than forwarded.
      const outcome = await this.connectors.sendRequest(client.machineId, {
        method: request.method,
        path: request.path,
        contentType: typeof request.contentType === 'string' ? request.contentType : undefined,
        body: request.body,
        principal: toPrincipal(client.user, client.access),
      })
      if (!this.clients.has(client) || client.socket.readyState !== client.socket.OPEN) return
      if ('error' in outcome) {
        this.sendError(client.socket, id, outcome.error)
      } else {
        client.socket.send(JSON.stringify(envelope('response', outcome.response, { id })))
        this.auditRestRequest(client, request, outcome.response)
      }
    } finally {
      client.inflight -= 1
    }
  }

  /** Open a session stream for this client on its bound machine. */
  private openChannel(client: BrowserClient, localId: string | undefined): void {
    if (!localId || client.channels.has(localId)) return
    if (client.channels.size >= MAX_CHANNELS_PER_CLIENT) {
      this.sendChannelError(client, localId, {
        code: RELAY_ERROR.tooManyChannels,
        message: 'Too many open sessions on this connection',
      })
      return
    }
    const channelQuota = checkQuota(this.entitlements, client.workspaceId, 'channelsPerUser', () =>
      this.countUser(client.user.id, c => c.channels.size))
    if (channelQuota) {
      this.sendChannelError(client, localId, { code: 'quota_exceeded', message: channelQuota.message })
      return
    }

    const remoteId = randomUUID()
    client.channels.set(localId, remoteId)

    recordAuditEvent(this.db, {
      kind: 'session_viewed',
      actorUserId: client.user.id,
      machineId: client.machineId,
      metadata: { role: client.access.kind },
    })

    const error = this.connectors.openChannel(client.machineId, remoteId, (kind, payload) => {
      if (client.socket.readyState !== client.socket.OPEN) return
      // A browser that stops draining would otherwise grow ws's buffer
      // without bound; drop its channel rather than the hub's memory.
      if (isBackedUp(client.socket)) {
        client.channels.delete(localId)
        this.connectors.closeChannel(client.machineId, remoteId, STREAM_CLOSE.normal, 'client too slow')
        client.socket.send(
          JSON.stringify(
            envelope('stream_close', { code: STREAM_CLOSE.normal, reason: 'client too slow' }, { channelId: localId }),
          ),
        )
        return
      }
      // Same outbound rule the connector applies, repeated here for older
      // connectors: never relay another session's frames to a grantee.
      if (kind === 'stream_data' && client.access.kind === 'grantee' &&
          !isServerFrameVisible(client.access.grants, (payload as StreamData).data)) {
        return
      }
      client.socket.send(JSON.stringify(envelope(kind, payload, { channelId: localId })))
      if (kind === 'stream_data') this.noteMachineFrame(client, localId, (payload as StreamData).data)
      if (kind === 'stream_close') {
        client.channels.delete(localId)
        client.channelSessions.delete(localId)
        this.connectors.closeChannel(client.machineId, remoteId)
      }
    }, toPrincipal(client.user, client.access))

    if (error) {
      console.log(`[relay] stream refused on machine ${client.machineId}: ${error.code} ${error.message}`)
      client.channels.delete(localId)
      this.sendChannelError(client, localId, error)
    }
  }

  private forwardChannelData(client: BrowserClient, localId: string | undefined, payload: StreamData): void {
    if (!localId) return
    const remoteId = client.channels.get(localId)
    if (!remoteId || typeof payload?.data !== 'string') return
    this.connectors.sendChannelData(client.machineId, remoteId, payload.data)
    this.auditBrowserFrame(client, localId, payload.data)
  }

  /** Record what a forwarded browser frame did (no content), and bind channels to sessions. */
  private auditBrowserFrame(client: BrowserClient, localId: string, data: string): void {
    const event = classifyBrowserFrame(data)
    if (!event) return
    if ('join' in event) {
      client.channelSessions.set(localId, event.join)
      return
    }
    this.recordSessionEvent(client, event, client.channelSessions.get(localId) ?? null)
  }

  /** A machine announced the session on a channel: bind it, and audit creations. */
  private noteMachineFrame(client: BrowserClient, localId: string, data: unknown): void {
    if (typeof data !== 'string') return
    const announced = sessionFromMachineFrame(data)
    if (!announced) return
    client.channelSessions.set(localId, announced.sessionId)
    if (announced.created) {
      this.recordSessionEvent(client, { kind: 'session_created', metadata: { via: 'stream' } }, announced.sessionId)
    }
  }

  private recordSessionEvent(client: BrowserClient, event: SessionAuditEvent, sessionId: string | null): void {
    recordAuditEvent(this.db, {
      kind: event.kind,
      actorUserId: client.user.id,
      machineId: client.machineId,
      localSessionId: event.sessionId ?? sessionId,
      metadata: { role: client.access.kind, ...event.metadata },
    })
  }

  /** Audit a forwarded REST call that uploads a file or creates a session (no content). */
  private auditRestRequest(client: BrowserClient, request: ProxyRequest, response: ProxyResponse): void {
    const kind = classifyRestRequest(request.method, request.path)
    if (!kind || response.status < 200 || response.status >= 300) return
    if (kind === 'upload') {
      const body = typeof request.body === 'string' ? Buffer.from(request.body, 'base64') : Buffer.alloc(0)
      this.recordSessionEvent(client, {
        kind: 'file_uploaded',
        metadata: {
          bytes: body.length,
          contentType: typeof request.contentType === 'string' ? request.contentType.split(';')[0].slice(0, 100) : null,
          payloadHash: payloadHash(body),
        },
      }, null)
      return
    }
    let sessionId: string | null = null
    try {
      const parsed = JSON.parse(Buffer.from(response.body ?? '', 'base64').toString('utf-8')) as { sessionId?: unknown }
      if (typeof parsed.sessionId === 'string') sessionId = parsed.sessionId.slice(0, 200)
    } catch {
      // Not JSON: still audit the creation, without the id.
    }
    this.recordSessionEvent(client, { kind: 'session_created', metadata: { via: 'rest' } }, sessionId)
  }

  private closeChannel(client: BrowserClient, localId: string | undefined, payload?: StreamClose): void {
    if (!localId) return
    const remoteId = client.channels.get(localId)
    if (!remoteId) return
    client.channels.delete(localId)
    client.channelSessions.delete(localId)
    this.connectors.closeChannel(
      client.machineId,
      remoteId,
      payload?.code ?? STREAM_CLOSE.normal,
      payload?.reason,
    )
  }

  private sendChannelError(client: BrowserClient, channelId: string, error: RelayError): void {
    if (client.socket.readyState !== client.socket.OPEN) return
    client.socket.send(JSON.stringify(envelope('error', error, { channelId })))
  }

  private sendError(socket: WebSocket, id: string, error: RelayError): void {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(envelope('error', error, { id })))
  }

  /** Disconnect every browser socket (shutdown / tests). */
  close(): void {
    clearInterval(this.reauthorizeTimer)
    clearInterval(this.heartbeatTimer)
    this.frameLimiter.close()
    for (const client of this.clients) {
      for (const remoteId of client.channels.values()) {
        this.connectors.closeChannel(client.machineId, remoteId, STREAM_CLOSE.normal, 'relay shutting down')
      }
      client.channels.clear()
      client.socket.close(1001, 'server shutting down')
    }
    this.clients.clear()
  }
}
