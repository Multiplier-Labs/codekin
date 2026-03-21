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
import { wsUrl, checkAuthSession, redirectToLogin } from '../lib/ccApi'

/** How often to check whether the Authelia session is still valid (ms). */
const AUTH_CHECK_INTERVAL_MS = 60_000

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
  const backoff = useRef(1000)
  const intentionalClose = useRef(false)
  const connectRef = useRef<() => void>(() => {})

  // Session restore / health check state machine:
  //
  //   Tab hidden → Tab visible
  //     ├─ WS OPEN:  set awaitingHealthPong=true, send ping, start 2s timeout
  //     │    ├─ pong received before timeout → call onHealthPong (rejoin session)
  //     │    └─ timeout fires → close WS as zombie, reconnect via onclose
  //     ├─ WS CONNECTING: no-op (onopen will complete the handshake)
  //     └─ WS CLOSED: check auth → reconnect()
  //
  //   restoringRef gates the entire flow to prevent overlapping restore attempts
  //   (held for 3s after each trigger).
  const restoringRef = useRef(false)
  const awaitingHealthPong = useRef(false)
  const healthPongTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  const connect = useCallback(() => {
    if (!token) return
    cleanup()
    setConnState('connecting')

    const ws = new WebSocket(wsUrl())
    wsRef.current = ws

    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'auth', token }))
      setConnState('connected')
      backoff.current = 1000
      pingTimer.current = setInterval(() => {
        send({ type: 'ping' })
      }, 30000)
    }

    ws.onmessage = (event) => {
      let msg: WsServerMessage
      try { msg = JSON.parse(event.data) } catch { return }

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
      setConnState('disconnected')
      cleanup()
      wsRef.current = null
      onDisconnectRef.current?.()

      if (event.code === 4001) {
        redirectToLogin()
        return
      }

      if (!intentionalClose.current) {
        checkAuthSession().then(valid => {
          if (!valid) { redirectToLogin(); return }
          reconnectTimer.current = setTimeout(() => {
            backoff.current = Math.min(backoff.current * 2, 30000)
            connectRef.current()
          }, backoff.current)
        }).catch(() => {
          reconnectTimer.current = setTimeout(connectRef.current, backoff.current)
        })
      }
    }

    ws.onerror = () => { /* onclose will fire after this */ }
  }, [token, cleanup, send, onMessageRef])
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
   * Case 1: WS open — health ping, rejoin on pong, zombie timeout at 2s.
   * Case 2: WS connecting — let existing onopen handle it.
   * Case 3: WS closed — check auth, then reconnect.
   */
  const restoreSession = useCallback(() => {
    if (restoringRef.current) return
    restoringRef.current = true
    setTimeout(() => { restoringRef.current = false }, 3000)

    const ws = wsRef.current

    if (ws && ws.readyState === WebSocket.OPEN) {
      awaitingHealthPong.current = true
      healthPongTimer.current = setTimeout(() => {
        awaitingHealthPong.current = false
        healthPongTimer.current = null
        backoff.current = 1000
        ws.close()
      }, 2000)
      send({ type: 'ping' })
      return
    }

    if (ws && ws.readyState === WebSocket.CONNECTING) return

    checkAuthSession().then(valid => {
      if (!valid) { redirectToLogin(); return }
      backoff.current = 1000
      if (reconnectTimer.current) { clearTimeout(reconnectTimer.current); reconnectTimer.current = null }
      connect()
    }).catch(() => {
      reconnectTimer.current = setTimeout(connectRef.current, backoff.current)
    })
  }, [send, connect])

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
