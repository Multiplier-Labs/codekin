/**
 * Connector hub: accepts outbound WebSocket connections from paired
 * machines at /relay/connector, authenticates the hello envelope against
 * machine credentials, and tracks online/offline state in the DB.
 *
 * Later phases route browser request/stream envelopes through the sockets
 * held here; this phase is presence + heartbeat only.
 */

import type { WebSocket } from 'ws'
import type Database from 'better-sqlite3'
import { verifyMachineCredential } from './pairing.js'
import { envelope, parseEnvelope } from './relay-protocol.js'
import type { ConnectorHello } from './relay-protocol.js'

/** Close codes mirroring the local server's WS conventions. */
const CLOSE_AUTH_FAILED = 4001
const CLOSE_REPLACED = 4009

/** A connector that hasn't sent hello within this window is dropped. */
const HELLO_TIMEOUT_MS = 5_000

/** A connector silent for longer than this is considered dead. */
const IDLE_TIMEOUT_MS = 90_000

/** last_seen_at writes are throttled to at most one per interval. */
const LAST_SEEN_WRITE_INTERVAL_MS = 60_000

interface ConnectedMachine {
  machineId: string
  socket: WebSocket
  lastActivity: number
  lastSeenWrite: number
}

export class ConnectorHub {
  private machines = new Map<string, ConnectedMachine>()
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
      }
      // request/response/stream envelopes arrive in later phases
    })

    socket.on('close', () => {
      clearTimeout(helloTimeout)
      if (machineId !== null && this.machines.get(machineId)?.socket === socket) {
        this.machines.delete(machineId)
        this.setStatus(machineId, 'offline')
      }
    })

    socket.on('error', () => {
      // close follows; nothing to do
    })
  }

  private registerMachine(machineId: string, socket: WebSocket, hello: Partial<ConnectorHello>): void {
    // A reconnect may race the old socket's close — the new connection wins.
    const existing = this.machines.get(machineId)
    if (existing && existing.socket !== socket) {
      existing.socket.close(CLOSE_REPLACED, 'replaced by new connection')
      this.machines.delete(machineId)
    }

    const now = Date.now()
    this.machines.set(machineId, { machineId, socket, lastActivity: now, lastSeenWrite: now })

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
      machine.socket.close(1001, 'server shutting down')
    }
    this.machines.clear()
  }
}
