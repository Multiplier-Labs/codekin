/** Tests for the goal-run router — focused on the stop-verb aliases (/abort canonical, /cancel accepted). */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import express from 'express'
import type { Server } from 'http'
import type { AddressInfo } from 'net'
import { GoalRunStore } from './goal-run-store.js'
import type { GoalRunController } from './goal-run-controller.js'
import { createGoalRunRouter } from './goal-run-routes.js'

const abortRun = vi.fn(() => true)

let server: Server
let baseUrl = ''
let store: GoalRunStore

beforeAll(async () => {
  store = new GoalRunStore(':memory:')
  const app = express()
  app.use(express.json())
  app.use(
    '/api/goal-runs',
    createGoalRunRouter(
      (token) => token === 'tok',
      (req) => {
        const h = req.headers.authorization
        return h?.startsWith('Bearer ') ? h.slice(7) : undefined
      },
      store,
      { abortRun } as unknown as GoalRunController,
    ),
  )
  server = app.listen(0)
  await new Promise<void>((res) => server.once('listening', () => { res() }))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/goal-runs`
})

afterAll(async () => {
  await new Promise<void>((res) => server.close(() => { res() }))
  store.close()
})

describe('stop verbs', () => {
  it('rejects without the master token', async () => {
    const res = await fetch(`${baseUrl}/runs/r1/abort`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  it('aborts via /abort', async () => {
    const res = await fetch(`${baseUrl}/runs/r1/abort`, { method: 'POST', headers: { Authorization: 'Bearer tok' } })
    expect(res.status).toBe(200)
    expect(abortRun).toHaveBeenCalledWith('r1')
  })

  it('accepts /cancel as an alias for /abort', async () => {
    const res = await fetch(`${baseUrl}/runs/r2/cancel`, { method: 'POST', headers: { Authorization: 'Bearer tok' } })
    expect(res.status).toBe(200)
    expect(abortRun).toHaveBeenCalledWith('r2')
  })
})
