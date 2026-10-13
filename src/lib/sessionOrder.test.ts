import { describe, it, expect } from 'vitest'
import { byLatestActivity } from './sessionOrder'
import type { Session } from '../types'

const at = (min: number) => new Date(Date.UTC(2026, 9, 13, 8, min)).toISOString()
const s = (id: string, extra: Partial<Session>): Session => ({ id, created: at(0), ...extra }) as Session

describe('byLatestActivity', () => {
  it('puts the most recent turn first, falling back to creation time', () => {
    const list = [
      s('old', { created: at(1) }),
      s('recent-turn', { created: at(0), lastTurnAt: at(30) }),
      s('new', { created: at(20) }),
    ]
    expect([...list].sort(byLatestActivity).map(x => x.id)).toEqual(['recent-turn', 'new', 'old'])
  })

  it('keeps sessions mid-turn above everything, most recent of them first', () => {
    const list = [
      s('idle-fresh', { lastTurnAt: at(50) }),
      s('long-turn', { lastTurnAt: at(5), isProcessing: true }),
      s('new-turn', { lastTurnAt: at(40), isProcessing: true }),
    ]
    expect([...list].sort(byLatestActivity).map(x => x.id)).toEqual(['new-turn', 'long-turn', 'idle-fresh'])
  })

  it('sinks an unparsable timestamp instead of scrambling the order', () => {
    const list = [s('bad', { created: 'nope' }), s('ok', { created: at(1) })]
    expect([...list].sort(byLatestActivity).map(x => x.id)).toEqual(['ok', 'bad'])
  })
})
