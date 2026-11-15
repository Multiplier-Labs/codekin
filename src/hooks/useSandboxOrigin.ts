/**
 * The origin of the Canvas sandbox page (docs/CANVAS-SPEC.md §8), where
 * charts and HTML items render: a build-time VITE_CANVAS_SANDBOX_ORIGIN
 * (hosted web app), else what this machine reports (a configured origin, or
 * a port on the host the browser already reaches Codekin by). Null means
 * there is no sandbox, and those items show their source instead.
 *
 * In the desktop app, also null unless the app's window will load the frame.
 * Its windows refuse every address they don't allow, frames included, and
 * open it in the default browser instead. Builds that allow the sandbox say
 * so with DESKTOP_FRAMES_TOKEN in their user agent, and a hosted location's
 * window allows only the sandbox its relay advertises in /api/relay/info.
 */

import { useEffect, useState } from 'react'
import { getCanvasSandbox } from '../lib/ccApi'
import { isDesktopWebView } from '../lib/desktopLinks'

const BUILT_IN = import.meta.env.VITE_CANVAS_SANDBOX_ORIGIN as string | undefined

/** Desktop builds whose windows let the Canvas sandbox frame load add this to their user agent. */
export const DESKTOP_FRAMES_TOKEN = 'CodekinFrames/'

/** False in a desktop app too old to load the sandbox frame; true elsewhere. */
export function desktopLoadsFrames(userAgent: string): boolean {
  return !isDesktopWebView(userAgent) || userAgent.includes(DESKTOP_FRAMES_TOKEN)
}

function parseOrigin(raw: string): string | null {
  try { return new URL(raw).origin } catch { return null }
}

export function originFrom(info: { origin: string | null; port: number | null } | null, location: { protocol: string; hostname: string }): string | null {
  if (!info) return null
  if (info.origin) return info.origin
  if (!info.port) return null
  const host = location.hostname.includes(':') ? `[${location.hostname}]` : location.hostname
  return `${location.protocol}//${host}:${info.port}`
}

/** undefined while loading; null when there is no sandbox. */
export function useSandboxOrigin(token: string): string | null | undefined {
  const userAgent = typeof navigator === 'undefined' ? '' : navigator.userAgent
  const desktop = isDesktopWebView(userAgent)
  const frames = desktopLoadsFrames(userAgent)
  const [origin, setOrigin] = useState<string | null | undefined>(() => {
    if (!frames) return null
    if (!BUILT_IN) return undefined
    // In the desktop app, wait for the relay to confirm its sandbox (below).
    return desktop ? undefined : parseOrigin(BUILT_IN)
  })
  useEffect(() => {
    if (!frames) return
    let cancelled = false
    if (BUILT_IN) {
      if (!desktop) return
      const expected = parseOrigin(BUILT_IN)
      fetch('/api/relay/info', { credentials: 'omit' })
        .then(res => (res.ok ? (res.json() as Promise<{ canvasSandboxOrigin?: unknown }>) : null))
        .then(info => { if (!cancelled) setOrigin(expected && info?.canvasSandboxOrigin === expected ? expected : null) })
        .catch(() => { if (!cancelled) setOrigin(null) })
      return () => { cancelled = true }
    }
    if (!token) return
    getCanvasSandbox(token)
      .then(info => { if (!cancelled) setOrigin(originFrom(info, window.location)) })
      .catch(() => { if (!cancelled) setOrigin(null) })
    return () => { cancelled = true }
  }, [token, frames, desktop])
  return origin
}
