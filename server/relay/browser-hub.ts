/**
 * Browser hub: accepts authenticated WebSocket connections from the hosted
 * frontend at /relay/browser and routes proxied REST requests to the
 * machine the socket is bound to.
 *
 * Authorization happens twice and deliberately: once here, where the socket
 * is bound to a single machine the signed-in user is allowed to reach
 * (owner-only at this stage; shares arrive in the sharing phase), and again
 * on the connector, which decides which local paths it will serve.
 */

import type { WebSocket } from 'ws'
import type Database from 'better-sqlite3'
import { envelope, parseEnvelope, RELAY_ERROR } from './relay-protocol.js'
import type { BrowserHello, ProxyRequest, RelayError } from './relay-protocol.js'
import type { ConnectorHub } from './connector-hub.js'
import type { SessionUser } from './relay-auth-routes.js'
import type { MachineRow } from './control-plane-db.js'

const CLOSE_AUTH_FAILED = 4001
const CLOSE_FORBIDDEN = 4003

/** A browser that hasn't sent hello within this window is dropped. */
const HELLO_TIMEOUT_MS = 5_000

/** Requests a single browser socket may have in flight. */
const MAX_INFLIGHT_PER_SOCKET = 16

interface BrowserClient {
  user: SessionUser
  machineId: string
  socket: WebSocket
  inflight: number
}

/**
 * Whether a user may reach a machine. Owner-only for now: the user who
 * paired the machine. Shares widen this in a later phase.
 */
export function canAccessMachine(user: SessionUser, machine: MachineRow | undefined): boolean {
  if (!machine) return false
  if (user.status !== 'active') return false
  return machine.owner_user_id === user.id
}

export class BrowserHub {
  private clients = new Set<BrowserClient>()

  constructor(
    private db: Database.Database,
    private connectors: ConnectorHub,
  ) {}

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
        const machine = this.db
          .prepare('SELECT * FROM machines WHERE id = ?')
          .get(hello.machineId) as MachineRow | undefined
        if (!canAccessMachine(user, machine)) {
          socket.close(CLOSE_FORBIDDEN, 'no access to this machine')
          return
        }

        client = { user, machineId: machine!.id, socket, inflight: 0 }
        this.clients.add(client)
        socket.send(
          JSON.stringify(
            envelope('hello_ack', {
              machineId: machine!.id,
              displayName: machine!.display_name,
              online: this.connectors.isOnline(machine!.id),
            }),
          ),
        )
        return
      }

      if (msg.kind === 'ping') {
        socket.send(JSON.stringify(envelope('pong', {})))
        return
      }
      if (msg.kind === 'request') {
        void this.forwardRequest(client, msg.id, msg.payload as ProxyRequest)
      }
      // stream envelopes arrive in the session-streaming phase
    })

    socket.on('close', () => {
      clearTimeout(helloTimeout)
      if (client) this.clients.delete(client)
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
      // Only method/path/body cross the hub — the connector supplies the
      // local credentials, so browser-sent headers are dropped here.
      const outcome = await this.connectors.sendRequest(client.machineId, {
        method: request.method,
        path: request.path,
        body: request.body,
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

  private sendError(socket: WebSocket, id: string, error: RelayError): void {
    if (socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(envelope('error', error, { id })))
  }

  /** Disconnect every browser socket (shutdown / tests). */
  close(): void {
    for (const client of this.clients) {
      client.socket.close(1001, 'server shutting down')
    }
    this.clients.clear()
  }
}
