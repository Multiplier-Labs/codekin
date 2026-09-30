/**
 * Agent Joe's availability: whether a harness has been chosen and which
 * session Joe runs in (for its pending-approval indicator).
 */

import { useCallback, useEffect, useState } from 'react'
import * as api from '../lib/ccApi'
import type { CodingProvider } from '../types'

export interface JoeStatus {
  sessionId: string | null
  provider: CodingProvider | null
}

export function useJoeStatus(token: string) {
  const [status, setStatus] = useState<JoeStatus | null>(null)

  const refresh = useCallback(async () => {
    if (!token) return
    try {
      const result = await api.getOrchestratorStatus(token) as { provider: CodingProvider | null; sessionId?: string | null }
      setStatus({ provider: result.provider, sessionId: result.sessionId ?? null })
    } catch {
      // Leave the last known status; the Tasks view shows its own errors.
    }
  }, [token])

  useEffect(() => {
    void refresh() // eslint-disable-line react-hooks/set-state-in-effect -- initial load
  }, [refresh])

  return { status, refresh }
}
