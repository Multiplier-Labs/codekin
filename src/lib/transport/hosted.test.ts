/** Tests for HostedRelayTransport — pins relay routing, body coding, and session-expiry semantics. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HostedRelayTransport } from './hosted'
import { RelayConnection, RelayRequestError, encodeBody, decodeBody } from './relay-client'

const mockFetch = vi.fn()

/** A RelayConnection stand-in whose `request` is controlled by the test. */
function fakeConnection(request: RelayConnection['request']): RelayConnection {
  return { request, connect: vi.fn(), close: vi.fn() } as unknown as RelayConnection
}

function base64(text: string): string {
  return Buffer.from(text, 'utf-8').toString('base64')
}

beforeEach(() => {
  mockFetch.mockReset()
  global.fetch = mockFetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('fetch', () => {
  it('routes the path and method through the relay and rebuilds the Response', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: base64('{"sessions":[]}'),
    })
    const t = new HostedRelayTransport('m1', fakeConnection(request))

    const res = await t.fetch('/api/sessions/list')

    expect(request).toHaveBeenCalledWith('GET', '/api/sessions/list', undefined, undefined)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json')
    expect(await res.json()).toEqual({ sessions: [] })
  })

  it('base64-encodes a string request body', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, headers: {} })
    const t = new HostedRelayTransport('m1', fakeConnection(request))

    await t.fetch('/api/sessions/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"name":"x"}',
    })

    expect(request).toHaveBeenCalledWith(
      'POST', '/api/sessions/create', base64('{"name":"x"}'), 'application/json',
    )
  })

  it('preserves a machine-level error status rather than masking it', async () => {
    const request = vi.fn().mockResolvedValue({ status: 401, headers: {}, body: base64('{"error":"Unauthorized"}') })
    const t = new HostedRelayTransport('m1', fakeConnection(request))

    const res = await t.fetch('/api/health')
    expect(res.status).toBe(401)
  })

  it('turns a relay failure into a 502 carrying the relay code', async () => {
    const request = vi.fn().mockRejectedValue(new RelayRequestError('machine_offline', 'Machine is not connected'))
    const t = new HostedRelayTransport('m1', fakeConnection(request))

    const res = await t.fetch('/api/sessions/list')
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: 'Machine is not connected', relayCode: 'machine_offline' })
  })

  it('handles an empty response body', async () => {
    const request = vi.fn().mockResolvedValue({ status: 204, headers: {} })
    const t = new HostedRelayTransport('m1', fakeConnection(request))

    const res = await t.fetch('/api/health')
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })
})

describe('authFetch', () => {
  it('passes a machine response straight through without probing the session', async () => {
    const request = vi.fn().mockResolvedValue({ status: 401, headers: {} })
    const t = new HostedRelayTransport('m1', fakeConnection(request))

    const res = await t.authFetch('/api/sessions/list')
    expect(res.status).toBe(401)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('keeps the 502 when the relay failed but the browser session is still valid', async () => {
    const request = vi.fn().mockRejectedValue(new RelayRequestError('timeout', 'too slow'))
    mockFetch.mockResolvedValue({ status: 200 } as Response)
    const t = new HostedRelayTransport('m1', fakeConnection(request))

    const res = await t.authFetch('/api/sessions/list')
    expect(res.status).toBe(502)
    expect(mockFetch).toHaveBeenCalledWith('/api/me', { credentials: 'include' })
  })

  it('redirects to sign-in when /api/me says the session is gone', async () => {
    const request = vi.fn().mockRejectedValue(new RelayRequestError('disconnected', 'closed'))
    mockFetch.mockResolvedValue({ status: 401 } as Response)

    const hrefSetter = vi.fn()
    const location = {}
    Object.defineProperty(location, 'href', { set: hrefSetter, configurable: true })
    const originalWindow = globalThis.window
    ;(globalThis as any).window = { location }

    try {
      const t = new HostedRelayTransport('m1', fakeConnection(request))
      await expect(t.authFetch('/api/sessions/list')).rejects.toThrow('Session expired')
      expect(hrefSetter).toHaveBeenCalledWith('/api/auth/github/start')
    } finally {
      ;(globalThis as any).window = originalWindow
    }
  })
})

describe('streaming', () => {
  it('opens a distinct relay channel per socket', () => {
    const openChannel = vi.fn()
    const connection = { request: vi.fn(), connect: vi.fn(), close: vi.fn(), openChannel } as unknown as RelayConnection
    const t = new HostedRelayTransport('m1', connection)

    t.openSocket()
    t.openSocket()

    expect(openChannel).toHaveBeenCalledTimes(2)
    const [firstId] = openChannel.mock.calls[0] as [string]
    const [secondId] = openChannel.mock.calls[1] as [string]
    expect(firstId).not.toBe(secondId)
  })

  it('reports a relay url for display', () => {
    const t = new HostedRelayTransport('m1', fakeConnection(vi.fn()))
    expect(t.wsUrl()).toBe('relay://m1')
  })
})

describe('describeTarget', () => {
  const originalLocation = globalThis.location

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  function stubHost(host: string) {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'https:', host },
      writable: true,
      configurable: true,
    })
  }

  it('names the machine and the control plane it is reached through', () => {
    stubHost('app.codekin.ai')
    const t = new HostedRelayTransport('m1', fakeConnection(vi.fn()), 'hatchery')
    expect(t.describeTarget()).toEqual({ label: 'hatchery', detail: 'via app.codekin.ai' })
  })

  it('falls back to the machine id when no display name is given', () => {
    stubHost('app.codekin.ai')
    const t = new HostedRelayTransport('m1', fakeConnection(vi.fn()))
    expect(t.describeTarget().label).toBe('m1')
  })
})

describe('body coding', () => {
  it('round-trips utf-8 text', () => {
    const encoded = encodeBody('héllo — ünïcode')
    const decoded = decodeBody(encoded)
    expect(new TextDecoder().decode(decoded!)).toBe('héllo — ünïcode')
  })

  it('decodes an absent body to null', () => {
    expect(decodeBody(undefined)).toBeNull()
  })
})
