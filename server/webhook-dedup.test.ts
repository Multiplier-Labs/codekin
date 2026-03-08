import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    readFileSync: vi.fn(() => '{}'),
  }
})

import { WebhookDedup, computeIdempotencyKey } from './webhook-dedup.js'
import { existsSync, writeFileSync, readFileSync } from 'fs'

describe('computeIdempotencyKey', () => {
  it('produces a deterministic sha256 hex string', () => {
    const a = computeIdempotencyKey('owner/repo', 'workflow_run', 123, 'completed', 'failure', 1)
    const b = computeIdempotencyKey('owner/repo', 'workflow_run', 123, 'completed', 'failure', 1)
    expect(a).toBe(b)
    expect(a).toMatch(/^[0-9a-f]{64}$/)
  })

  it('different inputs produce different hashes', () => {
    const a = computeIdempotencyKey('owner/repo-a', 'workflow_run', 123, 'completed', 'failure', 1)
    const b = computeIdempotencyKey('owner/repo-b', 'workflow_run', 123, 'completed', 'failure', 1)
    expect(a).not.toBe(b)
  })

  it('field order matters', () => {
    const a = computeIdempotencyKey('owner/repo', 'workflow_run', 100, 'completed', 'failure', 1)
    const b = computeIdempotencyKey('owner/repo', 'workflow_run', 100, 'completed', 'failure', 2)
    expect(a).not.toBe(b)
  })

  it('handles empty strings', () => {
    const key = computeIdempotencyKey('', '', 0, '', '', 0)
    expect(key).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('WebhookDedup', () => {
  let dedup: WebhookDedup

  beforeEach(() => {
    vi.useFakeTimers()
    vi.mocked(existsSync).mockReturnValue(false)
    dedup = new WebhookDedup()
  })

  afterEach(() => {
    dedup.shutdown()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  describe('isDuplicate', () => {
    it('returns false for the first call and records it', () => {
      expect(dedup.isDuplicate('delivery-1', 'key-1')).toBe(false)
    })

    it('returns true for a second call with the same deliveryId', () => {
      dedup.isDuplicate('delivery-1', 'key-1')
      expect(dedup.isDuplicate('delivery-1', 'key-different')).toBe(true)
    })

    it('returns true for a second call with the same idempotencyKey', () => {
      dedup.isDuplicate('delivery-1', 'key-1')
      expect(dedup.isDuplicate('delivery-different', 'key-1')).toBe(true)
    })

    it('returns false for completely different keys', () => {
      dedup.isDuplicate('delivery-1', 'key-1')
      expect(dedup.isDuplicate('delivery-2', 'key-2')).toBe(false)
    })

    it('checks only idempotencyKey when deliveryId is empty', () => {
      dedup.isDuplicate('', 'key-1')
      // Empty deliveryId is not stored in byDeliveryId
      expect(dedup.isDuplicate('', 'key-1')).toBe(true)
      expect(dedup.isDuplicate('some-delivery', 'key-1')).toBe(true)
    })
  })

  describe('TTL eviction', () => {
    it('evicts entries past the 1-hour TTL', () => {
      dedup.isDuplicate('delivery-1', 'key-1')
      expect(dedup.isDuplicate('delivery-1', 'key-1')).toBe(true)

      // Advance past 1 hour
      vi.advanceTimersByTime(61 * 60 * 1000)

      // Should be treated as new since old entry was evicted
      expect(dedup.isDuplicate('delivery-1', 'key-1')).toBe(false)
    })

    it('preserves entries within the TTL window', () => {
      dedup.isDuplicate('delivery-1', 'key-1')

      // Advance 59 minutes (within 1-hour window)
      vi.advanceTimersByTime(59 * 60 * 1000)

      expect(dedup.isDuplicate('delivery-1', 'key-1')).toBe(true)
    })

    it('evicts only stale entries in a mixed set', () => {
      dedup.isDuplicate('delivery-old', 'key-old')

      // Advance 30 minutes
      vi.advanceTimersByTime(30 * 60 * 1000)
      dedup.isDuplicate('delivery-new', 'key-new')

      // Advance another 31 minutes — old entry now past 1hr, new entry still fresh
      vi.advanceTimersByTime(31 * 60 * 1000)

      expect(dedup.isDuplicate('delivery-old', 'key-old')).toBe(false)
      expect(dedup.isDuplicate('delivery-new', 'key-new')).toBe(true)
    })
  })

  describe('max entries enforcement', () => {
    it('evicts oldest entries when exceeding 1000', () => {
      // Add 1000 entries
      for (let i = 0; i < 1000; i++) {
        dedup.isDuplicate(`d-${i}`, `k-${i}`)
      }

      // The 1001st should trigger eviction of the oldest
      dedup.isDuplicate('d-1000', 'k-1000')

      // Newest should still be tracked
      expect(dedup.isDuplicate('d-1000', 'k-1000')).toBe(true)

      // Oldest (k-0) should have been evicted
      expect(dedup.isDuplicate('d-new', 'k-0')).toBe(false)
    })
  })

  describe('disk persistence', () => {
    it('flushToDisk writes both maps as JSON', () => {
      dedup.isDuplicate('delivery-1', 'key-1')
      dedup.flushToDisk()

      expect(writeFileSync).toHaveBeenCalled()
      const call = vi.mocked(writeFileSync).mock.calls[0]
      // Written to .tmp file first
      expect(String(call[0])).toContain('webhook-dedup.json.tmp')
      const data = JSON.parse(String(call[1]))
      expect(data.byDeliveryId).toHaveProperty('delivery-1')
      expect(data.byIdempotencyKey).toHaveProperty('key-1')
    })

    it('loadFromDisk restores entries', () => {
      const saved = {
        byDeliveryId: { 'delivery-1': { processedAt: new Date().toISOString(), eventId: 'delivery-1' } },
        byIdempotencyKey: { 'key-1': { processedAt: new Date().toISOString(), eventId: 'delivery-1' } },
      }
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(saved))

      const restored = new WebhookDedup()

      expect(restored.isDuplicate('delivery-1', 'key-1')).toBe(true)
      restored.shutdown()
    })

    it('loadFromDisk evicts expired entries on startup', () => {
      const oldDate = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString()
      const saved = {
        byDeliveryId: { 'delivery-old': { processedAt: oldDate, eventId: 'delivery-old' } },
        byIdempotencyKey: { 'key-old': { processedAt: oldDate, eventId: 'delivery-old' } },
      }
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify(saved))

      const restored = new WebhookDedup()

      // Expired entries should have been evicted
      expect(restored.isDuplicate('delivery-old', 'key-old')).toBe(false)
      restored.shutdown()
    })

    it('handles missing file gracefully', () => {
      vi.mocked(existsSync).mockReturnValue(false)

      // Should not throw
      const d = new WebhookDedup()
      expect(d.isDuplicate('d-1', 'k-1')).toBe(false)
      d.shutdown()
    })

    it('handles corrupt JSON gracefully', () => {
      vi.mocked(existsSync).mockReturnValue(true)
      vi.mocked(readFileSync).mockReturnValue('not valid json{{{')

      // Should not throw
      const d = new WebhookDedup()
      expect(d.isDuplicate('d-1', 'k-1')).toBe(false)
      d.shutdown()
    })
  })

  describe('shutdown', () => {
    it('flushes to disk on shutdown', () => {
      dedup.isDuplicate('delivery-1', 'key-1')
      dedup.shutdown()

      expect(writeFileSync).toHaveBeenCalled()
    })

    it('clears the flush interval', () => {
      const clearSpy = vi.spyOn(globalThis, 'clearInterval')
      dedup.shutdown()
      expect(clearSpy).toHaveBeenCalled()
      clearSpy.mockRestore()
    })
  })
})
