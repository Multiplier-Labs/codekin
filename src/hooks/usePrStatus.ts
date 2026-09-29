/**
 * Pull request status for the session shown in the Changes panel.
 *
 * Asks the server (which caches gh lookups for about a minute) when the panel
 * opens, when the session changes and after each agent turn; `refresh(true)`
 * forces a fresh lookup. Like useDiff, responses for another session or an
 * older request are dropped.
 */

import { useState, useCallback, useRef, useEffect } from 'react'
import type { PrStatus, WsClientMessage, WsServerMessage } from '../types'

interface UsePrStatusOptions {
  send: (msg: WsClientMessage) => void
  isOpen: boolean
  sessionId: string | null
}

export function usePrStatus({ send, isOpen, sessionId }: UsePrStatusOptions) {
  const [status, setStatus] = useState<PrStatus | null>(null)
  const [loading, setLoading] = useState(false)
  const sessionIdRef = useRef(sessionId)
  const isOpenRef = useRef(isOpen)
  const lastRequestIdRef = useRef(0)

  useEffect(() => { isOpenRef.current = isOpen }, [isOpen])

  const refresh = useCallback((force = false) => {
    if (!isOpenRef.current || !sessionIdRef.current) return
    const requestId = ++lastRequestIdRef.current
    setLoading(true)
    send({ type: 'get_pr_status', requestId, ...(force ? { refresh: true } : {}) })
  }, [send])

  // New session: forget the old status, then look up when visible.
  useEffect(() => {
    sessionIdRef.current = sessionId
    setStatus(null) // eslint-disable-line react-hooks/set-state-in-effect -- reset on session switch
    refresh()
  }, [sessionId, refresh])

  // Starts at the initial value: the session effect covers the first open.
  const prevOpenRef = useRef(isOpen)
  useEffect(() => {
    if (isOpen && !prevOpenRef.current) refresh() // eslint-disable-line react-hooks/set-state-in-effect -- fetch when the panel opens
    prevOpenRef.current = isOpen
  }, [isOpen, refresh])

  const handleMessage = useCallback((msg: WsServerMessage) => {
    if (msg.type !== 'pr_status') return
    if (msg.sessionId && msg.sessionId !== sessionIdRef.current) return
    if (msg.requestId !== undefined && msg.requestId !== lastRequestIdRef.current) return
    setStatus(msg.status)
    setLoading(false)
  }, [])

  return { status, loading, refresh, handleMessage }
}
