/**
 * Session CRUD hook backed by the REST API.
 *
 * Fetches the session list on mount and polls every 10 seconds to keep
 * the sidebar in sync. Provides create/remove helpers that automatically
 * refresh the list after mutation.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import type { Session } from '../types'
import * as api from '../lib/ccApi'

export function useSessions(token: string) {
  const [sessions, setSessions] = useState<Session[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const list = await api.listSessions(token)
      setSessions(list)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load sessions')
    }
  }, [token])

  const create = useCallback(async (name: string, workingDir: string) => {
    if (!token) return null
    setLoading(true)
    try {
      const result = await api.createSession(token, name, workingDir)
      await refresh()
      return result.sessionId
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session')
      return null
    } finally {
      setLoading(false)
    }
  }, [token, refresh])

  const rename = useCallback(async (sessionId: string, name: string) => {
    if (!token) return
    try {
      await api.renameSession(token, sessionId, name)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to rename session')
    }
  }, [token, refresh])

  const remove = useCallback(async (sessionId: string) => {
    if (!token) return
    try {
      await api.deleteSession(token, sessionId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete session')
    }
  }, [token, refresh])

  // Poll every 10s
  useEffect(() => {
    if (!token) return
    refresh()
    intervalRef.current = setInterval(refresh, 10000)
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current)
    }
  }, [token, refresh])

  return { sessions, loading, error, refresh, create, rename, remove }
}
