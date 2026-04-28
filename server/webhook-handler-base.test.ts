import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type BaseEvent, WebhookHandlerBase } from './webhook-handler-base.js'

interface TestEvent extends BaseEvent {
  status: 'pending' | 'processing' | 'done' | 'error'
}

class TestHandler extends WebhookHandlerBase<TestEvent, TestEvent['status']> {
  constructor(timeoutMs: number, maxHistory?: number) {
    super('test', timeoutMs, maxHistory)
  }

  add(event: TestEvent): void {
    this.recordEvent(event)
  }

  setStatus(id: string, status: TestEvent['status'], error?: string): void {
    this.updateEventStatus(id, status, error)
  }

  count(status: TestEvent['status']): number {
    return this.countByStatus(status)
  }
}

function event(id: string, overrides: Partial<TestEvent> = {}): TestEvent {
  return {
    id,
    status: 'pending',
    receivedAt: new Date().toISOString(),
    ...overrides,
  }
}

describe('WebhookHandlerBase', () => {
  let handler: TestHandler

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    handler?.shutdown()
    vi.useRealTimers()
  })

  describe('ring buffer', () => {
    it('records and returns events as a copy', () => {
      handler = new TestHandler(60_000)
      handler.add(event('a'))
      handler.add(event('b'))

      const events = handler.getEvents()
      expect(events.map(e => e.id)).toEqual(['a', 'b'])

      events.push(event('c'))
      expect(handler.getEvents().map(e => e.id)).toEqual(['a', 'b'])
    })

    it('trims oldest entries past maxEventHistory', () => {
      handler = new TestHandler(60_000, 3)
      handler.add(event('a'))
      handler.add(event('b'))
      handler.add(event('c'))
      handler.add(event('d'))

      expect(handler.getEvents().map(e => e.id)).toEqual(['b', 'c', 'd'])
    })

    it('looks up events by id', () => {
      handler = new TestHandler(60_000)
      handler.add(event('x'))

      expect(handler.getEvent('x')?.id).toBe('x')
      expect(handler.getEvent('missing')).toBeUndefined()
    })
  })

  describe('updateEventStatus', () => {
    it('mutates status in place', () => {
      handler = new TestHandler(60_000)
      handler.add(event('a'))

      handler.setStatus('a', 'done')
      expect(handler.getEvent('a')?.status).toBe('done')
    })

    it('records error message when provided', () => {
      handler = new TestHandler(60_000)
      handler.add(event('a'))

      handler.setStatus('a', 'error', 'boom')
      expect(handler.getEvent('a')?.error).toBe('boom')
    })

    it('is a no-op when event not found', () => {
      handler = new TestHandler(60_000)
      expect(() => handler.setStatus('missing', 'done')).not.toThrow()
    })
  })

  describe('countByStatus', () => {
    it('counts events with matching status', () => {
      handler = new TestHandler(60_000)
      handler.add(event('a', { status: 'processing' }))
      handler.add(event('b', { status: 'processing' }))
      handler.add(event('c', { status: 'done' }))

      expect(handler.count('processing')).toBe(2)
      expect(handler.count('done')).toBe(1)
      expect(handler.count('error')).toBe(0)
    })
  })

  describe('processing watchdog', () => {
    it('marks stuck processing events as error after the timeout', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      const start = new Date('2026-04-27T12:00:00Z')
      vi.setSystemTime(start)

      handler = new TestHandler(120_000)
      handler.add(event('stuck', { status: 'processing', receivedAt: start.toISOString() }))

      vi.setSystemTime(new Date(start.getTime() + 121_000))
      vi.advanceTimersByTime(60_000)

      const ev = handler.getEvent('stuck')
      expect(ev?.status).toBe('error')
      expect(ev?.error).toBe('Processing timed out (watchdog)')
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[test] Watchdog'))
      warn.mockRestore()
    })

    it('leaves recent processing events untouched', () => {
      const start = new Date('2026-04-27T12:00:00Z')
      vi.setSystemTime(start)

      handler = new TestHandler(120_000)
      handler.add(event('fresh', { status: 'processing', receivedAt: start.toISOString() }))

      vi.advanceTimersByTime(60_000)

      expect(handler.getEvent('fresh')?.status).toBe('processing')
    })

    it('ignores non-processing events even when old', () => {
      const start = new Date('2026-04-27T12:00:00Z')
      vi.setSystemTime(start)

      handler = new TestHandler(60_000)
      handler.add(event('done', { status: 'done', receivedAt: start.toISOString() }))

      vi.setSystemTime(new Date(start.getTime() + 600_000))
      vi.advanceTimersByTime(60_000)

      expect(handler.getEvent('done')?.status).toBe('done')
    })
  })

  describe('shutdown', () => {
    it('clears the watchdog interval', () => {
      handler = new TestHandler(60_000)
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')

      handler.shutdown()

      expect(clearSpy).toHaveBeenCalled()
      clearSpy.mockRestore()
    })

    it('is idempotent', () => {
      handler = new TestHandler(60_000)
      handler.shutdown()
      expect(() => handler.shutdown()).not.toThrow()
    })
  })
})
