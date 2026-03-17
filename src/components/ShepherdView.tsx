/**
 * Shepherd orchestrator view — a thin wrapper that displays the Shepherd
 * chat session with a branded header.
 *
 * On mount, fetches the Shepherd session ID from the server and notifies
 * the parent to join it. The actual chat rendering is handled by ChatView
 * and InputBar in App.tsx (same as any regular session).
 */

import { useEffect, useState } from 'react'
import { IconShield } from '@tabler/icons-react'
import * as api from '../lib/ccApi'

interface Props {
  token: string
  onShepherdSessionReady: (sessionId: string) => void
}

export function ShepherdView({ token, onShepherdSessionReady }: Props) {
  const [status, setStatus] = useState<'loading' | 'active' | 'error'>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!token) return

    let cancelled = false

    async function init() {
      try {
        // Ensure Shepherd is running and get session ID
        const result = await api.startShepherd(token)
        if (cancelled) return
        setStatus('active')
        onShepherdSessionReady(result.sessionId)
      } catch (err) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : 'Failed to start Shepherd')
        setStatus('error')
      }
    }

    void init()
    return () => { cancelled = true }
  }, [token]) // eslint-disable-line react-hooks/exhaustive-deps

  if (status === 'loading') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="flex items-center gap-3 text-neutral-4">
          <IconShield size={20} stroke={2} />
          <span className="text-[15px]">Starting Shepherd...</span>
        </div>
      </div>
    )
  }

  if (status === 'error') {
    return (
      <div className="flex flex-1 items-center justify-center">
        <div className="text-center">
          <div className="flex items-center justify-center gap-2 text-error-5 mb-2">
            <IconShield size={20} stroke={2} />
            <span className="text-[15px] font-medium">Failed to start Shepherd</span>
          </div>
          <p className="text-[14px] text-neutral-5">{error}</p>
        </div>
      </div>
    )
  }

  // When active, the parent App.tsx renders ChatView + InputBar for the joined session.
  // This component just acts as the initialization trigger.
  return null
}
