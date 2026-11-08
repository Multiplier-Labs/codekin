/** Tests for relay error reporting: DSN parsing, scrubbing (no secret reaches an event), envelope delivery, limits. */
import { describe, it, expect, vi } from 'vitest'
import {
  cleanFilename,
  createErrorReporter,
  ErrorReporter,
  parseDsn,
  parseStack,
  reportFromError,
  scrubText,
  scrubValue,
} from './error-reporting.js'

/** Shaped like a machine secret / device code / session id. */
const SECRET = 'q7Zr2bX9mK4vT1nL8pW3sYc6dF0hJ5gA'

function reporter(send = vi.fn().mockResolvedValue(undefined), extra: Partial<ConstructorParameters<typeof ErrorReporter>[1]> = {}) {
  const r = new ErrorReporter(
    { envelopeUrl: 'https://errors.example.com/api/7/envelope/', publicKey: 'pubkey' },
    { release: '0.10.6', environment: 'test', platform: 'node', send, ...extra },
  )
  return { r, send }
}

describe('parseDsn', () => {
  it('maps a DSN to the envelope endpoint and public key', () => {
    expect(parseDsn('https://abc123@errors.example.com/7')).toEqual({
      envelopeUrl: 'https://errors.example.com/api/7/envelope/',
      publicKey: 'abc123',
    })
    expect(parseDsn('https://k@host.example:8443/sub/path/42')?.envelopeUrl).toBe('https://host.example:8443/sub/path/api/42/envelope/')
  })

  it.each(['', 'not a url', 'https://errors.example.com/7', 'https://k@errors.example.com/', 'ftp://k@h/1'])('rejects %j', dsn => {
    expect(parseDsn(dsn)).toBeNull()
  })

  it('leaves reporting off without a DSN', () => {
    expect(createErrorReporter(undefined, { release: '1', environment: 't', platform: 'node' })).toBeNull()
    expect(createErrorReporter('   ', { release: '1', environment: 't', platform: 'node' })).toBeNull()
  })
})

describe('scrubbing', () => {
  it.each([
    `machine secret ${SECRET} rejected`,
    `GET /api/invitations/accept?token=${SECRET.slice(0, 10)}&x=1 failed`,
    `https://app.example.com/api/auth/github/callback?code=abc&state=def`,
    `Authorization: Bearer ${SECRET.slice(0, 12)}`,
    `{"sessionId":"short1","password":"hunter2"}`,
    `otp=123456 recovery_code=ab-cd`,
  ])('removes the credential from %j', text => {
    const out = scrubText(text)
    for (const secret of [SECRET, SECRET.slice(0, 10), SECRET.slice(0, 12), 'abc&state', 'def', 'short1', 'hunter2', '123456', 'ab-cd']) {
      if (text.includes(secret)) expect(out).not.toContain(secret)
    }
  })

  it('keeps ordinary messages readable', () => {
    expect(scrubText('Cannot read properties of undefined (reading \'id\')')).toBe('Cannot read properties of undefined (reading \'id\')')
  })

  it('drops values under sensitive keys at any depth', () => {
    expect(scrubValue({ a: { machineSecret: 'x', nested: [{ cookie: 'c', ok: 'fine' }] } }))
      .toEqual({ a: { machineSecret: '[redacted]', nested: [{ cookie: '[redacted]', ok: 'fine' }] } })
  })
})

describe('stack frames', () => {
  it('parses V8 and Safari/Firefox stacks', () => {
    expect(parseStack('Error: x\n    at handle (/srv/app/server/dist/relay/a.js:10:5)\n    at /srv/app/b.js:2:3')).toEqual([
      { filename: '/srv/app/server/dist/relay/a.js', function: 'handle', lineno: 10, colno: 5 },
      { filename: '/srv/app/b.js', lineno: 2, colno: 3 },
    ])
    expect(parseStack('render@https://app.example.com/assets/index-abc.js?v=1:1:2345')).toEqual([
      { filename: 'https://app.example.com/assets/index-abc.js?v=1', function: 'render', lineno: 1, colno: 2345 },
    ])
  })

  it('keeps only a path: no origin, query, home or working directory', () => {
    expect(cleanFilename('https://app.example.com/assets/index.js?token=abc#x', '/srv/app', '/home/dev')).toBe('/assets/index.js')
    expect(cleanFilename('file:///srv/app/server/dist/relay/a.js', '/srv/app', '/home/dev')).toBe('server/dist/relay/a.js')
    expect(cleanFilename('/home/dev/other/x.js', '/srv/app', '/home/dev')).toBe('~/other/x.js')
  })
})

describe('ErrorReporter', () => {
  it('sends a Sentry envelope with the exception and nothing a secret could hide in', async () => {
    const { r, send } = reporter()
    const err = new Error(`pairing failed for code ${SECRET}`)
    expect(r.capture(reportFromError(err, { method: 'POST', route: '/api/machines/pair/approve' }))).toBe(true)

    expect(send).toHaveBeenCalledTimes(1)
    const [url, init] = send.mock.calls[0] as [string, { headers: Record<string, string>; body: string }]
    expect(url).toBe('https://errors.example.com/api/7/envelope/')
    expect(init.headers['content-type']).toBe('application/x-sentry-envelope')
    expect(init.headers['x-sentry-auth']).toContain('sentry_key=pubkey')
    expect(init.body).not.toContain(SECRET)

    const [header, item, eventLine] = init.body.trim().split('\n')
    expect(JSON.parse(item)).toEqual({ type: 'event' })
    const event = JSON.parse(eventLine) as Record<string, unknown> & { exception: { values: Array<{ type: string; value: string; stacktrace: { frames: unknown[] } }> } }
    expect(JSON.parse(header).event_id).toBe(event.event_id)
    expect(Object.keys(event).sort()).toEqual(['environment', 'event_id', 'exception', 'level', 'platform', 'release', 'tags', 'timestamp'])
    expect(event.tags).toEqual({ method: 'POST', route: '/api/machines/pair/approve' })
    expect(event.exception.values[0].type).toBe('Error')
    expect(event.exception.values[0].value).toContain('[redacted]')
    expect(event.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0)
  })

  it('truncates long messages before sending', () => {
    const { r } = reporter(undefined, { maxMessage: 200 })
    const event = r.buildEvent({ type: 'Error', message: 'x '.repeat(500), frames: [] }) as { exception: { values: Array<{ value: string }> } }
    expect(event.exception.values[0].value.length).toBeLessThanOrEqual(201)
  })

  it('scrubs stack fields and complete messages before truncation, and omits parser content', () => {
    const { r } = reporter(undefined, { maxMessage: 200 })
    const event = JSON.stringify(r.buildEvent({
      type: 'Error', message: 'x '.repeat(95) + SECRET,
      frames: [{ filename: `/assets/${SECRET}.js`, function: SECRET }],
    }))
    expect(event).not.toContain(SECRET.slice(0, 10))
    const parser = JSON.stringify(r.buildEvent({ type: 'SyntaxError', message: 'Unexpected token in confidential customer text', frames: [] }))
    expect(parser).not.toContain('confidential customer text')
  })

  it('reports HTTP refusal without logging the response body', async () => {
    const log = vi.fn()
    const { r } = reporter(vi.fn().mockResolvedValue(new Response(SECRET, { status: 503 })), { log })
    r.capture({ type: 'Error', message: 'boom', frames: [] })
    await vi.waitFor(() => expect(log).toHaveBeenCalledWith('[relay] error report not delivered: HTTP refusal'))
    expect(JSON.stringify(log.mock.calls)).not.toContain(SECRET)
  })

  it('stops sending past the per-minute budget', () => {
    const { r, send } = reporter(undefined, { maxPerMinute: 3 })
    const results = Array.from({ length: 5 }, () => r.capture({ type: 'Error', message: 'boom', frames: [] }))
    expect(results).toEqual([true, true, true, false, false])
    expect(send).toHaveBeenCalledTimes(3)
  })

  it('never throws when delivery fails, and logs without detail', async () => {
    const log = vi.fn()
    const { r } = reporter(vi.fn().mockRejectedValue(new TypeError(`fetch failed ${SECRET}`)), { log })
    expect(r.capture({ type: 'Error', message: 'boom', frames: [] })).toBe(true)
    await vi.waitFor(() => { expect(log).toHaveBeenCalled() })
    expect(log.mock.calls[0][0]).toBe('[relay] error report not delivered: transport failure')
  })
})
