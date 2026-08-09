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
import type { WebSocket } from 'ws'
import type Database from 'better-sqlite3'
import {
  envelope,
  parseEnvelope,
  MAX_CHANNELS_PER_CLIENT,
  RELAY_ERROR,
  STREAM_CLOSE,
} from './relay-protocol.js'
import type {
  BrowserHello,
  ProxyRequest,
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
import { BROWSER_FRAME_LIMIT, RateLimiter, isBackedUp } from './rate-limit.js'

const CLOSE_AUTH_FAILED = 4001
const CLOSE_FORBIDDEN = 4003
/** Sent when a client exceeds its frame budget or stops draining its socket. */
const CLOSE_OVERLOADED = 4029

/** A browser that hasn't sent hello within this window is dropped. */
const HELLO_TIMEOUT_MS = 5_000

/** How often every connected client's standing is re-checked against the DB. */
const REAUTHORIZE_INTERVAL_MS = 60_000

/** Requests a single browser socket may have in flight. */
const MAX_INFLIGHT_PER_SOCKET = 16

interface BrowserClient {
  user: SessionUser
  machineId: string
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

export class BrowserHub {
  private clients = new Set<BrowserClient>()
  /** Per-user frame budget: one browser cannot flood a machine (spec §11.5). */
  private frameLimiter = new RateLimiter(BROWSER_FRAME_LIMIT)
  private reauthorizeTimer: ReturnType<typeof setInterval>

  constructor(
    private db: Database.Database,
    private connectors: ConnectorHub,
  ) {
    this.reauthorizeTimer = setInterval(() => { this.reauthorize(); }, REAUTHORIZE_INTERVAL_MS)
    this.reauthorizeTimer.unref()
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
      const row = getUserById(this.db, client.user.id)
      const access = row
        ? resolveMachineAccess(this.db, row, client.machineId)
        : ({ kind: 'none' } as const)
      if (JSON.stringify(access) === JSON.stringify(client.access)) continue
      if (access.kind === 'none') {
        recordAuditEvent(this.db, {
          kind: 'access_denied',
          actorUserId: client.user.id,
          machineId: client.machineId,
          metadata: { stage: 'reauthorize' },
        })
      }
      client.socket.close(CLOSE_FORBIDDEN, 'authorization changed')
    }
  }

  /** Number of connected browser sockets (for tests / health). */
  get clientCount(): number {
    return this.clients.size
  }

  /** Wire up a fresh /relay/browser socket for an already-authenticated user. */
  handleConnection(socket: WebSocket, user: SessionUser): void {
    let client: BrowserClient | null = null

    const helloTimeout = setTimeout(() => {
      socket.close(CLOSE_AUTH_FAILED, 'hello timeout')
    }, HELLO_TIMEOUT_MS)

    socket.on('message', (data: Buffer | string) => {
      const msg = parseEnvelope(typeof data === 'string' ? data : data.toString('utf-8'))
      if (!msg) return

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
          .prepare('SELECT display_name FROM machines WHERE id = ?')
          .get(machineId) as { display_name: string }

        client = { user, machineId, socket, inflight: 0, access, channels: new Map() }
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

      // Past hello, every frame costs the user a token.
      if (!this.frameLimiter.tryConsume(client.user.id)) {
        socket.close(CLOSE_OVERLOADED, 'frame rate limit exceeded')
        return
      }

      if (msg.kind === 'ping') {
        socket.send(JSON.stringify(envelope('pong', {})))
        return
      }
      if (msg.kind === 'request') {
        void this.forwardRequest(client, msg.id, msg.payload as ProxyRequest)
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
      if (client.socket.readyState !== client.socket.OPEN) return
      if ('error' in outcome) {
        this.sendError(client.socket, id, outcome.error)
      } else {
        client.socket.send(JSON.stringify(envelope('response', outcome.response, { id })))
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
      client.socket.send(JSON.stringify(envelope(kind, payload, { channelId: localId })))
      if (kind === 'stream_close') {
        client.channels.delete(localId)
        this.connectors.closeChannel(client.machineId, remoteId)
      }
    }, toPrincipal(client.user, client.access))

    if (error) {
      client.channels.delete(localId)
      this.sendChannelError(client, localId, error)
    }
  }

  private forwardChannelData(client: BrowserClient, localId: string | undefined, payload: StreamData): void {
    if (!localId) return
    const remoteId = client.channels.get(localId)
    if (!remoteId || typeof payload?.data !== 'string') return
    this.connectors.sendChannelData(client.machineId, remoteId, payload.data)
  }

  private closeChannel(client: BrowserClient, localId: string | undefined, payload?: StreamClose): void {
    if (!localId) return
    const remoteId = client.channels.get(localId)
    if (!remoteId) return
    client.channels.delete(localId)
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
