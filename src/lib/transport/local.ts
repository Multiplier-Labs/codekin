/**
 * Local transport: direct HTTP + WebSocket access to the Codekin server
 * through the same-origin `/cc` proxy (nginx in production, Vite in dev),
 * with Authelia providing the outer auth session.
 */

import type { CodekinTransport, TransportTarget } from './types'

/** Base path for the Codekin server REST API (proxied by nginx/Vite). */
const BASE = '/cc'

/** Authelia login page — redirect here when the session expires. */
const LOGIN_URL = '/authelia/login'

export class LocalHttpTransport implements CodekinTransport {
  /** Prevents multiple concurrent login redirects. */
  private redirecting = false

  fetch(path: string, init?: RequestInit): Promise<Response> {
    const url = `${BASE}${path}`
    return init ? fetch(url, init) : fetch(url)
  }

  async authFetch(path: string, init?: RequestInit): Promise<Response> {
    const res = await this.fetch(path, init)
    if (this.isAuthExpiredResponse(res)) {
      this.redirectToLogin()
      throw new Error('Session expired')
    }
    return res
  }

  /**
   * Build the WebSocket URL, auto-selecting wss: or ws: based on current page
   * protocol. Auth token is sent as a post-connect message (not in the URL)
   * to avoid log exposure.
   */
  wsUrl(): string {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    return `${proto}//${location.host}${BASE}/`
  }

  openSocket(): WebSocket {
    return new WebSocket(this.wsUrl())
  }

  /**
   * Probe whether the Authelia session is still valid by hitting a
   * lightweight endpoint. Returns false if the session has expired.
   */
  async checkAuthSession(): Promise<boolean> {
    try {
      const res = await this.fetch('/auth-verify', {
        method: 'POST',
        redirect: 'manual',
      })
      // If Authelia intercepts with a redirect or non-JSON response, session is expired.
      // A 401 from our own server (invalid token) is fine — means Authelia let us through.
      if (res.type === 'opaqueredirect') return false
      // 502/503/504 = backend is down (e.g. during deploy restart), not an auth failure
      if (res.status >= 502 && res.status <= 504) return true
      const ct = res.headers.get('content-type') || ''
      if (ct.includes('text/html')) return false
      return true
    } catch {
      // Network error — don't treat as auth failure
      return true
    }
  }

  redirectToLogin(): void {
    if (this.redirecting) return
    this.redirecting = true
    window.location.href = LOGIN_URL
  }

  externalUrl(path: string): string {
    return `${location.protocol}//${location.host}${BASE}${path}`
  }

  /** The server is behind this page's own origin, so that is the target. */
  describeTarget(): TransportTarget {
    return { label: location.host, detail: 'Direct' }
  }

  /**
   * Check if a fetch response indicates an expired Authelia session.
   * Authelia may return a 401, or nginx may return a 302 redirect to the login
   * page. Also handles the case where the response is an HTML login page
   * instead of JSON.
   */
  private isAuthExpiredResponse(res: Response): boolean {
    // Authelia redirects may come back as opaque redirects or HTML responses
    if (res.redirected && res.url.includes('/authelia')) return true
    // 502/503/504 = backend is down (e.g. during deploy restart), not an auth failure
    if (res.status >= 502 && res.status <= 504) return false
    const ct = res.headers.get('content-type') || ''
    // If the response is JSON, it came from our own API — not an auth proxy intercept
    if (ct.includes('application/json')) return false
    // Non-JSON 401/403 likely means Authelia intercepted the request
    if (res.status === 401 || res.status === 403) return true
    // HTML response when expecting JSON means the auth proxy intercepted the request
    if (res.ok && ct.includes('text/html')) return true
    return false
  }
}
