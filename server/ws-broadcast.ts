/**
 * Global WebSocket broadcast, restricted to authenticated connections.
 *
 * A socket joins `wss.clients` as soon as it connects, but only proves it
 * holds the bearer token with its first `auth` frame (up to WS_AUTH_TIMEOUT_MS
 * later). Global broadcasts carry session names and, when no client is
 * attached to a session, full approval prompts (tool name + tool input), so
 * they must never reach a socket that has not authenticated.
 */

import { WebSocket } from 'ws'

/** The subset of a WebSocket the broadcaster needs (keeps it unit-testable). */
export interface BroadcastTarget {
  readyState: number
  send(data: string): void
}

/** Send `msg` to every open socket in `authenticated`. */
export function broadcastToAuthenticated(authenticated: Iterable<BroadcastTarget>, msg: unknown): void {
  const data = JSON.stringify(msg)
  for (const ws of authenticated) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data)
    }
  }
}
