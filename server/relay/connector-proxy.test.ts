/** Connector-side allowlist and local-server proxying. */
import { describe, it, expect, vi } from 'vitest'
import {
  checkProxyRequest,
  executeProxyRequest,
  resolveLocalTarget,
} from './connector-proxy.js'
import { parseShellEnvFile } from './connector-proxy.js'
import { RELAY_ERROR } from './relay-protocol.js'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const target = { origin: 'http://127.0.0.1:32352', authToken: 'local-token' }

/** The machine's owner: unrestricted, which is what these tests exercise. */
const OWNER = { userId: 'u1', role: 'owner' as const, grants: {} }

/** Attach the owner principal, since every proxied request carries one. */
function asOwner(req: { method: string; path: string; contentType?: string; body?: string }) {
  return { ...req, principal: OWNER }
}

describe('checkProxyRequest', () => {
  it('allows read-only calls on allowlisted prefixes', () => {
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/sessions/list' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/repos' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/claude/models' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'HEAD', path: '/api/health' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'get', path: '/api/sessions/list?limit=5' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/sessions/archived/abc' })).allowed).toBe(true)
  })

  it('allows the mutations the session UI performs', () => {
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/sessions/create' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'DELETE', path: '/api/sessions/abc' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/upload' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/approvals' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/clone' })).allowed).toBe(true)
  })

  it('allows the reads and mutations the Automations views perform', () => {
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/runs?limit=100' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/workflows/runs?limit=50' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/workflows/config' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/goal-runs/templates' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/workflows/runs' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'DELETE', path: '/api/workflows/config/repos/r1' })).allowed).toBe(true)
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/goal-runs/runs/g1/abort' })).allowed).toBe(true)
  })

  it('refuses mutations on read-only prefixes', () => {
    // Readable, but not writable over the relay
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/repos' })).allowed).toBe(true)
    const decision = checkProxyRequest(asOwner({ method: 'POST', path: '/api/repos' }))
    expect(decision.allowed).toBe(false)
    expect(decision.error?.code).toBe(RELAY_ERROR.pathNotAllowed)
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/docs' })).allowed).toBe(false)
    // The unified run read model has no writes, so it is not in the write list
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/runs' })).allowed).toBe(false)
  })

  it('refuses methods that are proxied for nothing', () => {
    const decision = checkProxyRequest(asOwner({ method: 'OPTIONS', path: '/api/sessions/list' }))
    expect(decision.allowed).toBe(false)
    expect(decision.error?.code).toBe(RELAY_ERROR.pathNotAllowed)
  })

  it('refuses paths outside the allowlist', () => {
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/webhooks/events' })).allowed).toBe(false)
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/clone' })).allowed).toBe(false)
    expect(checkProxyRequest(asOwner({ method: 'POST', path: '/api/integrations/github/pr-review/setup' })).allowed).toBe(false)
    // A prefix must match a whole segment, not a string prefix
    expect(checkProxyRequest(asOwner({ method: 'GET', path: '/api/reposecret' })).allowed).toBe(false)
  })

  it('refuses paths that could escape the origin or the prefix check', () => {
    for (const path of ['//evil.example.com/api/repos', '/api/repos/../../secret', 'api/repos', '/api/repos\\x']) {
      expect(checkProxyRequest(asOwner({ method: 'GET', path })).allowed).toBe(false)
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

    const outcome = await executeProxyRequest(asOwner({ method: 'GET', path: '/api/sessions/list' }), { target, fetchImpl })

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
    const outcome = await executeProxyRequest(asOwner({ method: 'DELETE', path: '/api/webhooks/config' }), { target, fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
    expect('error' in outcome && outcome.error.code).toBe(RELAY_ERROR.pathNotAllowed)
  })

  it('forwards a request body and its content type', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    await executeProxyRequest(
      asOwner({
        method: 'POST',
        path: '/api/sessions/create',
        contentType: 'application/json',
        body: Buffer.from('{"name":"x"}').toString('base64'),
      }),
      { target, fetchImpl },
    )

    const init = fetchImpl.mock.calls[0][1] as { headers: Record<string, string>; body: Buffer }
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(init.body.toString('utf-8')).toBe('{"name":"x"}')
    // The local credential is still the connector's, never the browser's
    expect(init.headers.Authorization).toBe('Bearer local-token')
  })

  it('reports an unreachable local server as a relay error, not an HTTP status', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const outcome = await executeProxyRequest(asOwner({ method: 'GET', path: '/api/health' }), { target, fetchImpl })
    expect('error' in outcome && outcome.error.code).toBe(RELAY_ERROR.localUnreachable)
  })

  it('passes through a local error status that is not 401', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Boom' }), { status: 500 }),
    )
    const outcome = await executeProxyRequest(asOwner({ method: 'GET', path: '/api/health' }), { target, fetchImpl })
    expect('response' in outcome && outcome.response.status).toBe(500)
  })
})

describe('principal enforcement', () => {
  it('refuses a request that carries no principal at all', () => {
    const decision = checkProxyRequest({ method: 'GET', path: '/api/sessions/list' })
    expect(decision.allowed).toBe(false)
    expect(decision.error?.code).toBe(RELAY_ERROR.forbidden)
  })

  const grantee = (grants: Record<string, string[]>) => ({ userId: 'u2', role: 'grantee' as const, grants })

  it('confines a grantee to the session-stream surface', () => {
    const principal = grantee({ 's1': ['view', 'send_prompt'] })
    expect(checkProxyRequest({ method: 'GET', path: '/api/sessions/list', principal }).allowed).toBe(true)
    // Machine-wide reads and writes stay with the owner
    for (const path of ['/api/repos', '/api/settings/retention', '/api/docs', '/api/approvals']) {
      const decision = checkProxyRequest({ method: 'GET', path, principal })
      expect(decision.allowed).toBe(false)
      expect(decision.error?.code).toBe(RELAY_ERROR.notPermitted)
    }
    expect(checkProxyRequest({ method: 'POST', path: '/api/sessions/create', principal }).allowed).toBe(false)
  })

  it('keeps cloning owner-only', () => {
    const decision = checkProxyRequest({
      method: 'POST', path: '/api/clone', principal: grantee({ 's1': ['view', 'upload_file'] }),
    })
    expect(decision.allowed).toBe(false)
    expect(decision.error?.code).toBe(RELAY_ERROR.notPermitted)
  })

  it('gates uploads on the upload_file permission', () => {
    expect(
      checkProxyRequest({ method: 'POST', path: '/api/upload', principal: grantee({ 's1': ['view'] }) }).allowed,
    ).toBe(false)
    expect(
      checkProxyRequest({
        method: 'POST', path: '/api/upload', principal: grantee({ 's1': ['view', 'upload_file'] }),
      }).allowed,
    ).toBe(true)
  })

  it('filters the session list down to shared sessions before it leaves the machine', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ sessions: [{ id: 's1', name: 'shared' }, { id: 's2', name: 'private' }] }),
        { status: 200, headers: { 'content-type': 'application/json', 'content-length': '77' } },
      ),
    )
    const outcome = await executeProxyRequest(
      { method: 'GET', path: '/api/sessions/list', principal: grantee({ 's1': ['view'] }) },
      { target, fetchImpl },
    )

    if (!('response' in outcome)) throw new Error('expected a response')
    const body = JSON.parse(Buffer.from(outcome.response.body!, 'base64').toString()) as {
      sessions: { id: string; name: string }[]
    }
    expect(body.sessions).toEqual([{ id: 's1', name: 'shared' }])
    // A stale content-length would make the filtered body unparsable
    expect(outcome.response.headers['content-length']).toBeUndefined()
  })

  it('leaves the owner session list untouched', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ sessions: [{ id: 's1' }, { id: 's2' }] }), { status: 200 }),
    )
    const outcome = await executeProxyRequest(asOwner({ method: 'GET', path: '/api/sessions/list' }), { target, fetchImpl })
    if (!('response' in outcome)) throw new Error('expected a response')
    const body = JSON.parse(Buffer.from(outcome.response.body!, 'base64').toString()) as { sessions: unknown[] }
    expect(body.sessions).toHaveLength(2)
  })
})

describe('resolveLocalTarget', () => {
  it('prefers AUTH_TOKEN and PORT from the environment', () => {
    const resolved = resolveLocalTarget({ AUTH_TOKEN: 'env-token', PORT: '40000' } as NodeJS.ProcessEnv, [])
    expect(resolved).toMatchObject({ origin: 'http://127.0.0.1:40000', authToken: 'env-token' })
  })

  it('falls back to the default local port', () => {
    const resolved = resolveLocalTarget({ AUTH_TOKEN: 'env-token', AUTH_TOKEN_FILE: '/nope' } as NodeJS.ProcessEnv, [])
    expect(resolved.origin).toBe('http://127.0.0.1:32352')
  })

  it('tolerates a missing token file', () => {
    const resolved = resolveLocalTarget({ AUTH_TOKEN_FILE: '/definitely/not/here' } as NodeJS.ProcessEnv, [])
    expect(resolved.authToken).toBe('')
  })

  it('takes the local WebSocket Origin from RELAY_LOCAL_ORIGIN, then CORS_ORIGIN', () => {
    // A production local server only accepts Origin === CORS_ORIGIN
    expect(
      resolveLocalTarget({
        RELAY_LOCAL_ORIGIN: 'https://explicit.example',
        CORS_ORIGIN: 'https://server.example',
      } as NodeJS.ProcessEnv, []).browserOrigin,
    ).toBe('https://explicit.example')

    expect(
      resolveLocalTarget({ CORS_ORIGIN: 'https://server.example' } as NodeJS.ProcessEnv, []).browserOrigin,
    ).toBe('https://server.example')

    // Dev: no Origin at all, which a non-production server accepts
    expect(resolveLocalTarget({} as NodeJS.ProcessEnv, []).browserOrigin).toBeUndefined()
  })
})


describe('local token discovery', () => {
  it('parses plain, exported, quoted, and commented env lines', () => {
    const parsed = parseShellEnvFile(
      [
        '# a comment',
        'export AUTH_TOKEN_FILE=/etc/token',
        'PORT="41000"',
        "CORS_ORIGIN='https://example.test'",
        '',
        'malformed-line',
      ].join('\n'),
    )
    expect(parsed).toEqual({
      AUTH_TOKEN_FILE: '/etc/token',
      PORT: '41000',
      CORS_ORIGIN: 'https://example.test',
    })
  })

  it('finds the token file a server was configured with in an env file', () => {
    // The connector runs in a shell that never saw the server's pm2 env, so
    // it has to read the same files the server was configured from.
    const dir = mkdtempSync(join(tmpdir(), 'codekin-env-'))
    const tokenPath = join(dir, 'legacy-token')
    writeFileSync(tokenPath, 'legacy-secret\n')
    const envFile = join(dir, 'env')
    writeFileSync(envFile, `export AUTH_TOKEN_FILE=${tokenPath}\nexport CORS_ORIGIN=https://ui.test\n`)

    const resolved = resolveLocalTarget({} as NodeJS.ProcessEnv, [envFile])

    expect(resolved.authToken).toBe('legacy-secret')
    expect(resolved.tokenSource).toBe(tokenPath)
    expect(resolved.browserOrigin).toBe('https://ui.test')
  })

  it('reads the connector Origin override from an env file too', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-env-'))
    const envFile = join(dir, 'env')
    writeFileSync(envFile, 'export RELAY_LOCAL_ORIGIN=https://ui.test\n')

    // Otherwise session streaming still needs the variable on every
    // invocation, which is exactly what the env file exists to avoid.
    expect(resolveLocalTarget({} as NodeJS.ProcessEnv, [envFile]).browserOrigin).toBe('https://ui.test')
  })

  it('does not let an env file override an exported process variable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-env-'))
    const envFile = join(dir, 'env')
    writeFileSync(envFile, 'export RELAY_LOCAL_ORIGIN=https://from-file.test\n')

    expect(
      resolveLocalTarget({ CORS_ORIGIN: 'https://from-env.test' } as NodeJS.ProcessEnv, [envFile]).browserOrigin,
    ).toBe('https://from-env.test')
  })

  it('lets the process environment win over an env file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codekin-env-'))
    const envFile = join(dir, 'env')
    writeFileSync(envFile, 'export AUTH_TOKEN=from-file\n')

    const resolved = resolveLocalTarget({ AUTH_TOKEN: 'from-env' } as NodeJS.ProcessEnv, [envFile])
    expect(resolved.authToken).toBe('from-env')
    expect(resolved.tokenSource).toBe('AUTH_TOKEN')
  })

  it('reports no token source when nothing is configured', () => {
    const resolved = resolveLocalTarget({ AUTH_TOKEN_FILE: '/definitely/not/here' } as NodeJS.ProcessEnv, [])
    expect(resolved.authToken).toBe('')
    expect(resolved.tokenSource).toBeUndefined()
  })
})

describe('local 401', () => {
  it('is reported as a connector token problem, not a passthrough response', async () => {
    // The connector uses the machine's own token, so a 401 is never the
    // browser user's doing — surfacing it as "unreachable" misdirects them.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 }),
    )
    const outcome = await executeProxyRequest(asOwner({ method: 'GET', path: '/api/sessions/list' }), { target, fetchImpl })

    expect('error' in outcome && outcome.error.code).toBe(RELAY_ERROR.localUnauthorized)
    expect('error' in outcome && outcome.error.message).toMatch(/AUTH_TOKEN_FILE/)
  })
})
