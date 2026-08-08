/**
 * Connector hub: accepts outbound WebSocket connections from paired
 * machines at /relay/connector, authenticates the hello envelope against
 * machine credentials, tracks online/offline state in the DB, and routes
 * proxied REST requests to a machine's socket.
 *
 * The hub does no policy of its own on request contents — the browser side
 * decides who may talk to a machine, and the connector decides which paths
 * it will serve.
 */

import { randomUUID } from 'crypto'
import type { WebSocket } from 'ws'
import type Database from 'better-sqlite3'
import { verifyMachineCredential } from './pairing.js'
import {
  envelope,
  parseEnvelope,
  PROXY_REQUEST_TIMEOUT_MS,
  RELAY_ERROR,
  STREAM_CLOSE,
} from './relay-protocol.js'
import type {
  ConnectorHello,
  ProxyRequest,
  ProxyResponse,
  RelayError,
} from './relay-protocol.js'

/** Close codes mirroring the local server's WS conventions. */
const CLOSE_AUTH_FAILED = 4001
const CLOSE_REPLACED = 4009

/** A connector that hasn't sent hello within this window is dropped. */
const HELLO_TIMEOUT_MS = 5_000

/** A connector silent for longer than this is considered dead. */
const IDLE_TIMEOUT_MS = 90_000

/** last_seen_at writes are throttled to at most one per interval. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

/** Cap on requests a single machine may have in flight, to bound hub memory. */
const MAX_PENDING_PER_MACHINE = 64

interface PendingRequest {
  machineId: string
  settle: (outcome: ProxyOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

interface ConnectedMachine {
  machineId: string
  socket: WebSocket
  lastActivity: number
  lastSeenWrite: number
  pending: Set<string>
  channels: Set<string>
}

/** Frames a channel owner receives from the connector side. */
export type ChannelListener = (
  kind: 'event' | 'stream_data' | 'stream_close' | 'error',
  payload: unknown,
) => void

/** What a proxied request resolves to: the machine's response, or a relay error. */
export type ProxyOutcome = { response: ProxyResponse } | { error: RelayError }

export class ConnectorHub {
  private machines = new Map<string, ConnectedMachine>()
  private pending = new Map<string, PendingRequest>()
  private channelListeners = new Map<string, ChannelListener>()
  private idleTimer: ReturnType<typeof setInterval>

  constructor(private db: Database.Database) {
    // Recovering from a restart: nothing is connected yet.
    this.db.prepare(`UPDATE machines SET status = 'offline'`).run()
    this.idleTimer = setInterval(() => { this.dropIdleConnections(); }, IDLE_TIMEOUT_MS / 3)
    this.idleTimer.unref()
  }

  /** Number of currently connected machines (for tests / health). */
  get onlineCount(): number {
    return this.machines.size
  }

  isOnline(machineId: string): boolean {
    return this.machines.has(machineId)
  }

  /** Wire up a fresh /relay/connector socket. */
  handleConnection(socket: WebSocket): void {
    let machineId: string | null = null

    const helloTimeout = setTimeout(() => {
      socket.close(CLOSE_AUTH_FAILED, 'hello timeout')
    }, HELLO_TIMEOUT_MS)

    socket.on('message', (data: Buffer | string) => {
      const msg = parseEnvelope(typeof data === 'string' ? data : data.toString('utf-8'))
      if (!msg) return

      if (machineId === null) {
        if (msg.kind !== 'hello') {
          clearTimeout(helloTimeout)
          socket.close(CLOSE_AUTH_FAILED, 'hello expected')
          return
        }
        const hello = msg.payload as Partial<ConnectorHello>
        if (
          typeof hello.machineId !== 'string' ||
          typeof hello.machineSecret !== 'string' ||
          !verifyMachineCredential(this.db, hello.machineId, hello.machineSecret)
        ) {
          clearTimeout(helloTimeout)
          socket.close(CLOSE_AUTH_FAILED, 'invalid machine credential')
          return
        }
        clearTimeout(helloTimeout)
        machineId = hello.machineId
        this.registerMachine(machineId, socket, hello)
        return
      }

      const machine = this.machines.get(machineId)
      if (machine) {
        machine.lastActivity = Date.now()
        this.touchLastSeen(machine)
      }
      if (msg.kind === 'ping') {
        socket.send(JSON.stringify(envelope('pong', {})))
      } else if (msg.kind === 'response') {
        this.settleResponse(machineId, msg.id, msg.kind, msg.payload)
      } else if (msg.kind === 'error') {
        // An error envelope answers either a request (id) or a channel.
        if (msg.channelId) this.channelListeners.get(msg.channelId)?.(msg.kind, msg.payload)
        else this.settleResponse(machineId, msg.id, msg.kind, msg.payload)
      } else if (msg.kind === 'event' || msg.kind === 'stream_data' || msg.kind === 'stream_close') {
        if (msg.channelId) this.channelListeners.get(msg.channelId)?.(msg.kind, msg.payload)
      }
    })

    socket.on('close', () => {
      clearTimeout(helloTimeout)
      if (machineId !== null && this.machines.get(machineId)?.socket === socket) {
        const machine = this.machines.get(machineId)!
        this.machines.delete(machineId)
        this.failPending(machine, 'connector disconnected')
        this.setStatus(machineId, 'offline')
      }
    })

    socket.on('error', () => {
      // close follows; nothing to do
    })
  }

  /**
   * Send a proxied REST request to a machine and await its response.
   *
   * Never rejects: transport problems come back as a `RelayError` so callers
   * can relay one consistent shape to the browser.
   */
  sendRequest(machineId: string, request: ProxyRequest, timeoutMs = PROXY_REQUEST_TIMEOUT_MS): Promise<ProxyOutcome> {
    const machine = this.machines.get(machineId)
    if (!machine) {
      return Promise.resolve({
        error: { code: RELAY_ERROR.machineOffline, message: 'Machine is not connected' },
      })
    }
    if (machine.pending.size >= MAX_PENDING_PER_MACHINE) {
      return Promise.resolve({
        error: { code: RELAY_ERROR.badRequest, message: 'Too many requests in flight for this machine' },
      })
    }

    const id = randomUUID()
    return new Promise<ProxyOutcome>(resolve => {
      let settled = false
      const settle = (outcome: ProxyOutcome) => {
        if (settled) return
        settled = true
        const entry = this.pending.get(id)
        if (entry) clearTimeout(entry.timer)
        this.pending.delete(id)
        machine.pending.delete(id)
        resolve(outcome)
      }

      const timer = setTimeout(() => {
        settle({ error: { code: RELAY_ERROR.timeout, message: 'Machine did not respond in time' } })
      }, timeoutMs)
      timer.unref?.()

      this.pending.set(id, { machineId, settle, timer })
      machine.pending.add(id)

      try {
        machine.socket.send(JSON.stringify(envelope('request', request, { id })))
      } catch (err) {
        settle({
          error: {
            code: RELAY_ERROR.machineOffline,
            message: `Could not reach machine: ${err instanceof Error ? err.message : String(err)}`,
          },
        })
      }
    })
  }

  /**
   * Open a stream channel on a machine. The caller owns `channelId` and is
   * responsible for closing the channel; frames from the connector arrive on
   * `listener` until then.
   */
  openChannel(machineId: string, channelId: string, listener: ChannelListener): RelayError | null {
    const machine = this.machines.get(machineId)
    if (!machine) return { code: RELAY_ERROR.machineOffline, message: 'Machine is not connected' }

    this.channelListeners.set(channelId, listener)
    machine.channels.add(channelId)
    machine.socket.send(JSON.stringify(envelope('stream_open', {}, { channelId })))
    return null
  }

  /** Relay a browser frame onto an open channel. */
  sendChannelData(machineId: string, channelId: string, data: string): void {
    const machine = this.machines.get(machineId)
    if (!machine || !machine.channels.has(channelId)) return
    machine.socket.send(JSON.stringify(envelope('stream_data', { data }, { channelId })))
  }

  /** Close a channel and stop listening on it. */
  closeChannel(machineId: string, channelId: string, code?: number, reason?: string): void {
    this.channelListeners.delete(channelId)
    const machine = this.machines.get(machineId)
    if (!machine || !machine.channels.delete(channelId)) return
    if (machine.socket.readyState === machine.socket.OPEN) {
      machine.socket.send(JSON.stringify(envelope('stream_close', { code, reason }, { channelId })))
    }
  }

  /** Route a `response`/`error` envelope back to its waiting caller. */
  private settleResponse(machineId: string, id: string | undefined, kind: 'response' | 'error', payload: unknown): void {
    if (!id) return
    const entry = this.pending.get(id)
    // A response for another machine's id means a confused or hostile
    // connector; drop it rather than letting it answer someone else's call.
    if (!entry || entry.machineId !== machineId) return
    if (kind === 'error') {
      const err = payload as Partial<RelayError>
      entry.settle({
        error: {
          code: typeof err.code === 'string' ? err.code : RELAY_ERROR.badRequest,
          message: typeof err.message === 'string' ? err.message : 'Machine reported an error',
        },
      })
      return
    }
    entry.settle({ response: payload as ProxyResponse })
  }

  /** Fail everything riding on a machine that just went away. */
  private failPending(machine: ConnectedMachine, reason: string): void {
    for (const id of [...machine.pending]) {
      this.pending.get(id)?.settle({ error: { code: RELAY_ERROR.machineOffline, message: reason } })
    }
    for (const channelId of [...machine.channels]) {
      machine.channels.delete(channelId)
      const listener = this.channelListeners.get(channelId)
      this.channelListeners.delete(channelId)
      listener?.('stream_close', { code: STREAM_CLOSE.machineGone, reason })
    }
  }

  private registerMachine(machineId: string, socket: WebSocket, hello: Partial<ConnectorHello>): void {
    // A reconnect may race the old socket's close — the new connection wins.
    const existing = this.machines.get(machineId)
    if (existing && existing.socket !== socket) {
      existing.socket.close(CLOSE_REPLACED, 'replaced by new connection')
      this.machines.delete(machineId)
      this.failPending(existing, 'connector reconnected')
    }

    const now = Date.now()
    this.machines.set(machineId, {
      machineId, socket, lastActivity: now, lastSeenWrite: now,
      pending: new Set(), channels: new Set(),
    })

    this.db.prepare(
      `UPDATE machines SET status = 'online', last_seen_at = datetime('now'),
         connector_version = COALESCE(?, connector_version),
         local_codekin_version = COALESCE(?, local_codekin_version)
       WHERE id = ?`,
    ).run(hello.connectorVersion ?? null, hello.localCodekinVersion ?? null, machineId)

    const row = this.db.prepare('SELECT display_name FROM machines WHERE id = ?').get(machineId) as
      | { display_name: string }
      | undefined
    socket.send(
      JSON.stringify(
        envelope('hello_ack', { machineId, displayName: row?.display_name ?? 'Machine' }),
      ),
    )
  }

  private setStatus(machineId: string, status: 'online' | 'offline' | 'degraded'): void {
    this.db.prepare(
      `UPDATE machines SET status = ?, last_seen_at = datetime('now') WHERE id = ?`,
    ).run(status, machineId)
  }

  private touchLastSeen(machine: ConnectedMachine): void {
    const now = Date.now()
    if (now - machine.lastSeenWrite >= LAST_SEEN_WRITE_INTERVAL_MS) {
      machine.lastSeenWrite = now
      this.db.prepare(`UPDATE machines SET last_seen_at = datetime('now') WHERE id = ?`).run(machine.machineId)
    }
  }

  private dropIdleConnections(): void {
    const cutoff = Date.now() - IDLE_TIMEOUT_MS
    for (const machine of [...this.machines.values()]) {
      if (machine.lastActivity < cutoff) {
        machine.socket.close(CLOSE_AUTH_FAILED, 'idle timeout')
      }
    }
  }

  /** Disconnect everything and stop timers (shutdown / tests). */
  close(): void {
    clearInterval(this.idleTimer)
    for (const machine of this.machines.values()) {
      this.failPending(machine, 'relay shutting down')
      machine.socket.close(1001, 'server shutting down')
    }
    this.machines.clear()
  }
}
