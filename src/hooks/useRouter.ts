/**
 * Minimal client-side router using the History API.
 *
 * Supports a single route pattern: `/s/:sessionId` for deep-linking
 * to sessions. Listens for popstate events (browser back/forward)
 * and provides a navigate() helper for programmatic navigation.
 */

import { useState, useCallback, useEffect } from 'react'

interface RouteState {
  path: string
  sessionId: string | null
  view: 'chat' | 'workflows' | 'shepherd'
}

export function parsePath(pathname: string): RouteState {
  if (pathname === '/joe' || pathname === '/joe/' || pathname === '/shepherd' || pathname === '/shepherd/') {
    return { path: pathname, sessionId: null, view: 'shepherd' }
  }
  if (pathname === '/workflows' || pathname === '/workflows/') {
    return { path: pathname, sessionId: null, view: 'workflows' }
  }
  const match = pathname.match(/^\/s\/([a-f0-9-]+)\/?$/)
  return {
    path: pathname,
    sessionId: match ? match[1] : null,
    view: 'chat',
  }
}

export function useRouter() {
  const [route, setRoute] = useState<RouteState>(() =>
    parsePath(window.location.pathname)
  )

  useEffect(() => {
    function onPopState() {
      setRoute(parsePath(window.location.pathname))
    }
    window.addEventListener('popstate', onPopState)
    return () => window.removeEventListener('popstate', onPopState)
  }, [])

  const navigate = useCallback((path: string, replace = false) => {
    if (path === window.location.pathname) return
    if (replace) {
      history.replaceState(null, '', path)
    } else {
      history.pushState(null, '', path)
    }
    setRoute(parsePath(path))
  }, [])

  return { ...route, navigate }
}
