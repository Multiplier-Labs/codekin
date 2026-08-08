/** Connector-side allowlist and local-server proxying. */
import { describe, it, expect, vi } from 'vitest'
import {
  checkProxyRequest,
  executeProxyRequest,
  resolveLocalTarget,
} from './connector-proxy.js'
import { RELAY_ERROR } from './relay-protocol.js'

const target = { origin: 'http://127.0.0.1:32352', authToken: 'local-token' }

describe('checkProxyRequest', () => {
  it('allows read-only calls on allowlisted prefixes', () => {
    expect(checkProxyRequest({ method: 'GET', path: '/api/sessions/list' }).allowed).toBe(true)
    expect(checkProxyRequest({ method: 'GET', path: '/api/repos' }).allowed).toBe(true)
    expect(checkProxyRequest({ method: 'GET', path: '/api/claude/models' }).allowed).toBe(true)
    expect(checkProxyRequest({ method: 'HEAD', path: '/api/health' }).allowed).toBe(true)
    expect(checkProxyRequest({ method: 'get', path: '/api/sessions/list?limit=5' }).allowed).toBe(true)
    expect(checkProxyRequest({ method: 'GET', path: '/api/sessions/archived/abc' }).allowed).toBe(true)
  })

  it('refuses mutating methods', () => {
    const decision = checkProxyRequest({ method: 'POST', path: '/api/sessions/list' })
    expect(decision.allowed).toBe(false)
    expect(decision.error?.code).toBe(RELAY_ERROR.pathNotAllowed)
  })

  it('refuses paths outside the allowlist', () => {
    expect(checkProxyRequest({ method: 'GET', path: '/api/sessions/create' }).allowed).toBe(false)
    expect(checkProxyRequest({ method: 'GET', path: '/api/docs/file' }).allowed).toBe(false)
    // A prefix must match a whole segment, not a string prefix
    expect(checkProxyRequest({ method: 'GET', path: '/api/reposecret' }).allowed).toBe(false)
  })

  it('refuses paths that could escape the origin or the prefix check', () => {
    for (const path of ['//evil.example.com/api/repos', '/api/repos/../../secret', 'api/repos', '/api/repos\\x']) {
      expect(checkProxyRequest({ method: 'GET', path }).allowed).toBe(false)
    }
  })
})

describe('executeProxyRequest', () => {
  it('injects the local bearer token and relays status, headers and body', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessions: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json', 'set-cookie': 'leak=1' },
      }),
    )

    const outcome = await executeProxyRequest({ method: 'GET', path: '/api/sessions/list' }, { target, fetchImpl })

    expect(fetchImpl).toHaveBeenCalledWith(
      'http://127.0.0.1:32352/api/sessions/list',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer local-token' }),
      }),
    )
    if (!('response' in outcome)) throw new Error('expected a response')
    expect(outcome.response.status).toBe(200)
    expect(outcome.response.headers['content-type']).toBe('application/json')
    // Only allowlisted response headers cross the relay
    expect(outcome.response.headers['set-cookie']).toBeUndefined()
    expect(JSON.parse(Buffer.from(outcome.response.body!, 'base64').toString())).toEqual({ sessions: [] })
  })

  it('does not call the local server for a disallowed path', async () => {
    const fetchImpl = vi.fn()
    const outcome = await executeProxyRequest({ method: 'DELETE', path: '/api/sessions/abc' }, { target, fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect('error' in outcome && outcome.error.code).toBe(RELAY_ERROR.pathNotAllowed)
  })

  it('reports an unreachable local server as a relay error, not an HTTP status', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const outcome = await executeProxyRequest({ method: 'GET', path: '/api/health' }, { target, fetchImpl })
    expect('error' in outcome && outcome.error.code).toBe(RELAY_ERROR.localUnreachable)
  })

  it('passes through a local 401 as a real response', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const outcome = await executeProxyRequest({ method: 'GET', path: '/api/health' }, { target, fetchImpl })
    expect('response' in outcome && outcome.response.status).toBe(401)
  })
})

describe('resolveLocalTarget', () => {
  it('prefers AUTH_TOKEN and PORT from the environment', () => {
    const resolved = resolveLocalTarget({ AUTH_TOKEN: 'env-token', PORT: '40000' } as NodeJS.ProcessEnv)
    expect(resolved).toEqual({ origin: 'http://127.0.0.1:40000', authToken: 'env-token' })
  })

  it('falls back to the default local port', () => {
    const resolved = resolveLocalTarget({ AUTH_TOKEN: 'env-token', AUTH_TOKEN_FILE: '/nope' } as NodeJS.ProcessEnv)
    expect(resolved.origin).toBe('http://127.0.0.1:32352')
  })

  it('tolerates a missing token file', () => {
    const resolved = resolveLocalTarget({ AUTH_TOKEN_FILE: '/definitely/not/here' } as NodeJS.ProcessEnv)
    expect(resolved.authToken).toBe('')
  })
})
