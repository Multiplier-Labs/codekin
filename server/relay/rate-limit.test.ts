/** Token-bucket limiting, backpressure thresholds, and version comparison. */
import { describe, it, expect } from 'vitest'
import { RateLimiter, MAX_BUFFERED_BYTES, isBackedUp } from './rate-limit.js'
import { compareVersions, isConnectorOutdated, parseVersion } from './connector-version.js'

describe('RateLimiter', () => {
  it('allows a burst then refuses', () => {
    const limiter = new RateLimiter({ ratePerSecond: 1, burst: 3 })
    const now = 1_000_000

    expect(limiter.tryConsume('a', now)).toBe(true)
    expect(limiter.tryConsume('a', now)).toBe(true)
    expect(limiter.tryConsume('a', now)).toBe(true)
    expect(limiter.tryConsume('a', now)).toBe(false)
    limiter.close()
  })

  it('refills over time at the configured rate', () => {
    const limiter = new RateLimiter({ ratePerSecond: 2, burst: 2 })
    const now = 1_000_000

    limiter.tryConsume('a', now)
    limiter.tryConsume('a', now)
    expect(limiter.tryConsume('a', now)).toBe(false)

    // Half a second buys exactly one token back
    expect(limiter.tryConsume('a', now + 500)).toBe(true)
    expect(limiter.tryConsume('a', now + 500)).toBe(false)
    limiter.close()
  })

  it('keeps keys independent, so one flooder cannot starve another', () => {
    const limiter = new RateLimiter({ ratePerSecond: 1, burst: 1 })
    const now = 1_000_000

    expect(limiter.tryConsume('noisy', now)).toBe(true)
    expect(limiter.tryConsume('noisy', now)).toBe(false)
    expect(limiter.tryConsume('quiet', now)).toBe(true)
    limiter.close()
  })

  it('never accumulates beyond the burst ceiling', () => {
    const limiter = new RateLimiter({ ratePerSecond: 10, burst: 2 })
    const now = 1_000_000

    limiter.tryConsume('a', now)
    // An hour of idling still only buys back `burst` tokens
    expect(limiter.tryConsume('a', now + 3_600_000)).toBe(true)
    expect(limiter.tryConsume('a', now + 3_600_000)).toBe(true)
    expect(limiter.tryConsume('a', now + 3_600_000)).toBe(false)
    limiter.close()
  })

  it('forgets a key on request', () => {
    const limiter = new RateLimiter({ ratePerSecond: 1, burst: 1 })
    limiter.tryConsume('a')
    expect(limiter.size).toBe(1)
    limiter.forget('a')
    expect(limiter.size).toBe(0)
    limiter.close()
  })
})

describe('isBackedUp', () => {
  it('trips only past the ceiling', () => {
    expect(isBackedUp({ bufferedAmount: 0 })).toBe(false)
    expect(isBackedUp({ bufferedAmount: MAX_BUFFERED_BYTES })).toBe(false)
    expect(isBackedUp({ bufferedAmount: MAX_BUFFERED_BYTES + 1 })).toBe(true)
  })
})

describe('connector versions', () => {
  it('parses plain and prerelease versions', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 })
    expect(parseVersion('0.9.0-beta.1')).toEqual({ major: 0, minor: 9, patch: 0 })
    expect(parseVersion('nonsense')).toBeNull()
    expect(parseVersion(null)).toBeNull()
  })

  it('orders versions by major, then minor, then patch', () => {
    expect(compareVersions(parseVersion('1.0.0')!, parseVersion('0.9.9')!)).toBeGreaterThan(0)
    expect(compareVersions(parseVersion('0.9.1')!, parseVersion('0.9.2')!)).toBeLessThan(0)
    expect(compareVersions(parseVersion('1.2.3')!, parseVersion('1.2.3')!)).toBe(0)
  })

  it('treats older, missing, and unparsable versions as outdated', () => {
    expect(isConnectorOutdated('0.8.0', '0.9.0')).toBe(true)
    expect(isConnectorOutdated('0.9.0', '0.9.0')).toBe(false)
    expect(isConnectorOutdated('1.0.0', '0.9.0')).toBe(false)
    // A connector that cannot state its version predates the field
    expect(isConnectorOutdated(undefined, '0.9.0')).toBe(true)
    expect(isConnectorOutdated('dev', '0.9.0')).toBe(true)
  })
})
