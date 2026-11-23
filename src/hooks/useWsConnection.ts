/**
 * Low-level WebSocket connection hook — owns transport lifecycle only.
 *
 * Handles: WebSocket creation, auth handshake, connState, ping/pong heartbeat,
 * auto-reconnect with exponential backoff, Authelia session checks, and
 * visibility-change session restore (health ping / zombie detection).
 *
 * All parsed messages are forwarded to the caller via `onMessageRef`.
 * This hook knows nothing about chat messages, sessions, or streaming buffers.
 */

import { useRef, useCallback, useEffect, useState } from 'react'
import type { WsClientMessage, WsServerMessage, ConnectionState } from '../types'
import { openSocket, checkAuthSession, redirectToLogin } from '../lib/ccApi'

/** How often to check whether the Authelia session is still valid (ms). */
const AUTH_CHECK_INTERVAL_MS = 60_000
/**
 * First reconnect delay after a drop. Kept short because the common drop is a
 * phone waking from lock, where the network is already back; repeated
 * failures back off from here, doubling up to 30s.
 */
const BACKOFF_INITIAL_MS = 250
const BACKOFF_MAX_MS = 30_000
/**
 * Least time between auth probes triggered by a drop or a wake. A socket that
 * keeps failing would otherwise probe on every retry, and the probe endpoint
 * is rate-limited per IP: a retry storm locks every client behind that IP out.
 */
export const AUTH_PROBE_MIN_GAP_MS = 15_000

export interface UseWsConnectionOptions {
  token: string
  /** Ref-stable callback invoked for every parsed WsServerMessage. */
  onMessageRef: React.RefObject<(msg: WsServerMessage) => void>
  /** Called when the WebSocket closes (for resetting processing state, RAF cleanup, etc.). */
  onDisconnect?: () => void
  /** Called when a health-check pong arrives. Receives `send` so the caller can rejoin the session. */
  onHealthPong?: (send: (msg: WsClientMessage) => void) => void
}

export function useWsConnection({
  token,
  onMessageRef,
  onDisconnect,
  onHealthPong,
}: UseWsConnectionOptions) {
  const wsRef = useRef<WebSocket | null>(null)
  const [connState, setConnState] = useState<ConnectionState>('disconnected')

  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingTimer = useRef<ReturnType<typeof setInterval> | null>(null)
  /** Exponential backoff delay (ms) for reconnect attempts, doubling up to 30s. Reset on successful open. */
  const backoff = useRef(BACKOFF_INITIAL_MS)
  const intentionalClose = useRef(false)
  const connectRef = useRef<() => void>(() => {})
  /** When the last drop- or wake-triggered auth probe ran (ms since epoch). */
  const lastAuthProbe = useRef(0)

  // Session restore / health check state machine:
  //
  //   Tab hidden → Tab visible
  //     ├─ WS OPEN:  set awaitingHealthPong=true, send ping, start retry loop
  //     │    ├─ pong received before deadline → call onHealthPong (rejoin session)
  //     │    └─ all retries exhausted (3 pings over 6s) → close WS as zombie, reconnect
  //     ├─ WS CONNECTING: no-op (onopen will complete the handshake)
  //     └─ WS CLOSED: check auth → reconnect()
  //
  //   restoringRef gates the entire flow to prevent overlapping restore attempts
  //   (held for 3s after each trigger).
  const restoringRef = useRef(false)
  const awaitingHealthPong = useRef(false)
  const healthPongTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** How many health pings have been sent in the current restore attempt. */
  const healthPingCount = useRef(0)

  // Stable refs for callbacks that may change
  const onDisconnectRef = useRef(onDisconnect)
  const onHealthPongRef = useRef(onHealthPong)
  useEffect(() => { onDisconnectRef.current = onDisconnect }, [onDisconnect])
  useEffect(() => { onHealthPongRef.current = onHealthPong }, [onHealthPong])

  const cleanup = useCallback(() => {
    if (pingTimer.current) { clearInterval(pingTimer.current); pingTimer.current = null }
    if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
    if (healthPongTimer.current) { clearTimeout(healthPongTimer.current); healthPongTimer.current = null }
  }, [])

  /** Check the login session after a drop or wake, at most once per AUTH_PROBE_MIN_GAP_MS. */
  const probeAuth = useCallback(() => {
    const now = Date.now()
    if (now - lastAuthProbe.current < AUTH_PROBE_MIN_GAP_MS) return
    lastAuthProbe.current = now
    checkAuthSession().then(valid => {
      if (!valid) { cleanup(); redirectToLogin() }
    }).catch(() => { /* network error — the socket retries on its own */ })
  }, [cleanup])

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const connect = useCallback(() => {
    if (!token) return
    // A visibility restore and a close-triggered retry can both land here at
    // once on wake; a second socket would double-deliver every message.
    const existing = wsRef.current
    if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) return
    cleanup()
    setConnState('connecting')

    const ws = openSocket()
    wsRef.current = ws

    ws.onopen = () => {
      if (wsRef.current !== ws) return
      ws.send(JSON.stringify({ type: 'auth', token }))
      setConnState('connected')
      // The backoff resets on the server's `connected` reply, not here: a
      // server can accept the socket and close it straight away (origin not
      // allowed, too many connections), and resetting on open would retry
      // that every 250ms forever.
      pingTimer.current = setInterval(() => {
        send({ type: 'ping' })
      }, 30000)
    }

    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return
      let msg: WsServerMessage
      try { msg = JSON.parse(event.data as string) as WsServerMessage } catch { return }

      // Auth accepted: the connection works, so the next drop retries fast again.
      if (msg.type === 'connected') backoff.current = BACKOFF_INITIAL_MS

      // Intercept health-check pong before forwarding
      if (msg.type === 'pong' && awaitingHealthPong.current) {
        awaitingHealthPong.current = false
        if (healthPongTimer.current) {
          clearTimeout(healthPongTimer.current)
          healthPongTimer.current = null
        }
        onHealthPongRef.current?.(send)
      }

      onMessageRef.current?.(msg)
    }

    ws.onclose = (event) => {
      if (wsRef.current !== ws) return
      setConnState('disconnected')
      cleanup()
      awaitingHealthPong.current = false
      wsRef.current = null
      onDisconnectRef.current?.()

      if (event.code === 4001) {
        redirectToLogin()
        return
      }

      if (!intentionalClose.current) {
        // Retry without waiting on the auth probe: it is a full round trip,
        // and an expired session still redirects as soon as it answers.
        const delay = backoff.current
        backoff.current = Math.min(backoff.current * 2, BACKOFF_MAX_MS)
        reconnectTimer.current = setTimeout(() => {
          reconnectTimer.current = null
          connectRef.current()
        }, delay)
        probeAuth()
      }
    }

    ws.onerror = () => { /* onclose will fire after this */ }
  }, [token, cleanup, send, onMessageRef, probeAuth])
  useEffect(() => { connectRef.current = connect }, [connect])

  const disconnect = useCallback(() => {
    intentionalClose.current = true
    cleanup()
    wsRef.current?.close()
    wsRef.current = null
    setConnState('disconnected')
  }, [cleanup])

  /**
   * Restore the connection after a visibility change (tab focus return).
   * Case 1: WS open — health ping with retries (3 attempts over 6s), rejoin on pong.
   * Case 2: WS connecting — let existing onopen handle it.
   * Case 3: WS closed — check auth, then reconnect.
   */
  const restoreSession = useCallback(() => {
    if (restoringRef.current) return
    restoringRef.current = true
    setTimeout(() => { restoringRef.current = false }, 8000)

    const ws = wsRef.current

    if (ws && ws.readyState === WebSocket.OPEN) {
      awaitingHealthPong.current = true
      healthPingCount.current = 1

      const scheduleRetryOrClose = () => {
        healthPongTimer.current = setTimeout(() => {
          healthPongTimer.current = null
          if (!awaitingHealthPong.current) return // pong arrived
          if (healthPingCount.current < 3) {
            // Retry: send another ping
            healthPingCount.current += 1
            send({ type: 'ping' })
            scheduleRetryOrClose()
          } else {
            // All retries exhausted — connection is dead
            awaitingHealthPong.current = false
            backoff.current = BACKOFF_INITIAL_MS
            ws.close()
            // A dead TCP connection can sit in CLOSING for minutes before the
            // browser fires close, so run the close path now; the late event
            // is ignored by the stale-socket guard.
            if (wsRef.current === ws) {
              ws.onclose?.({ type: 'close', code: 4000, reason: 'unresponsive', wasClean: false } as CloseEvent)
            }
          }
        }, 2000)
      }

      send({ type: 'ping' })
      scheduleRetryOrClose()
      return
    }

    if (ws && ws.readyState === WebSocket.CONNECTING) return

    // Reconnect now rather than waiting out the backoff; the outage that
    // armed it was most likely the page being suspended.
    backoff.current = BACKOFF_INITIAL_MS
    connect()
    probeAuth()
  }, [send, connect, probeAuth])

  // Connect on mount when token available, disconnect on unmount
  useEffect(() => {
    if (token) {
      intentionalClose.current = false
      connect() // eslint-disable-line react-hooks/set-state-in-effect -- WebSocket connect legitimately sets connState
    }
    return () => { disconnect() }
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  // Periodic Authelia session check
  useEffect(() => {
    if (!token) return
    const id = setInterval(async () => {
      const valid = await checkAuthSession()
      if (!valid) redirectToLogin()
    }, AUTH_CHECK_INTERVAL_MS)
    return () => clearInterval(id)
  }, [token])

  return { connState, send, disconnect, restoreSession, reconnect: connect }
}
