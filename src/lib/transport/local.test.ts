/** Tests for LocalHttpTransport — pins /cc URL construction and Authelia session-expiry semantics. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { LocalHttpTransport } from './local'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  global.fetch = mockFetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

function response(overrides: Partial<Response> & { contentType?: string } = {}): Response {
  const { contentType = 'application/json', ...rest } = overrides
  return {
    ok: true,
    status: 200,
    redirected: false,
    type: 'basic',
    url: '',
    headers: new Headers({ 'content-type': contentType }),
    json: () => Promise.resolve({}),
    ...rest,
  } as Response
}

describe('fetch', () => {
  it('prefixes server paths with /cc', async () => {
    mockFetch.mockResolvedValue(response())
    const t = new LocalHttpTransport()
    await t.fetch('/api/sessions/list', { headers: { Authorization: 'Bearer tok' } })
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/list', {
      headers: { Authorization: 'Bearer tok' },
    })
  })

  it('omits the init argument when none is given', async () => {
    mockFetch.mockResolvedValue(response())
    const t = new LocalHttpTransport()
    await t.fetch('/api/health')
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/health')
  })
})

describe('authFetch', () => {
  it('returns JSON responses untouched, even error statuses', async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 401 }))
    const t = new LocalHttpTransport()
    const redirect = vi.spyOn(t, 'redirectToLogin').mockImplementation(() => {})
    const res = await t.authFetch('/api/sessions/list')
    expect(res.status).toBe(401)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('redirects and throws on a non-JSON 401 (Authelia intercept)', async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 401, contentType: 'text/plain' }))
    const t = new LocalHttpTransport()
    const redirect = vi.spyOn(t, 'redirectToLogin').mockImplementation(() => {})
    await expect(t.authFetch('/api/sessions/list')).rejects.toThrow('Session expired')
    expect(redirect).toHaveBeenCalled()
  })

  it('redirects and throws on an HTML login page response', async () => {
    mockFetch.mockResolvedValue(response({ contentType: 'text/html' }))
    const t = new LocalHttpTransport()
    const redirect = vi.spyOn(t, 'redirectToLogin').mockImplementation(() => {})
    await expect(t.authFetch('/api/sessions/list')).rejects.toThrow('Session expired')
    expect(redirect).toHaveBeenCalled()
  })

  it('treats 502-504 as backend-down, not auth failure', async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 503, contentType: 'text/html' }))
    const t = new LocalHttpTransport()
    const redirect = vi.spyOn(t, 'redirectToLogin').mockImplementation(() => {})
    const res = await t.authFetch('/api/sessions/list')
    expect(res.status).toBe(503)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('redirects on a followed redirect to Authelia', async () => {
    mockFetch.mockResolvedValue(
      response({ redirected: true, url: 'https://example.com/authelia/login', contentType: 'text/html' }),
    )
    const t = new LocalHttpTransport()
    const redirect = vi.spyOn(t, 'redirectToLogin').mockImplementation(() => {})
    await expect(t.authFetch('/api/sessions/list')).rejects.toThrow('Session expired')
    expect(redirect).toHaveBeenCalled()
  })
})

describe('checkAuthSession', () => {
  it('POSTs /cc/auth-verify with manual redirect handling', async () => {
    mockFetch.mockResolvedValue(response())
    const t = new LocalHttpTransport()
    await t.checkAuthSession()
    expect(mockFetch).toHaveBeenCalledWith('/cc/auth-verify', {
      method: 'POST',
      redirect: 'manual',
    })
  })

  it('returns false on an opaque redirect (Authelia intercept)', async () => {
    mockFetch.mockResolvedValue(response({ type: 'opaqueredirect' }))
    const t = new LocalHttpTransport()
    expect(await t.checkAuthSession()).toBe(false)
  })

  it('returns false on an HTML response', async () => {
    mockFetch.mockResolvedValue(response({ contentType: 'text/html' }))
    const t = new LocalHttpTransport()
    expect(await t.checkAuthSession()).toBe(false)
  })

  it('returns true when the backend is down (502-504)', async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 502, contentType: 'text/html' }))
    const t = new LocalHttpTransport()
    expect(await t.checkAuthSession()).toBe(true)
  })

  it('returns true on network errors', async () => {
    mockFetch.mockRejectedValue(new Error('network down'))
    const t = new LocalHttpTransport()
    expect(await t.checkAuthSession()).toBe(true)
  })

  it('returns true on a JSON 401 from our own server', async () => {
    mockFetch.mockResolvedValue(response({ ok: false, status: 401 }))
    const t = new LocalHttpTransport()
    expect(await t.checkAuthSession()).toBe(true)
  })
})

describe('URLs', () => {
  const originalLocation = globalThis.location

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  function stubLocation(protocol: string, host: string) {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol, host },
      writable: true,
      configurable: true,
    })
  }

  it('wsUrl selects wss: on https: pages and never contains a token', () => {
    stubLocation('https:', 'example.com')
    const t = new LocalHttpTransport()
    expect(t.wsUrl()).toBe('wss://example.com/cc/')
    expect(t.wsUrl()).not.toContain('token')
  })

  it('wsUrl selects ws: on http: pages', () => {
    stubLocation('http:', 'localhost:3000')
    const t = new LocalHttpTransport()
    expect(t.wsUrl()).toBe('ws://localhost:3000/cc/')
  })

  it('externalUrl builds an absolute /cc URL for display', () => {
    stubLocation('https:', 'example.com')
    const t = new LocalHttpTransport()
    expect(t.externalUrl('/api/webhooks/github')).toBe('https://example.com/cc/api/webhooks/github')
  })
})
