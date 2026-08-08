/**
 * Auth state for the hosted app: one /api/me probe on boot, cookie-based.
 *
 * `initialized` is a one-shot latch so route decisions never bounce back to
 * a loading state after the first resolution (prevents login-screen flash).
 */

import { useState, useEffect, useCallback } from 'react'

export interface HostedUser {
  id: string
  login: string
  displayName: string | null
  avatarUrl: string | null
  role: 'owner' | 'admin' | 'member' | 'viewer'
  status: 'active' | 'pending' | 'disabled'
}

export interface HostedAuthState {
  user: HostedUser | null
  /** True once the first /api/me probe has resolved (success or failure). */
  initialized: boolean
  /** Error code passed back from a failed OAuth callback (?auth_error=...). */
  authError: string | null
  refresh: () => Promise<void>
  logout: () => Promise<void>
}

/** Read and strip the ?auth_error= param the OAuth callback may redirect with. */
function consumeAuthError(): string | null {
  const params = new URLSearchParams(window.location.search)
  const err = params.get('auth_error')
  if (err) {
    params.delete('auth_error')
    const qs = params.toString()
    history.replaceState(null, '', window.location.pathname + (qs ? `?${qs}` : ''))
  }
  return err
}

export function useHostedAuth(): HostedAuthState {
  const [user, setUser] = useState<HostedUser | null>(null)
  const [initialized, setInitialized] = useState(false)
  const [authError] = useState<string | null>(consumeAuthError)

  const refresh = useCallback(async () => {
    try {
      const res = await fetch('/api/me', { credentials: 'include' })
      if (res.ok) {
        const data = await res.json() as { user: HostedUser | null }
        setUser(data.user)
      } else {
        setUser(null)
      }
    } catch {
      setUser(null)
    } finally {
      setInitialized(true)
    }
  }, [])

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' })
    } catch {
      // Cookie may already be gone; clearing local state is what matters
    }
    setUser(null)
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { user, initialized, authError, refresh, logout }
}
