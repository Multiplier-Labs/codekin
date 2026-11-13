/** Tests for the shared REST helper (src/lib/request.ts). */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { request, send, joeRequest } from './request'
import { LocalHttpTransport, setTransport, type CodekinTransport } from './transport'

const mockFetch = vi.fn()
let hrefSetter: ReturnType<typeof vi.fn>
const origWindow = globalThis.window

beforeEach(() => {
  mockFetch.mockReset()
  global.fetch = mockFetch
  // A fresh local transport per test, so its one-shot login redirect flag resets.
  setTransport(new LocalHttpTransport())
  hrefSetter = vi.fn()
  const loc = {}
  Object.defineProperty(loc, 'href', { set: hrefSetter, configurable: true })
  ;(globalThis as any).window = { location: loc }
})

afterEach(() => {
  ;(globalThis as any).window = origWindow
  setTransport(new LocalHttpTransport())
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function textResponse(text: string, status: number, contentType = 'text/plain'): Response {
  return new Response(text, { status, headers: { 'content-type': contentType } })
}

describe('request: success', () => {
  it('parses JSON and sends only the headers it was asked for', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ value: 1 }))
    expect(await request('/api/thing', { token: 'tok', error: 'Failed' })).toEqual({ value: 1 })
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/thing', { headers: { Authorization: 'Bearer tok' } })
  })

  it('serialises a JSON body with method and content type', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    await request('/api/thing', { method: 'PUT', token: 'tok', body: { a: 1 }, error: 'Failed' })
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/thing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
      body: '{"a":1}',
    })
  })

  it('sends the JSON content type without a body when jsonHeader is set', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    await request('/api/thing', { method: 'POST', token: 'tok', jsonHeader: true, error: 'Failed' })
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/thing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' },
    })
  })

  it('passes a raw body through untouched, without a content type', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ path: '/x' }))
    const form = new FormData()
    form.append('file', 'data')
    await request('/api/upload', { method: 'POST', token: 'tok', rawBody: form, error: 'Upload failed' })
    const init = mockFetch.mock.calls[0][1] as RequestInit
    expect(init.body).toBe(form)
    expect(init.headers).toEqual({ Authorization: 'Bearer tok' })
  })

  it('omits Authorization when no token is given', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    await send('/api/clone', { method: 'POST', body: {} })
    expect((mockFetch.mock.calls[0][1] as RequestInit).headers).toEqual({ 'Content-Type': 'application/json' })
  })

  it('reads text when parse is text', async () => {
    mockFetch.mockResolvedValue(textResponse('plan body', 200))
    expect(await request('/api/a', { token: 't', parse: 'text', error: 'Failed' })).toBe('plan body')
  })

  it('resolves undefined for an empty body when parse is none', async () => {
    mockFetch.mockResolvedValue(new Response(null, { status: 204 }))
    expect(await request('/api/a', { method: 'DELETE', token: 't', parse: 'none', error: 'Failed' })).toBeUndefined()
  })
})

describe('request: non-ok responses', () => {
  it('uses "<prefix>: <status>" and ignores the body by default', async () => {
    const res = jsonResponse({ error: 'server says no' }, 500)
    const json = vi.spyOn(res, 'json')
    mockFetch.mockResolvedValue(res)
    await expect(request('/api/a', { token: 't', error: 'Failed to list things' })).rejects.toThrow(
      new Error('Failed to list things: 500'),
    )
    expect(json).not.toHaveBeenCalled()
  })

  it('takes the server message from a JSON error body', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Path does not exist' }, 400))
    await expect(request('/api/a', { token: 't', serverMessage: ['error'], error: 'Failed' })).rejects.toThrow(
      new Error('Path does not exist'),
    )
  })

  it('tries serverMessage fields in order', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ message: 'friendly', error: 'code' }, 400))
    await expect(request('/api/a', { token: 't', serverMessage: ['message', 'error'], error: 'Failed' })).rejects.toThrow(
      new Error('friendly'),
    )
    mockFetch.mockResolvedValue(jsonResponse({ error: 'code' }, 400))
    await expect(request('/api/a', { token: 't', serverMessage: ['message', 'error'], error: 'Failed' })).rejects.toThrow(
      new Error('code'),
    )
  })

  it('falls back to the status message when the JSON body has no usable message', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: '' }, 422))
    await expect(request('/api/a', { token: 't', serverMessage: ['error'], error: 'Failed to set' })).rejects.toThrow(
      new Error('Failed to set: 422'),
    )
  })

  it('uses `unreadable` for a non-JSON error body, else the status message', async () => {
    mockFetch.mockResolvedValue(textResponse('<html>Bad gateway</html>', 500, 'text/html'))
    await expect(request('/api/a', {
      token: 't', serverMessage: ['error'], unreadable: 'Failed to save', error: 'Failed to set',
    })).rejects.toThrow(new Error('Failed to save'))

    mockFetch.mockResolvedValue(textResponse('oops', 500))
    await expect(request('/api/a', { token: 't', serverMessage: ['error'], error: 'Failed to set' })).rejects.toThrow(
      new Error('Failed to set: 500'),
    )
  })

  it('accepts a function for the fallback message', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 503))
    await expect(request('/api/a', { token: 't', error: s => `Failed to load runs (${s})` })).rejects.toThrow(
      new Error('Failed to load runs (503)'),
    )
  })
})

describe('request: 401 and auth expiry', () => {
  it('with authFetch, a non-JSON 401 (auth proxy intercept) redirects to login and rejects "Session expired"', async () => {
    mockFetch.mockResolvedValue(textResponse('Unauthorized', 401))
    await expect(request('/api/a', { token: 't', authFetch: true, error: 'Failed' })).rejects.toThrow(
      new Error('Session expired'),
    )
    expect(hrefSetter).toHaveBeenCalledWith('/authelia/login')
  })

  it('with authFetch, a JSON 401 from the Codekin server is an ordinary failure', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Invalid token' }, 401))
    await expect(request('/api/a', { token: 't', authFetch: true, serverMessage: ['error'], error: 'Failed' })).rejects.toThrow(
      new Error('Invalid token'),
    )
    expect(hrefSetter).not.toHaveBeenCalled()
  })

  it('without authFetch, a 401 never redirects', async () => {
    mockFetch.mockResolvedValue(textResponse('Unauthorized', 401))
    await expect(request('/api/a', { token: 't', error: 'Failed' })).rejects.toThrow(new Error('Failed: 401'))
    expect(hrefSetter).not.toHaveBeenCalled()
  })
})

describe('request: transport routing (hosted mode)', () => {
  function fakeTransport(): CodekinTransport & { fetch: ReturnType<typeof vi.fn>; authFetch: ReturnType<typeof vi.fn> } {
    return {
      fetch: vi.fn(async () => jsonResponse({ via: 'fetch' })),
      authFetch: vi.fn(async () => jsonResponse({ via: 'authFetch' })),
      wsUrl: () => 'relay://m1',
      openSocket: () => { throw new Error('unused') },
      checkAuthSession: async () => true,
      redirectToLogin: () => {},
      externalUrl: p => p,
      describeTarget: () => ({ label: 'm1', detail: 'via relay' }),
      relayMachineId: 'm1',
    }
  }

  it('goes through whichever transport is installed at call time, with the server-side path', async () => {
    const hosted = fakeTransport()
    setTransport(hosted)
    expect(await request('/api/a', { token: 't', error: 'Failed' })).toEqual({ via: 'fetch' })
    expect(await request('/api/b', { token: 't', authFetch: true, error: 'Failed' })).toEqual({ via: 'authFetch' })
    expect(hosted.fetch).toHaveBeenCalledWith('/api/a', { headers: { Authorization: 'Bearer t' } })
    expect(hosted.authFetch).toHaveBeenCalledWith('/api/b', { headers: { Authorization: 'Bearer t' } })
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it("surfaces the hosted transport's synthesized 502 relay error text where the call site reads it", async () => {
    const hosted = fakeTransport()
    hosted.fetch.mockResolvedValue(jsonResponse({ error: 'Relay request failed', relayCode: 'relay_error' }, 502))
    setTransport(hosted)
    await expect(joeRequest('t', '/api/orchestrator/tasks')).rejects.toThrow(new Error('Relay request failed'))
  })
})

describe('joeRequest', () => {
  it('sends GET with Bearer auth and adds the content type only with a body', async () => {
    mockFetch.mockImplementation(async () => jsonResponse({ tasks: [] }))
    await joeRequest('tok', '/api/orchestrator/tasks?repo=x')
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/orchestrator/tasks?repo=x', {
      method: 'GET', headers: { Authorization: 'Bearer tok' },
    })
    await joeRequest('tok', '/api/orchestrator/tasks', { method: 'POST', body: { a: 1 } })
    expect(mockFetch).toHaveBeenLastCalledWith('/cc/api/orchestrator/tasks', {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok' }, body: '{"a":1}',
    })
  })

  it('rejects with the server error, or "Request failed (<status>)"', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'Task not found' }, 404))
    await expect(joeRequest('t', '/x')).rejects.toThrow(new Error('Task not found'))
    mockFetch.mockResolvedValue(textResponse('nope', 500))
    await expect(joeRequest('t', '/x')).rejects.toThrow(new Error('Request failed (500)'))
    mockFetch.mockResolvedValue(jsonResponse({}, 409))
    await expect(joeRequest('t', '/x')).rejects.toThrow(new Error('Request failed (409)'))
  })
})
