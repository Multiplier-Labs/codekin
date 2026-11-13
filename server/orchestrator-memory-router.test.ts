/**
 * Tests for createMemoryRouter — the orchestrator memory/trust HTTP routes.
 *
 * The router is mounted on a throwaway Express app (port 0) and exercised with
 * fetch, matching the convention in orchestrator-routes.test.ts. A real
 * in-memory OrchestratorMemory backs the memory/trust routes so the handlers
 * are tested end-to-end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { Request } from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'

vi.mock('./orchestrator-manager.js', () => ({
  ORCHESTRATOR_DIR: '/tmp/codekin-orch-memrouter-test',
}))

import { createMemoryRouter } from './orchestrator-memory-router.js'
import { OrchestratorMemory } from './orchestrator-memory.js'

const TOKEN = 'good-token'
const verifyAuth = (req: Request) => req.headers['authorization'] === `Bearer ${TOKEN}`

async function startApp(router: express.Router): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const app = express()
  app.use(express.json())
  app.use(router)
  return await new Promise((resolve) => {
    const server: Server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      })
    })
  })
}

describe('createMemoryRouter', () => {
  let mem: OrchestratorMemory
  let server: { baseUrl: string; close: () => Promise<void> }

  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }

  beforeEach(async () => {
    mem = new OrchestratorMemory(':memory:')
    server = await startApp(createMemoryRouter(verifyAuth, mem))
  })

  afterEach(async () => {
    await server.close()
    mem.close()
  })

  const url = (p: string) => `${server.baseUrl}${p}`

  // -------------------------------------------------------------------------
  // Auth
  // -------------------------------------------------------------------------

  it('rejects unauthenticated requests with 401', async () => {
    const res = await fetch(url('/api/orchestrator/memory'))
    expect(res.status).toBe(401)
  })

  // -------------------------------------------------------------------------
  // Memory CRUD
  // -------------------------------------------------------------------------

  it('lists memory when no query is given', async () => {
    mem.upsert({ memoryType: 'journal', scope: null, title: 't', content: 'listed entry', sourceRef: null, confidence: 0.8, expiresAt: null, isPinned: false, tags: [] })
    const res = await fetch(url('/api/orchestrator/memory'), { headers: auth })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.items.length).toBe(1)
  })

  it('searches memory when a query is given', async () => {
    mem.upsert({ memoryType: 'journal', scope: null, title: 'kubernetes', content: 'deployment notes', sourceRef: null, confidence: 0.8, expiresAt: null, isPinned: false, tags: [] })
    const res = await fetch(url('/api/orchestrator/memory?q=kubernetes'), { headers: auth })
    const body = await res.json()
    expect(body.items.length).toBe(1)
  })

  it('upserts a memory item', async () => {
    const res = await fetch(url('/api/orchestrator/memory'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ memoryType: 'decision', content: 'we chose X' }),
    })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(typeof body.id).toBe('string')
    expect(mem.get(body.id)?.content).toBe('we chose X')
  })

  it('rejects an upsert missing required fields with 400', async () => {
    const res = await fetch(url('/api/orchestrator/memory'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ memoryType: 'decision' }),
    })
    expect(res.status).toBe(400)
  })

  it('deletes a memory item', async () => {
    const id = mem.upsert({ memoryType: 'journal', scope: null, title: 't', content: 'to delete', sourceRef: null, confidence: 0.8, expiresAt: null, isPinned: false, tags: [] })
    const res = await fetch(url(`/api/orchestrator/memory/${id}`), { method: 'DELETE', headers: auth })
    const body = await res.json()
    expect(body.deleted).toBe(true)
    expect(mem.get(id)).toBeNull()
  })

  // -------------------------------------------------------------------------
  // Trust
  // -------------------------------------------------------------------------

  it('lists trust records', async () => {
    const res = await fetch(url('/api/orchestrator/trust'), { headers: auth })
    const body = await res.json()
    expect(Array.isArray(body.records)).toBe(true)
  })

  it('computes a trust level', async () => {
    const res = await fetch(url('/api/orchestrator/trust/level?action=edit&category=code'), { headers: auth })
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(typeof body.level).toBe('string')
  })

  it('rejects trust-level requests missing action/category with 400', async () => {
    const res = await fetch(url('/api/orchestrator/trust/level?action=edit'), { headers: auth })
    expect(res.status).toBe(400)
  })

  it('records an approval', async () => {
    const res = await fetch(url('/api/orchestrator/trust/approve'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'edit', category: 'code' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).record).toBeTruthy()
  })

  it('rejects an approval missing fields with 400', async () => {
    const res = await fetch(url('/api/orchestrator/trust/approve'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'edit' }),
    })
    expect(res.status).toBe(400)
  })

  it('records a rejection', async () => {
    const res = await fetch(url('/api/orchestrator/trust/reject'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'edit', category: 'code' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).record).toBeTruthy()
  })

  it('rejects a rejection missing fields with 400', async () => {
    const res = await fetch(url('/api/orchestrator/trust/reject'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ category: 'code' }),
    })
    expect(res.status).toBe(400)
  })

  it('pins a trust level', async () => {
    const res = await fetch(url('/api/orchestrator/trust/pin'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'edit', category: 'code', level: 'always' }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })

  it('rejects a pin missing the level with 400', async () => {
    const res = await fetch(url('/api/orchestrator/trust/pin'), {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ action: 'edit', category: 'code' }),
    })
    expect(res.status).toBe(400)
  })

  it('resets all trust', async () => {
    const res = await fetch(url('/api/orchestrator/trust/reset'), { method: 'POST', headers: auth })
    expect(res.status).toBe(200)
    expect((await res.json()).ok).toBe(true)
  })
})
