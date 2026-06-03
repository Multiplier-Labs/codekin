/**
 * Tests for OrchestratorMemory — the SQLite/FTS5 durable memory + trust store.
 *
 * Uses an in-memory database (`:memory:`) so each test is hermetic and leaves
 * no files behind. orchestrator-manager is mocked to supply only ORCHESTRATOR_DIR,
 * isolating this unit from the rest of the orchestrator subsystem.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./orchestrator-manager.js', () => ({
  ORCHESTRATOR_DIR: '/tmp/codekin-orch-memory-test',
}))

import { OrchestratorMemory, type MemoryItem } from './orchestrator-memory.js'

type NewItem = Omit<MemoryItem, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }

function makeItem(overrides: Partial<NewItem> = {}): NewItem {
  return {
    memoryType: 'decision',
    scope: null,
    title: 'Default title',
    content: 'Default content',
    sourceRef: null,
    confidence: 0.8,
    expiresAt: null,
    isPinned: false,
    tags: [],
    ...overrides,
  }
}

describe('OrchestratorMemory', () => {
  let mem: OrchestratorMemory

  beforeEach(() => {
    mem = new OrchestratorMemory(':memory:')
  })

  afterEach(() => {
    mem.close()
  })

  // -------------------------------------------------------------------------
  // Memory CRUD
  // -------------------------------------------------------------------------

  describe('memory CRUD', () => {
    it('round-trips all fields through upsert + get', () => {
      const id = mem.upsert(makeItem({
        memoryType: 'user_preference',
        scope: '/repos/codekin',
        title: 'Prefers terse replies',
        content: 'User asked to skip trailing summaries',
        sourceRef: 'session-123',
        confidence: 0.95,
        expiresAt: '2099-01-01T00:00:00.000Z',
        isPinned: true,
        tags: ['style', 'communication'],
      }))

      const got = mem.get(id)
      expect(got).not.toBeNull()
      expect(got).toMatchObject({
        id,
        memoryType: 'user_preference',
        scope: '/repos/codekin',
        title: 'Prefers terse replies',
        content: 'User asked to skip trailing summaries',
        sourceRef: 'session-123',
        confidence: 0.95,
        expiresAt: '2099-01-01T00:00:00.000Z',
        isPinned: true,
        tags: ['style', 'communication'],
      })
      expect(got!.createdAt).toBeTruthy()
      expect(got!.updatedAt).toBeTruthy()
    })

    it('generates an id when none is supplied', () => {
      const id = mem.upsert(makeItem())
      expect(id).toBeTruthy()
      expect(mem.get(id)).not.toBeNull()
    })

    it('updates an existing item in place when the same id is reused', () => {
      const id = mem.upsert(makeItem({ content: 'first' }))
      const sameId = mem.upsert(makeItem({ id, content: 'second' }))

      expect(sameId).toBe(id)
      expect(mem.get(id)!.content).toBe('second')
      expect(mem.list()).toHaveLength(1)
    })

    it('returns null from get for an unknown id', () => {
      expect(mem.get('nope')).toBeNull()
    })

    it('delete removes an item and reports whether anything changed', () => {
      const id = mem.upsert(makeItem())
      expect(mem.delete(id)).toBe(true)
      expect(mem.get(id)).toBeNull()
      expect(mem.delete(id)).toBe(false)
    })
  })

  // -------------------------------------------------------------------------
  // list() filters
  // -------------------------------------------------------------------------

  describe('list filters', () => {
    it('filters by memoryType', () => {
      mem.upsert(makeItem({ memoryType: 'decision', content: 'd' }))
      mem.upsert(makeItem({ memoryType: 'journal', content: 'j' }))

      const decisions = mem.list({ memoryType: 'decision' })
      expect(decisions).toHaveLength(1)
      expect(decisions[0].content).toBe('d')
    })

    it('filters by an explicit non-null scope', () => {
      mem.upsert(makeItem({ scope: '/repo/a', content: 'a' }))
      mem.upsert(makeItem({ scope: '/repo/b', content: 'b' }))

      const scoped = mem.list({ scope: '/repo/a' })
      expect(scoped).toHaveLength(1)
      expect(scoped[0].content).toBe('a')
    })

    it('filters for global (null) scope distinctly from repo-scoped items', () => {
      mem.upsert(makeItem({ scope: null, content: 'global' }))
      mem.upsert(makeItem({ scope: '/repo/a', content: 'scoped' }))

      const globals = mem.list({ scope: null })
      expect(globals).toHaveLength(1)
      expect(globals[0].content).toBe('global')
    })

    it('filters to pinned items only', () => {
      mem.upsert(makeItem({ isPinned: true, content: 'pinned' }))
      mem.upsert(makeItem({ isPinned: false, content: 'loose' }))

      const pinned = mem.list({ pinnedOnly: true })
      expect(pinned).toHaveLength(1)
      expect(pinned[0].content).toBe('pinned')
    })

    it('respects the limit', () => {
      mem.upsert(makeItem({ content: '1' }))
      mem.upsert(makeItem({ content: '2' }))
      mem.upsert(makeItem({ content: '3' }))
      expect(mem.list({ limit: 2 })).toHaveLength(2)
    })

    it('orders results by most-recently-updated first', () => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'))
        mem.upsert(makeItem({ content: 'older' }))
        vi.setSystemTime(new Date('2026-01-02T00:00:00.000Z'))
        mem.upsert(makeItem({ content: 'newer' }))

        const list = mem.list()
        expect(list.map(i => i.content)).toEqual(['newer', 'older'])
      } finally {
        vi.useRealTimers()
      }
    })
  })

  // -------------------------------------------------------------------------
  // Full-text search
  // -------------------------------------------------------------------------

  describe('search', () => {
    it('finds an item by a term in its content', () => {
      mem.upsert(makeItem({ content: 'migration rollback procedure documented' }))
      mem.upsert(makeItem({ content: 'unrelated note about styling' }))

      const hits = mem.search('rollback')
      expect(hits).toHaveLength(1)
      expect(hits[0].content).toContain('rollback')
    })

    it('finds an item by a term in its title', () => {
      mem.upsert(makeItem({ title: 'Postgres connection pooling', content: 'body' }))

      const hits = mem.search('pooling')
      expect(hits).toHaveLength(1)
      expect(hits[0].title).toBe('Postgres connection pooling')
    })

    it('returns an empty array when nothing matches', () => {
      mem.upsert(makeItem({ content: 'something concrete' }))
      expect(mem.search('zzznonexistent')).toEqual([])
    })

    it('respects the search limit', () => {
      mem.upsert(makeItem({ content: 'caching layer one' }))
      mem.upsert(makeItem({ content: 'caching layer two' }))
      mem.upsert(makeItem({ content: 'caching layer three' }))
      expect(mem.search('caching', 2)).toHaveLength(2)
    })
  })

  // -------------------------------------------------------------------------
  // expireStale
  // -------------------------------------------------------------------------

  describe('expireStale', () => {
    it('removes only items whose expiresAt is in the past', () => {
      mem.upsert(makeItem({ content: 'expired', expiresAt: '2000-01-01T00:00:00.000Z' }))
      mem.upsert(makeItem({ content: 'future', expiresAt: '2999-01-01T00:00:00.000Z' }))
      mem.upsert(makeItem({ content: 'never', expiresAt: null }))

      const removed = mem.expireStale()
      expect(removed).toBe(1)

      const remaining = mem.list().map(i => i.content).sort()
      expect(remaining).toEqual(['future', 'never'])
    })
  })

  // -------------------------------------------------------------------------
  // Trust records
  // -------------------------------------------------------------------------

  describe('trust records', () => {
    it('creates a record with defaults on first getTrust', () => {
      const trust = mem.getTrust('spawn_fix_session', 'dependency_update', null)
      expect(trust).toMatchObject({
        action: 'spawn_fix_session',
        category: 'dependency_update',
        severity: 'medium',
        repo: null,
        approvalCount: 0,
        rejectionCount: 0,
        pinnedLevel: null,
      })
      expect(trust.id).toBeTruthy()
    })

    it('returns the same persisted record on subsequent getTrust calls', () => {
      const first = mem.getTrust('a', 'b', null)
      const second = mem.getTrust('a', 'b', null)
      expect(second.id).toBe(first.id)
    })

    it('recordApproval increments approvalCount and stamps lastApprovedAt', () => {
      const t = mem.recordApproval('a', 'b', null)
      expect(t.approvalCount).toBe(1)
      expect(t.lastApprovedAt).toBeTruthy()
      // Persisted, not just returned
      expect(mem.getTrust('a', 'b', null).approvalCount).toBe(1)
    })

    it('recordRejection resets approvals, bumps rejections, and clears the pin', () => {
      mem.recordApproval('a', 'b', null)
      mem.recordApproval('a', 'b', null)
      mem.pinTrust('a', 'b', null, 'silent')

      const t = mem.recordRejection('a', 'b', null)
      expect(t.approvalCount).toBe(0)
      expect(t.rejectionCount).toBe(1)
      expect(t.pinnedLevel).toBeNull()

      const persisted = mem.getTrust('a', 'b', null)
      expect(persisted.approvalCount).toBe(0)
      expect(persisted.pinnedLevel).toBeNull()
    })

    it('resetAllTrust clears approval counts and pins', () => {
      mem.recordApproval('a', 'b', null)
      mem.pinTrust('a', 'b', null, 'silent')
      mem.resetAllTrust()

      const t = mem.getTrust('a', 'b', null)
      expect(t.approvalCount).toBe(0)
      expect(t.pinnedLevel).toBeNull()
    })
  })

  // -------------------------------------------------------------------------
  // computeTrustLevel
  // -------------------------------------------------------------------------

  describe('computeTrustLevel', () => {
    it('returns a user-pinned level regardless of approval count', () => {
      mem.pinTrust('a', 'b', null, 'silent')
      expect(mem.computeTrustLevel('a', 'b', 'low', null)).toBe('silent')
    })

    it('escalates ask → notify_do → silent for low-severity actions', () => {
      const level = () => mem.computeTrustLevel('a', 'b', 'low', null)
      expect(level()).toBe('ask') // 0 approvals
      mem.recordApproval('a', 'b', null)
      mem.recordApproval('a', 'b', null)
      expect(level()).toBe('notify_do') // 2 approvals
      mem.recordApproval('a', 'b', null)
      mem.recordApproval('a', 'b', null)
      mem.recordApproval('a', 'b', null)
      expect(level()).toBe('silent') // 5 approvals
    })

    it('never reaches silent for high-severity actions', () => {
      for (let i = 0; i < 8; i++) mem.recordApproval('a', 'b', null)
      expect(mem.computeTrustLevel('a', 'b', 'high', null)).toBe('notify_do')
      expect(mem.computeTrustLevel('a', 'b', 'critical', null)).toBe('notify_do')
    })
  })

  // -------------------------------------------------------------------------
  // Global override + listing
  // -------------------------------------------------------------------------

  describe('global override and listing', () => {
    it('falls back to a pinned global record for a repo with no specific record', () => {
      mem.pinTrust('a', 'b', null, 'silent') // global pin

      const trust = mem.getTrust('a', 'b', '/repo/x')
      expect(trust.repo).toBeNull()
      expect(trust.pinnedLevel).toBe('silent')
    })

    it('listTrustRecords includes the computed effective level', () => {
      mem.recordApproval('a', 'b', null)
      mem.recordApproval('a', 'b', null)

      const records = mem.listTrustRecords()
      expect(records).toHaveLength(1)
      expect(records[0].effectiveLevel).toBe('notify_do')
    })
  })
})
