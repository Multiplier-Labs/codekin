import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  verifyToken,
  listSessions,
  createSession,
  deleteSession,
  getHealth,
  uploadFile,
  wsUrl,
  redirectToLogin,
  checkAuthSession,
  getRepoApprovals,
  removeRepoApproval,
  bulkRemoveRepoApprovals,
  listArchivedSessions,
  getArchivedSession,
  deleteArchivedSession,
  getRetentionDays,
  setRetentionDays,
} from './ccApi'

const mockFetch = vi.fn()

beforeEach(() => {
  mockFetch.mockReset()
  global.fetch = mockFetch
})

afterEach(() => {
  vi.restoreAllMocks()
})

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(body),
  } as Response
}

describe('verifyToken', () => {
  it('returns true when response is ok and data.valid is true', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ valid: true }))
    expect(await verifyToken('tok123')).toBe(true)
    expect(mockFetch).toHaveBeenCalledWith('/cc/auth-verify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok123',
      },
      body: JSON.stringify({ token: 'tok123' }),
    })
  })

  it('returns false when response is not ok', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 401))
    expect(await verifyToken('bad')).toBe(false)
  })

  it('returns false when data.valid is not true', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ valid: false }))
    expect(await verifyToken('tok')).toBe(false)
  })

  it('returns false when data has no valid field', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ something: 'else' }))
    expect(await verifyToken('tok')).toBe(false)
  })
})

describe('listSessions', () => {
  it('returns sessions array from response', async () => {
    const sessions = [
      {
        id: 's1',
        name: 'Test',
        created: '2026-01-01',
        active: true,
        workingDir: '/tmp',
        connectedClients: 1,
        lastActivity: '2026-01-01',
      },
    ]
    mockFetch.mockResolvedValue(jsonResponse({ sessions }))
    const result = await listSessions('tok')
    expect(result).toEqual(sessions)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/list?token=tok')
  })

  it('returns empty array when response has no sessions field', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    expect(await listSessions('tok')).toEqual([])
  })

  it('encodes token in query parameter', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ sessions: [] }))
    await listSessions('a b&c')
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/list?token=a%20b%26c')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(listSessions('tok')).rejects.toThrow('Failed to list sessions: 500')
  })
})

describe('createSession', () => {
  it('returns sessionId and session object', async () => {
    const body = {
      sessionId: 's1',
      session: {
        id: 's1',
        name: 'New',
        created: '2026-01-01',
        active: true,
        workingDir: '/home',
        connectedClients: 0,
        lastActivity: '2026-01-01',
      },
    }
    mockFetch.mockResolvedValue(jsonResponse(body))
    const result = await createSession('tok', 'New', '/home')
    expect(result).toEqual(body)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/create', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok',
      },
      body: JSON.stringify({ name: 'New', workingDir: '/home' }),
    })
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 403))
    await expect(createSession('tok', 'x', '/tmp')).rejects.toThrow(
      'Failed to create session: 403',
    )
  })
})

describe('deleteSession', () => {
  it('resolves silently on success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await expect(deleteSession('tok', 's1')).resolves.toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/s1?token=tok', {
      method: 'DELETE',
    })
  })

  it('encodes token in query parameter', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await deleteSession('a=b', 's1')
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/s1?token=a%3Db', {
      method: 'DELETE',
    })
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 404))
    await expect(deleteSession('tok', 's1')).rejects.toThrow('Failed to delete session: 404')
  })
})

describe('getHealth', () => {
  it('returns health data', async () => {
    const health = { status: 'ok', claudeSessions: 3 }
    mockFetch.mockResolvedValue(jsonResponse(health))
    const result = await getHealth('tok')
    expect(result).toEqual(health)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/health?token=tok')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 503))
    await expect(getHealth('tok')).rejects.toThrow('Health check failed: 503')
  })
})

describe('uploadFile', () => {
  it('returns the file path from response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ path: '/uploads/file.txt' }))
    const file = new File(['content'], 'file.txt', { type: 'text/plain' })
    const result = await uploadFile('tok', file)
    expect(result).toBe('/uploads/file.txt')

    const [url, opts] = mockFetch.mock.calls[0]
    expect(url).toBe('/cc/api/upload?token=tok')
    expect(opts.method).toBe('POST')
    expect(opts.body).toBeInstanceOf(FormData)
    expect(opts.body.get('file')).toBeInstanceOf(File)
    expect(opts.body.get('file').name).toBe('file.txt')
  })

  it('encodes token in query parameter', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ path: '/uploads/f.txt' }))
    const file = new File(['x'], 'f.txt')
    await uploadFile('my token', file)
    expect(mockFetch.mock.calls[0][0]).toBe('/cc/api/upload?token=my%20token')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 413))
    const file = new File(['x'], 'big.bin')
    await expect(uploadFile('tok', file)).rejects.toThrow('Upload failed: 413')
  })
})

describe('wsUrl', () => {
  const originalLocation = globalThis.location

  afterEach(() => {
    Object.defineProperty(globalThis, 'location', {
      value: originalLocation,
      writable: true,
      configurable: true,
    })
  })

  it('returns wss: URL when protocol is https:', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'https:', host: 'example.com' },
      writable: true,
      configurable: true,
    })
    expect(wsUrl()).toBe('wss://example.com/cc/')
  })

  it('returns ws: URL when protocol is http:', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'http:', host: 'localhost:3000' },
      writable: true,
      configurable: true,
    })
    expect(wsUrl()).toBe('ws://localhost:3000/cc/')
  })

  it('does not include token in the URL', () => {
    Object.defineProperty(globalThis, 'location', {
      value: { protocol: 'https:', host: 'example.com' },
      writable: true,
      configurable: true,
    })
    expect(wsUrl()).not.toContain('token')
  })
})

// ---------------------------------------------------------------------------
// Helper: create non-JSON responses for auth testing
// ---------------------------------------------------------------------------

function htmlResponse(status = 200, opts: { redirected?: boolean; url?: string } = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: opts.redirected ?? false,
    url: opts.url ?? '',
    headers: new Headers({ 'content-type': 'text/html' }),
    json: () => Promise.reject(new Error('not json')),
  } as Response
}

function opaqueRedirectResponse(): Response {
  return {
    ok: false,
    status: 0,
    type: 'opaqueredirect',
    redirected: false,
    url: '',
    headers: new Headers(),
    json: () => Promise.reject(new Error('opaque')),
  } as Response
}

function plainResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    url: '',
    headers: new Headers({ 'content-type': 'text/plain' }),
    json: () => Promise.reject(new Error('not json')),
  } as Response
}

// ---------------------------------------------------------------------------
// redirectToLogin
// ---------------------------------------------------------------------------

describe('redirectToLogin', () => {
  let hrefSetter: ReturnType<typeof vi.fn>
  const origWindow = globalThis.window

  beforeEach(() => {
    hrefSetter = vi.fn()
    const loc = {}
    Object.defineProperty(loc, 'href', {
      set: hrefSetter,
      configurable: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = { location: loc }
  })

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = origWindow
  })

  // NOTE: redirectToLogin uses a module-level `redirecting` flag.
  // The first call in this test file will set it to true,
  // and subsequent calls will be no-ops. We test both behaviors.

  it('sets window.location.href to the login URL on first call', () => {
    redirectToLogin()
    expect(hrefSetter).toHaveBeenCalledWith('/authelia/login')
  })

  it('is a no-op on subsequent calls due to module-level redirecting flag', () => {
    hrefSetter.mockClear()
    redirectToLogin()
    expect(hrefSetter).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// authFetch (tested indirectly through exported API functions)
// ---------------------------------------------------------------------------

describe('authFetch / checkAuthResponse (indirect)', () => {
  beforeEach(() => {
    const loc = {} as { href: string }
    Object.defineProperty(loc, 'href', {
      set: vi.fn(),
      configurable: true,
    })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(globalThis as any).window = { location: loc }
  })

  afterEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (globalThis as any).window
  })

  it('throws "Session expired" when response is redirected to authelia', async () => {
    mockFetch.mockResolvedValue(
      htmlResponse(200, { redirected: true, url: 'https://example.com/authelia/login' }),
    )
    await expect(listSessions('tok')).rejects.toThrow('Session expired')
  })

  it('throws "Session expired" for non-JSON 401', async () => {
    mockFetch.mockResolvedValue(plainResponse(401))
    await expect(listSessions('tok')).rejects.toThrow('Session expired')
  })

  it('throws "Session expired" for non-JSON 403', async () => {
    mockFetch.mockResolvedValue(plainResponse(403))
    await expect(listSessions('tok')).rejects.toThrow('Session expired')
  })

  it('throws "Session expired" for HTML 200 response (auth proxy intercept)', async () => {
    mockFetch.mockResolvedValue(htmlResponse(200))
    await expect(listSessions('tok')).rejects.toThrow('Session expired')
  })

  it('does NOT treat JSON 401 as auth failure (our own API error)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'unauthorized' }, 401))
    // Should not throw "Session expired" — should throw the function's own error
    await expect(verifyToken('tok')).resolves.toBe(false)
  })

  it('does NOT treat 502 as auth failure', async () => {
    mockFetch.mockResolvedValue(plainResponse(502))
    // 502 is not an auth failure, so authFetch passes through → function throws its own error
    await expect(listSessions('tok')).rejects.toThrow('Failed to list sessions: 502')
  })

  it('does NOT treat 503 as auth failure', async () => {
    mockFetch.mockResolvedValue(plainResponse(503))
    await expect(getHealth('tok')).rejects.toThrow('Health check failed: 503')
  })

  it('does NOT treat 504 as auth failure', async () => {
    mockFetch.mockResolvedValue(plainResponse(504))
    await expect(getHealth('tok')).rejects.toThrow('Health check failed: 504')
  })
})

// ---------------------------------------------------------------------------
// checkAuthSession
// ---------------------------------------------------------------------------

describe('checkAuthSession', () => {
  it('returns false for opaque redirect response', async () => {
    mockFetch.mockResolvedValue(opaqueRedirectResponse())
    expect(await checkAuthSession()).toBe(false)
  })

  it('returns false for HTML content-type response', async () => {
    mockFetch.mockResolvedValue(htmlResponse(200))
    expect(await checkAuthSession()).toBe(false)
  })

  it('returns true for JSON response (our server responded)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ valid: false }, 401))
    expect(await checkAuthSession()).toBe(true)
  })

  it('returns true for 502 (backend down, not auth failure)', async () => {
    mockFetch.mockResolvedValue(plainResponse(502))
    expect(await checkAuthSession()).toBe(true)
  })

  it('returns true for 503 (backend down, not auth failure)', async () => {
    mockFetch.mockResolvedValue(plainResponse(503))
    expect(await checkAuthSession()).toBe(true)
  })

  it('returns true for 504 (backend down, not auth failure)', async () => {
    mockFetch.mockResolvedValue(plainResponse(504))
    expect(await checkAuthSession()).toBe(true)
  })

  it('returns true on network error (not an auth failure)', async () => {
    mockFetch.mockRejectedValue(new TypeError('Failed to fetch'))
    expect(await checkAuthSession()).toBe(true)
  })

  it('calls fetch with redirect: manual', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ valid: false }, 401))
    await checkAuthSession()
    expect(mockFetch).toHaveBeenCalledWith('/cc/auth-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: '' }),
      redirect: 'manual',
    })
  })
})

// ---------------------------------------------------------------------------
// getRepoApprovals
// ---------------------------------------------------------------------------

describe('getRepoApprovals', () => {
  it('returns tools and commands from the response', async () => {
    const approvals = { tools: ['Bash', 'Read'], commands: ['npm test'] }
    mockFetch.mockResolvedValue(jsonResponse(approvals))
    const result = await getRepoApprovals('tok', '/home/dev/project')
    expect(result).toEqual(approvals)
    expect(mockFetch).toHaveBeenCalledWith(
      '/cc/api/approvals?token=tok&path=%2Fhome%2Fdev%2Fproject',
    )
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(getRepoApprovals('tok', '/tmp')).rejects.toThrow(
      'Failed to fetch approvals: 500',
    )
  })
})

// ---------------------------------------------------------------------------
// removeRepoApproval
// ---------------------------------------------------------------------------

describe('removeRepoApproval', () => {
  it('sends DELETE with tool option', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await removeRepoApproval('tok', '/home/project', { tool: 'Bash' })
    expect(mockFetch).toHaveBeenCalledWith(
      '/cc/api/approvals?token=tok&path=%2Fhome%2Fproject',
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok',
        },
        body: JSON.stringify({ tool: 'Bash' }),
      },
    )
  })

  it('sends DELETE with command option', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await removeRepoApproval('tok', '/tmp', { command: 'npm test' })
    const [, opts] = mockFetch.mock.calls[0]
    expect(JSON.parse(opts.body)).toEqual({ command: 'npm test' })
  })

  it('resolves silently on success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await expect(
      removeRepoApproval('tok', '/tmp', { tool: 'Read' }),
    ).resolves.toBeUndefined()
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 404))
    await expect(
      removeRepoApproval('tok', '/tmp', { tool: 'X' }),
    ).rejects.toThrow('Failed to remove approval: 404')
  })
})

// ---------------------------------------------------------------------------
// bulkRemoveRepoApprovals
// ---------------------------------------------------------------------------

describe('bulkRemoveRepoApprovals', () => {
  it('sends DELETE with items array in body', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    const items = [{ tool: 'Bash' }, { command: 'npm test' }]
    await bulkRemoveRepoApprovals('tok', '/home/project', items)
    expect(mockFetch).toHaveBeenCalledWith(
      '/cc/api/approvals?token=tok&path=%2Fhome%2Fproject',
      {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer tok',
        },
        body: JSON.stringify({ items }),
      },
    )
  })

  it('resolves silently on success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await expect(
      bulkRemoveRepoApprovals('tok', '/tmp', [{ tool: 'Read' }]),
    ).resolves.toBeUndefined()
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(
      bulkRemoveRepoApprovals('tok', '/tmp', [{ tool: 'X' }]),
    ).rejects.toThrow('Failed to bulk remove approvals: 500')
  })

  it('handles empty items array', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await bulkRemoveRepoApprovals('tok', '/tmp', [])
    const [, opts] = mockFetch.mock.calls[0]
    expect(JSON.parse(opts.body)).toEqual({ items: [] })
  })
})

// ---------------------------------------------------------------------------
// listArchivedSessions
// ---------------------------------------------------------------------------

describe('listArchivedSessions', () => {
  it('returns sessions array from response', async () => {
    const sessions = [{ id: 'a1', name: 'Old', workingDir: '/tmp', groupDir: null, source: 'manual', created: '2026-01-01', archivedAt: '2026-01-02', messageCount: 5 }]
    mockFetch.mockResolvedValue(jsonResponse({ sessions }))
    const result = await listArchivedSessions('tok')
    expect(result).toEqual(sessions)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/archived?token=tok')
  })

  it('returns empty array when no sessions field in response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}))
    expect(await listArchivedSessions('tok')).toEqual([])
  })

  it('appends workingDir filter when provided', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ sessions: [] }))
    await listArchivedSessions('tok', '/home/dev/project')
    expect(mockFetch).toHaveBeenCalledWith(
      '/cc/api/sessions/archived?token=tok&workingDir=%2Fhome%2Fdev%2Fproject',
    )
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(listArchivedSessions('tok')).rejects.toThrow('Failed to list archived sessions: 500')
  })
})

// ---------------------------------------------------------------------------
// getArchivedSession
// ---------------------------------------------------------------------------

describe('getArchivedSession', () => {
  it('returns the full archived session', async () => {
    const session = { id: 'a1', name: 'Old', workingDir: '/tmp', groupDir: null, source: 'manual', created: '2026-01-01', archivedAt: '2026-01-02', messageCount: 2, outputHistory: [] }
    mockFetch.mockResolvedValue(jsonResponse(session))
    const result = await getArchivedSession('tok', 'a1')
    expect(result).toEqual(session)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/archived/a1?token=tok')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 404))
    await expect(getArchivedSession('tok', 'missing')).rejects.toThrow('Failed to get archived session: 404')
  })
})

// ---------------------------------------------------------------------------
// deleteArchivedSession
// ---------------------------------------------------------------------------

describe('deleteArchivedSession', () => {
  it('resolves silently on success', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await expect(deleteArchivedSession('tok', 'a1')).resolves.toBeUndefined()
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/sessions/archived/a1?token=tok', {
      method: 'DELETE',
    })
  })

  it('encodes token in query parameter', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 200))
    await deleteArchivedSession('a=b', 'a1')
    expect(mockFetch.mock.calls[0][0]).toBe('/cc/api/sessions/archived/a1?token=a%3Db')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 404))
    await expect(deleteArchivedSession('tok', 'a1')).rejects.toThrow('Failed to delete archived session: 404')
  })
})

// ---------------------------------------------------------------------------
// getRetentionDays
// ---------------------------------------------------------------------------

describe('getRetentionDays', () => {
  it('returns the retention days from response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ days: 30 }))
    const result = await getRetentionDays('tok')
    expect(result).toBe(30)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/settings/retention?token=tok')
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 500))
    await expect(getRetentionDays('tok')).rejects.toThrow('Failed to get retention settings: 500')
  })
})

// ---------------------------------------------------------------------------
// setRetentionDays
// ---------------------------------------------------------------------------

describe('setRetentionDays', () => {
  it('sends PUT and returns updated days', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ days: 14 }))
    const result = await setRetentionDays('tok', 14)
    expect(result).toBe(14)
    expect(mockFetch).toHaveBeenCalledWith('/cc/api/settings/retention?token=tok', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer tok',
      },
      body: JSON.stringify({ days: 14 }),
    })
  })

  it('throws on non-ok response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({}, 400))
    await expect(setRetentionDays('tok', 0)).rejects.toThrow('Failed to update retention settings: 400')
  })
})
