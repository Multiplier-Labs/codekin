/** Tests for the unified runs router — merged feed, engine filter, and a workflow engine that is not initialized. */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { LoopStore } from './loop-store.js'
import { parseLoopRecipe } from './loop-recipe.js'
import type { WorkflowEngine, WorkflowRun } from './workflow-engine.js'
import { createRunsRouter } from './runs-routes.js'
import type { UnifiedRun } from './unified-runs.js'

const workflowRun: WorkflowRun = {
  id: 'wf-1',
  kind: 'code-review.daily',
  status: 'succeeded',
  input: { repoPath: '/repo' },
  output: null,
  error: null,
  createdAt: '2026-08-29T12:00:00.000Z',
  startedAt: null,
  completedAt: null,
}

let engineAvailable = true
const fakeEngine = { listRuns: () => [workflowRun] } as unknown as WorkflowEngine

let server: Server
let baseUrl = ''
let store: LoopStore

const recipe = parseLoopRecipe(
  `---
apiVersion: codekin.dev/v2
kind: LoopRecipe
metadata: { id: ci-autorepair, name: CI Autorepair }
agent: { provider: claude }
evaluators:
  - { id: tests, type: command, command: npm test }
budgets: { turns: 5, costUsd: 2 }
---
Green checks.
`,
  '/x.md',
  'builtin',
)

beforeAll(async () => {
  store = new LoopStore(':memory:')
  const run = store.createRun({ recipe, goal: 'g', repo: '/repo', branch: 'loop/ci', provider: 'claude' })
  store.patchRun(run.id, { state: 'done', outcome: 'canceled' })

  const app = express()
  app.use(
    '/api/runs',
    createRunsRouter(
      (token) => token === 'tok',
      (req) => {
        const h = req.headers.authorization
        return h?.startsWith('Bearer ') ? h.slice(7) : undefined
      },
      () => (engineAvailable ? fakeEngine : null),
      store,
    ),
  )
  server = app.listen(0)
  await new Promise<void>((res) => server.once('listening', () => { res() }))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/runs`
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => { res() }))
  store.close()
})

function get(path = ''): Promise<Response> {
  return fetch(`${baseUrl}${path}`, { headers: { Authorization: 'Bearer tok' } })
}

describe('GET /api/runs', () => {
  it('rejects without the master token', async () => {
    const res = await fetch(baseUrl)
    expect(res.status).toBe(401)
  })

  it('returns both engines merged, with the loop outcome folded to lifecycle status', async () => {
    const res = await get()
    const { runs } = (await res.json()) as { runs: UnifiedRun[] }
    expect(runs).toHaveLength(2)
    expect(runs.map((r) => r.engine).sort()).toEqual(['loop', 'workflow'])
    expect(runs.find((r) => r.engine === 'loop')?.status).toBe('canceled')
  })

  it('filters by engine', async () => {
    const res = await get('?engine=loop')
    const { runs } = (await res.json()) as { runs: UnifiedRun[] }
    expect(runs).toHaveLength(1)
    expect(runs[0].engine).toBe('loop')
  })

  it('rejects an unknown engine', async () => {
    expect((await get('?engine=cron')).status).toBe(400)
  })

  it('filters by canonical status', async () => {
    const res = await get('?status=canceled')
    const { runs } = (await res.json()) as { runs: UnifiedRun[] }
    expect(runs).toHaveLength(1)
    expect(runs[0].rawStatus).toBe('canceled')
  })

  it('serves loop runs alone when the workflow engine is unavailable', async () => {
    engineAvailable = false
    try {
      const res = await get()
      const { runs } = (await res.json()) as { runs: UnifiedRun[] }
      expect(runs).toHaveLength(1)
      expect(runs[0].engine).toBe('loop')
    } finally {
      engineAvailable = true
    }
  })
})
