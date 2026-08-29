/** Tests for the Codekin MCP API client — request mapping, auth header, error surfacing, and env construction. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { CodekinApi } from './codekin-mcp-api.js'

interface Captured {
  method: string
  path: string
  auth: string | undefined
  body: unknown
}

let server: Server
let api: CodekinApi
const captured: Captured[] = []

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  app.use((req, res) => {
    captured.push({ method: req.method, path: req.originalUrl, auth: req.headers.authorization, body: req.body as unknown })
    if (req.originalUrl.includes('boom')) {
      res.status(500).json({ error: 'kaput' })
      return
    }
    res.json({ ok: true })
  })
  server = app.listen(0)
  await new Promise<void>((res) => server.once('listening', () => { res() }))
  api = new CodekinApi({ baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token: 'tok' })
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => { res() }))
})

function last(): Captured {
  return captured[captured.length - 1]
}

describe('CodekinApi', () => {
  it('sends the bearer token on every request', async () => {
    await api.listChildren()
    expect(last()).toMatchObject({ method: 'GET', path: '/api/orchestrator/children', auth: 'Bearer tok' })
  })

  it('maps spawnChild to POST /children with the body verbatim', async () => {
    await api.spawnChild({ repo: '/r', task: 't', branchName: 'fix/x', completionPolicy: 'pr' })
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/orchestrator/children',
      body: { repo: '/r', task: 't', branchName: 'fix/x', completionPolicy: 'pr' },
    })
  })

  it('encodes ids and query params', async () => {
    await api.getChildTranscript('a/b', 500)
    expect(last().path).toBe('/api/orchestrator/children/a%2Fb/transcript?limit=500')

    await api.listRuns({ engine: 'loop', status: 'blocked', limit: 5 })
    expect(last().path).toBe('/api/runs?engine=loop&status=blocked&limit=5')

    await api.readReport('.codekin/reports/security/x.md')
    expect(last().path).toBe('/api/orchestrator/reports/read?path=.codekin%2Freports%2Fsecurity%2Fx.md')
  })

  it('maps respondToPrompt with requestId and value', async () => {
    await api.respondToPrompt('sess-1', 'req-9', 'allow')
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/orchestrator/sessions/sess-1/respond',
      body: { requestId: 'req-9', value: 'allow' },
    })
  })

  it('surfaces non-2xx responses as errors with status and body', async () => {
    await expect(api.readReport('boom')).rejects.toThrow(/500.*kaput/s)
  })

  it('fromEnv requires the injected session env', () => {
    expect(() => CodekinApi.fromEnv({})).toThrow(/CODEKIN_PORT/)
    expect(CodekinApi.fromEnv({ CODEKIN_PORT: '1234', CODEKIN_AUTH_TOKEN: 't' })).toBeInstanceOf(CodekinApi)
  })
})
