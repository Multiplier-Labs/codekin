/**
 * Session CRUD hook backed by the REST API.
 *
 * Fetches the session list on mount and polls every 10 seconds to keep
 * the sidebar in sync. Provides rename/archive helpers that automatically
 * refresh the list after mutation. Failures are swallowed; the next poll
 * resyncs.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Session } from '../types'
import * as api from '../lib/ccApi'

export function useSessions(token: string) {
  const [sessions, setSessions] = useState<Session[]>([])
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const list = await api.listSessions(token)
      setSessions(list)
    } catch {
      // Keep the last list; the next poll retries.
    }
  }, [token])

  const rename = useCallback(async (sessionId: string, name: string) => {
    if (!token) return
    try {
      await api.renameSession(token, sessionId, name)
      await refresh()
    } catch {
      // Not surfaced; the list keeps the old name.
    }
  }, [token, refresh])

  const archive = useCallback(async (sessionId: string) => {
    if (!token) return
    try {
      await api.archiveSession(token, sessionId)
      await refresh()
    } catch {
      // Not surfaced; the session stays in the list.
    }
  }, [token, refresh])

  // Poll every 10s
  useEffect(() => {
    if (!token) return
    void refresh() // eslint-disable-line react-hooks/set-state-in-effect -- data fetching; state is set after the await
    intervalRef.current = setInterval(() => void refresh(), 10000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [token, refresh])

  return { sessions, refresh, rename, archive }
}
