/** The relay answers a client's own mistakes with 4xx, and never logs their bodies. */
import { describe, it, expect, vi, afterEach } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import { clientErrorStatus } from './client-errors.js'

describe('clientErrorStatus', () => {
  it('recognises body-parser errors and nothing else', () => {
    expect(clientErrorStatus({ status: 400, type: 'entity.parse.failed', body: '{oops' })).toBe(400)
    expect(clientErrorStatus({ statusCode: 413, type: 'entity.too.large' })).toBe(413)
    expect(clientErrorStatus(new Error('boom'))).toBeNull()
    expect(clientErrorStatus({ status: 500, type: 'x' })).toBeNull()
    expect(clientErrorStatus({ status: 404 })).toBeNull()
    expect(clientErrorStatus(null)).toBeNull()
  })
})

describe('malformed JSON through express.json', () => {
  let server: ReturnType<express.Express['listen']> | null = null
  afterEach(() => { server?.close(); server = null; vi.restoreAllMocks() })

  it('gets a 400 and leaves nothing in the log', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = express()
    app.use(express.json({ limit: '1kb' }))
    app.post('/x', (_req, res) => { res.json({ ok: true }) })
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- Express identifies error handlers by arity
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      const status = clientErrorStatus(err)
      if (status !== null) { res.status(status).json({ error: 'Malformed request body' }); return }
      console.error('[relay] Unhandled error:', err)
      res.status(500).end()
    })
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server!.once('listening', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/x`
    const bad = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"secret":"hunter2"' })
    expect(bad.status).toBe(400)
    const big = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ a: 'x'.repeat(5000) }) })
    expect(big.status).toBe(413)
    expect(logged).not.toHaveBeenCalled()
  })
})
