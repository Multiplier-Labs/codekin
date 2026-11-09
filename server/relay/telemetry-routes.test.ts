/** Tests for the browser error tunnel: same-origin only, bounded body, scrubbed before it leaves the relay. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import type { AddressInfo } from 'net'
import type { Server } from 'http'
import { ErrorReporter } from './error-reporting.js'
import { createTelemetryRouter, parseBrowserReport, MAX_TELEMETRY_BYTES } from './telemetry-routes.js'

const ORIGIN = 'https://app.example.com'
const SECRET = 'q7Zr2bX9mK4vT1nL8pW3sYc6dF0hJ5gA'

describe('POST /api/telemetry/errors', () => {
  let server: Server
  let baseUrl: string
  let send: ReturnType<typeof vi.fn>

  async function start(withReporter: boolean) {
    send = vi.fn().mockResolvedValue(undefined)
    const reporter = withReporter
      ? new ErrorReporter(
        { envelopeUrl: 'https://errors.example.com/api/8/envelope/', publicKey: 'k' },
        { release: '0.10.6', environment: 'test', platform: 'javascript', maxMessage: 200, send },
      )
      : null
    const app = express()
    app.use(createTelemetryRouter(ORIGIN, reporter))
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', () => { resolve() }))
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  }

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => { resolve() }))
  })

  const post = (body: unknown, headers: Record<string, string> = { origin: ORIGIN }) =>
    fetch(`${baseUrl}/api/telemetry/errors`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })

  describe('with a reporter', () => {
    beforeEach(async () => { await start(true) })

    it('forwards type, scrubbed message and frames, and nothing else from the body', async () => {
      const res = await post({
        type: 'TypeError',
        message: `x is undefined; token=${SECRET}`,
        frames: [{ filename: `${ORIGIN}/assets/index-abc.js?sid=${SECRET}`, function: 'render', lineno: 1, colno: 99 }],
        transcript: 'the agent printed the API key',
        cookie: 'codekin_relay_sid=abc',
      })
      expect(res.status).toBe(204)
      expect(send).toHaveBeenCalledTimes(1)
      const body = (send.mock.calls[0][1] as { body: string }).body
      expect(body).not.toContain(SECRET)
      expect(body).not.toContain('transcript')
      expect(body).not.toContain('the agent printed')
      expect(body).not.toContain('codekin_relay_sid')
      expect(body).not.toContain('127.0.0.1')
      const event = JSON.parse(body.trim().split('\n')[2]) as { platform: string; tags: Record<string, string>; exception: { values: Array<{ type: string; stacktrace: { frames: Array<{ filename: string }> } }> } }
      expect(event.platform).toBe('javascript')
      expect(event.tags).toEqual({ source: 'browser' })
      expect(event.exception.values[0].type).toBe('TypeError')
      expect(event.exception.values[0].stacktrace.frames[0].filename).toBe('/assets/index-abc.js')
    })

    it('redacts across every ingestion truncation boundary', async () => {
      await post({
        type: 'T '.repeat(45) + SECRET, message: 'm '.repeat(95) + SECRET,
        frames: [{ filename: `/assets/${SECRET}.js`, function: 'f '.repeat(95) + SECRET }],
      })
      expect((send.mock.calls[0][1] as { body: string }).body).not.toContain(SECRET.slice(0, 10))
    })

    it('refuses other origins and cross-site fetches', async () => {
      expect((await post({ type: 'E', message: 'm' }, { origin: 'https://evil.example' })).status).toBe(403)
      expect((await post({ type: 'E', message: 'm' }, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
      // Outside a browser (no Origin at all): refused too.
      expect((await post({ type: 'E', message: 'm' }, {})).status).toBe(403)
      expect(send).not.toHaveBeenCalled()
    })

    it('rejects malformed and oversized bodies quietly', async () => {
      expect((await post({ message: 'no type' })).status).toBe(400)
      expect((await post('{oops')).status).toBe(400)
      expect((await post({ type: 'E', message: 'x'.repeat(MAX_TELEMETRY_BYTES) })).status).toBe(413)
      expect(send).not.toHaveBeenCalled()
    })
  })

  it('accepts and drops reports when no reporter is configured', async () => {
    await start(false)
    expect((await post({ type: 'Error', message: 'boom', frames: [] })).status).toBe(204)
  })
})

describe('parseBrowserReport', () => {
  it('bounds every field and ignores bad frames', () => {
    const report = parseBrowserReport({
      type: 'T '.repeat(150),
      message: 'm '.repeat(500),
      frames: [{ filename: 'a.js', lineno: 1.5 }, 'junk', { function: 'no file' }, ...Array.from({ length: 80 }, () => ({ filename: 'b.js' }))],
    })!
    expect(report.type).toHaveLength(100)
    expect(report.message).toHaveLength(200)
    expect(report.frames[0]).toEqual({ filename: 'a.js' })
    expect(report.frames.length).toBeLessThanOrEqual(50)
  })
})
