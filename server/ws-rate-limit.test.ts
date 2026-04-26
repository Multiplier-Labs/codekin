/** Tests for createMessageRateLimiter — the per-connection WS message rate limiter. */
import { describe, it, expect } from 'vitest'
import { createMessageRateLimiter } from './ws-rate-limit.js'

describe('createMessageRateLimiter', () => {
  it('allows up to the configured limit and rejects beyond it within a single window', () => {
    const t = 0
    const limiter = createMessageRateLimiter(60, 1000, () => t)

    // First 60 frames within the same window are allowed
    for (let i = 0; i < 60; i++) {
      const d = limiter.observe()
      expect(d.allowed).toBe(true)
    }

    // 61st frame is the first overflow — should warn but not yet disconnect
    const overflow = limiter.observe()
    expect(overflow.allowed).toBe(false)
    expect(overflow.firstOverflow).toBe(true)
    expect(overflow.shouldDisconnect).toBe(false)

    // Subsequent overflows should not re-emit "first overflow"
    const second = limiter.observe()
    expect(second.allowed).toBe(false)
    expect(second.firstOverflow).toBe(false)
  })

  it('disconnects clients that hammer at more than 2x the limit (regression: invalid-JSON flood bypass)', () => {
    const t = 0
    const limiter = createMessageRateLimiter(60, 1000, () => t)

    // Simulate a client blasting 100 frames in <1s — invalid or otherwise
    let firstOverflowAt = -1
    for (let i = 0; i < 100; i++) {
      const d = limiter.observe()
      if (d.firstOverflow && firstOverflowAt === -1) firstOverflowAt = i
    }

    // Limit is 60, so frame index 60 (the 61st) is the first overflow
    expect(firstOverflowAt).toBe(60)
    // Past 2x the limit (120 = 60*2 + 1) — but we only sent 100, so no
    // disconnect yet at 100. Push past the threshold:
    for (let i = 100; i <= 121; i++) limiter.observe()
    const after = limiter.observe()
    expect(after.allowed).toBe(false)
    expect(after.shouldDisconnect).toBe(true)
  })

  it('resets the counter when the window rolls over', () => {
    let t = 0
    const limiter = createMessageRateLimiter(60, 1000, () => t)
    for (let i = 0; i < 60; i++) limiter.observe()
    expect(limiter.observe().allowed).toBe(false) // overflow

    // Advance past the window
    t = 1500
    const next = limiter.observe()
    expect(next.allowed).toBe(true)
    expect(next.firstOverflow).toBe(false)
  })

  it('rolls the window for a request EXACTLY at the boundary (W5 — was off-by-one with >)', () => {
    let t = 0
    const limiter = createMessageRateLimiter(5, 1000, () => t)

    // Fill the window
    for (let i = 0; i < 5; i++) {
      expect(limiter.observe().allowed).toBe(true)
    }
    // Next call at t=0 should overflow
    expect(limiter.observe().allowed).toBe(false)

    // A request exactly at windowStart + windowMs (t=1000) should be the start
    // of a new window and therefore allowed.
    t = 1000
    const onBoundary = limiter.observe()
    expect(onBoundary.allowed).toBe(true)
    expect(onBoundary.firstOverflow).toBe(false)
  })


  it('counts every frame, including frames that would fail JSON parsing — the call site only invokes observe() once per message regardless of payload validity', () => {
    const t = 0
    const limiter = createMessageRateLimiter(5, 1000, () => t)
    // Caller pattern: observe() is invoked unconditionally per frame, before parse.
    // We simulate that by calling observe() 10 times — each call represents one
    // received frame, and the limiter must count all of them whether the body
    // would parse or not.
    const decisions = Array.from({ length: 10 }, () => limiter.observe())
    expect(decisions.slice(0, 5).every(d => d.allowed)).toBe(true)
    expect(decisions.slice(5).every(d => !d.allowed)).toBe(true)
  })
})
