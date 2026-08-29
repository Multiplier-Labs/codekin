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
  view: 'chat' | 'automations' | 'orchestrator'
  /** Which Automations tab a legacy deep link asked for (/workflows, /loops). */
  automationsTab: 'workflows' | 'loops' | null
}

export function parsePath(pathname: string): RouteState {
  if (pathname === '/joe' || pathname === '/joe/' || pathname === '/orchestrator' || pathname === '/orchestrator/') {
    return { path: pathname, sessionId: null, view: 'orchestrator', automationsTab: null }
  }
  if (pathname === '/automations' || pathname === '/automations/') {
    return { path: pathname, sessionId: null, view: 'automations', automationsTab: null }
  }
  // Legacy routes from before the unified Automations view — same view,
  // with the matching tab preselected. App canonicalizes the URL.
  if (pathname === '/workflows' || pathname === '/workflows/') {
    return { path: pathname, sessionId: null, view: 'automations', automationsTab: 'workflows' }
  }
  if (pathname === '/loops' || pathname === '/loops/') {
    return { path: pathname, sessionId: null, view: 'automations', automationsTab: 'loops' }
  }
  const match = pathname.match(/^\/s\/([a-f0-9-]+)\/?$/)
  return {
    path: pathname,
    sessionId: match ? match[1] : null,
    view: 'chat',
    automationsTab: null,
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
