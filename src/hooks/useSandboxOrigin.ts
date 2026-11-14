/**
 * The origin of the Canvas sandbox page (docs/CANVAS-SPEC.md §8), where
 * charts and HTML items render: a build-time VITE_CANVAS_SANDBOX_ORIGIN
 * (hosted web app), else what this machine reports (a configured origin, or
 * a port on the host the browser already reaches Codekin by). Null means
 * there is no sandbox, and those items show their source instead.
 */

import { useEffect, useState } from 'react'
import { getCanvasSandbox } from '../lib/ccApi'

const BUILT_IN = import.meta.env.VITE_CANVAS_SANDBOX_ORIGIN as string | undefined

export function originFrom(info: { origin: string | null; port: number | null } | null, location: { protocol: string; hostname: string }): string | null {
  if (!info) return null
  if (info.origin) return info.origin
  if (!info.port) return null
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname
  return `${location.protocol}//${host}:${info.port}`
}

/** undefined while loading; null when there is no sandbox. */
export function useSandboxOrigin(token: string): string | null | undefined {
  const [origin, setOrigin] = useState<string | null | undefined>(() => {
    if (!BUILT_IN) return undefined
    try { return new URL(BUILT_IN).origin } catch { return null }
  })
  useEffect(() => {
    if (BUILT_IN || !token) return
    let cancelled = false
    getCanvasSandbox(token)
      .then(info => { if (!cancelled) setOrigin(originFrom(info, window.location)) })
      .catch(() => { if (!cancelled) setOrigin(null) })
    return () => { cancelled = true }
  }, [token])
  return origin
}
