import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createWebhookRateLimiter } from './webhook-rate-limiter.js'

function fakeReq(body: Buffer | undefined) {
  return { body } as any
}

function fakeRes() {
  const res = {
    statusCode: 200,
    body: null as any,
    status(c: number) { res.statusCode = c; return res },
    json(b: any) { res.body = b; return res },
  }
  return res as any
}

function makeBody(repo: string): Buffer {
  return Buffer.from(JSON.stringify({ repository: { full_name: repo } }))
}

describe('createWebhookRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('allows requests under the limit', () => {
    const limiter = createWebhookRateLimiter(5)
    const next = vi.fn()

    for (let i = 0; i < 5; i++) {
      const req = fakeReq(makeBody('owner/repo'))
      const res = fakeRes()
      limiter(req, res, next)
    }

    expect(next).toHaveBeenCalledTimes(5)
  })

  it('rejects request at the limit with 429', () => {
    const limiter = createWebhookRateLimiter(3)
    const next = vi.fn()

    // Fill up to the limit
    for (let i = 0; i < 3; i++) {
      limiter(fakeReq(makeBody('owner/repo')), fakeRes(), next)
    }

    expect(next).toHaveBeenCalledTimes(3)

    // Next request should be rejected
    const res = fakeRes()
    const nextRejected = vi.fn()
    limiter(fakeReq(makeBody('owner/repo')), res, nextRejected)

    expect(nextRejected).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(429)
    expect(res.body).toEqual({
      error: 'Too Many Requests',
      repo: 'owner/repo',
      retryAfter: 60,
    })
  })

  it('different repos have independent limits', () => {
    const limiter = createWebhookRateLimiter(2)
    const next = vi.fn()

    // Fill repo-a to the limit
    limiter(fakeReq(makeBody('owner/repo-a')), fakeRes(), next)
    limiter(fakeReq(makeBody('owner/repo-a')), fakeRes(), next)
    expect(next).toHaveBeenCalledTimes(2)

    // repo-b should still be allowed
    const nextB = vi.fn()
    limiter(fakeReq(makeBody('owner/repo-b')), fakeRes(), nextB)
    expect(nextB).toHaveBeenCalledTimes(1)

    // repo-a should be rejected
    const res = fakeRes()
    const nextA = vi.fn()
    limiter(fakeReq(makeBody('owner/repo-a')), res, nextA)
    expect(nextA).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(429)
  })

  it('old timestamps expire and allow new requests', () => {
    const limiter = createWebhookRateLimiter(2)
    const next = vi.fn()

    // Fill to limit
    limiter(fakeReq(makeBody('owner/repo')), fakeRes(), next)
    limiter(fakeReq(makeBody('owner/repo')), fakeRes(), next)
    expect(next).toHaveBeenCalledTimes(2)

    // Should be rejected now
    const res1 = fakeRes()
    const nextRejected = vi.fn()
    limiter(fakeReq(makeBody('owner/repo')), res1, nextRejected)
    expect(nextRejected).not.toHaveBeenCalled()
    expect(res1.statusCode).toBe(429)

    // Advance time past the 60-second window
    vi.advanceTimersByTime(61_000)

    // Should be allowed again
    const nextAllowed = vi.fn()
    limiter(fakeReq(makeBody('owner/repo')), fakeRes(), nextAllowed)
    expect(nextAllowed).toHaveBeenCalledTimes(1)
  })

  it('handles malformed body gracefully and allows request through', () => {
    const limiter = createWebhookRateLimiter(5)
    const next = vi.fn()

    // Malformed JSON buffer
    limiter(fakeReq(Buffer.from('not json')), fakeRes(), next)
    expect(next).toHaveBeenCalledTimes(1)

    // Undefined body
    limiter(fakeReq(undefined), fakeRes(), next)
    expect(next).toHaveBeenCalledTimes(2)

    // Valid JSON but no repository field
    limiter(fakeReq(Buffer.from(JSON.stringify({ action: 'completed' }))), fakeRes(), next)
    expect(next).toHaveBeenCalledTimes(3)
  })

  it('periodic cleanup removes repos with no recent timestamps', () => {
    const limiter = createWebhookRateLimiter(2)
    const next = vi.fn()

    // Add a request
    limiter(fakeReq(makeBody('owner/repo')), fakeRes(), next)
    expect(next).toHaveBeenCalledTimes(1)

    // Advance past the 60-second window so timestamps are stale
    vi.advanceTimersByTime(61_000)

    // Advance to trigger the 5-minute cleanup interval
    vi.advanceTimersByTime(5 * 60 * 1000)

    // Now fill to the limit again — should be allowed since old timestamps were cleaned
    const next2 = vi.fn()
    limiter(fakeReq(makeBody('owner/repo')), fakeRes(), next2)
    limiter(fakeReq(makeBody('owner/repo')), fakeRes(), next2)
    expect(next2).toHaveBeenCalledTimes(2)
  })
})
