/** What needs the user, and when that is news: quiet, once per wait, never for what you're looking at. */
import { describe, it, expect } from 'vitest'
import { EMPTY_ATTENTION, nextAttention, notificationText, titleWithCount, type AttentionInput, type AttentionState } from './useAttentionNotifications'

const base: Omit<AttentionInput, 'sessions' | 'waiting'> = { activeSessionId: null, focused: true, includeFinished: true }

function run(steps: Array<Partial<AttentionInput> & Pick<AttentionInput, 'sessions'>>) {
  let state: AttentionState = EMPTY_ATTENTION
  return steps.map(step => {
    const out = nextAttention(state, { waiting: {}, ...base, ...step })
    state = out.state
    return out
  })
}

describe('nextAttention', () => {
  it("doesn't announce what was already pending when the page loaded", () => {
    const [first] = run([{ sessions: [{ id: 'a', name: 'api', isProcessing: false }], waiting: { a: true } }])
    expect(first.items).toEqual([{ id: 'a', name: 'api', reason: 'input' }])
    expect(first.fresh).toEqual([])
  })

  it('announces a new prompt once, and not while you are looking at that session', () => {
    const sessions = [{ id: 'a', name: 'api', isProcessing: true }, { id: 'b', name: 'web', isProcessing: true }]
    const [, second, third, fourth] = run([
      { sessions, activeSessionId: 'b' },
      { sessions, activeSessionId: 'b', waiting: { a: true, b: true } },
      { sessions, activeSessionId: 'b', waiting: { a: true, b: true } },
      { sessions, activeSessionId: 'b', waiting: { a: true, b: true }, focused: false },
    ])
    expect(second.fresh.map(i => i.id)).toEqual(['a'])
    expect(second.items.map(i => i.id)).toEqual(['a'])
    expect(third.fresh).toEqual([])
    // Switching away: the open session's prompt now counts, and is news.
    expect(fourth.fresh.map(i => i.id)).toEqual(['b'])
  })

  it('counts a finished turn until the session is opened or works again, and only if wanted', () => {
    const working = [{ id: 'a', name: 'api', isProcessing: true }]
    const idle = [{ id: 'a', name: 'api', isProcessing: false }]
    const steps = run([
      { sessions: working },
      { sessions: idle },
      { sessions: idle },
      { sessions: idle, activeSessionId: 'a' },
    ])
    expect(steps[1].fresh).toEqual([{ id: 'a', name: 'api', reason: 'finished' }])
    expect(steps[2].items).toHaveLength(1)
    expect(steps[3].items).toEqual([])
    const off = run([{ sessions: working, includeFinished: false }, { sessions: idle, includeFinished: false }])
    expect(off[1].items).toEqual([])
  })

  it('forgets sessions that went away', () => {
    const steps = run([
      { sessions: [{ id: 'a', name: 'api', isProcessing: true }] },
      { sessions: [{ id: 'a', name: 'api', isProcessing: false }] },
      { sessions: [] },
    ])
    expect(steps[2].items).toEqual([])
    expect(steps[2].state.finished.size).toBe(0)
  })
})

describe('titleWithCount', () => {
  it('puts the count in front, replaces an old one, and drops it at zero', () => {
    expect(titleWithCount('Codekin', 2)).toBe('(2) Codekin')
    expect(titleWithCount('(2) Codekin', 3)).toBe('(3) Codekin')
    expect(titleWithCount('(3) Codekin', 0)).toBe('Codekin')
    expect(titleWithCount('[STAGING] Codekin', 1)).toBe('(1) [STAGING] Codekin')
  })
})

describe('notificationText', () => {
  it('names one session, and sums up several', () => {
    expect(notificationText([{ id: 'a', name: 'api', reason: 'input' }])).toEqual({ title: 'api', body: 'Needs your input' })
    expect(notificationText([{ id: 'a', name: 'api', reason: 'finished' }]).body).toBe('Finished and waiting for you')
    expect(notificationText([
      { id: 'a', name: 'api', reason: 'input' }, { id: 'b', name: 'web', reason: 'finished' }, { id: 'c', name: 'x', reason: 'finished' },
    ])).toEqual({ title: '3 sessions are waiting for you', body: '1 needs your input' })
  })
})
