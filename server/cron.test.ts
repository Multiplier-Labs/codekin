/** Tests for the shared cron module — nextCronMatch (matching/validation are covered via the engine and routes re-exports). */
import { describe, it, expect } from 'vitest'
import { nextCronMatch, cronMatchesDate, isValidCron } from './cron.js'

describe('nextCronMatch', () => {
  it('finds the next matching minute', () => {
    const after = new Date('2026-08-29T10:30:45Z')
    const next = nextCronMatch('* * * * *', after)
    expect(next.getTime()).toBe(new Date('2026-08-29T10:31:00Z').getTime())
  })

  it('rolls forward to the next daily slot when the time has passed today', () => {
    const after = new Date(2026, 7, 29, 10, 0, 0) // local 10:00
    const next = nextCronMatch('0 9 * * *', after) // daily at 09:00 local
    expect(next.getHours()).toBe(9)
    expect(next.getMinutes()).toBe(0)
    expect(next.getDate()).toBe(30)
  })

  it('falls back to +24h for an expression that never matches', () => {
    const after = new Date('2026-08-29T10:30:00Z')
    const next = nextCronMatch('*/0 * * * *', after) // invalid step — matches nothing
    expect(next.getTime()).toBe(after.getTime() + 86400000)
  })
})

describe('re-exported helpers', () => {
  it('cronMatchesDate and isValidCron agree on a valid expression', () => {
    expect(isValidCron('0 9 * * 1')).toBe(true)
    const monday9am = new Date(2026, 8, 7, 9, 0) // Mon Sep 7 2026, 09:00 local
    expect(cronMatchesDate('0 9 * * 1', monday9am)).toBe(true)
  })
})
