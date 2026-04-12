/** Tests for webhook-github-setup — verifies GitHub webhook discovery and management helpers via an injectable gh runner mock. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  listRepoWebhooks,
  findCodekinWebhook,
  getWebhookDeliveries,
  previewWebhookSetup,
  pingWebhook,
  _setGhRunner,
  _resetGhRunner,
} from './webhook-github-setup.js'

describe('webhook-github-setup', () => {
  let mockGh: ReturnType<typeof vi.fn>

  beforeEach(() => {
    mockGh = vi.fn()
    _setGhRunner(mockGh)
  })

  afterEach(() => {
    _resetGhRunner()
  })

  const sampleHook = {
    id: 42,
    active: true,
    config: { url: 'https://example.com/cc/api/webhooks/github', content_type: 'json' },
    events: ['pull_request', 'workflow_run'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }

  // --- listRepoWebhooks ---

  describe('listRepoWebhooks', () => {
    it('returns parsed webhook array on success', async () => {
      mockGh.mockResolvedValue(JSON.stringify([sampleHook]))
      const result = await listRepoWebhooks('owner/repo')
      expect(result).toHaveLength(1)
      expect(result[0].id).toBe(42)
      expect(mockGh).toHaveBeenCalledWith(['api', '/repos/owner/repo/hooks', '--paginate'])
    })

    it('returns empty array on error', async () => {
      mockGh.mockRejectedValue(new Error('403 Forbidden'))
      const result = await listRepoWebhooks('owner/repo')
      expect(result).toEqual([])
    })

    it('returns empty array on non-array response', async () => {
      mockGh.mockResolvedValue(JSON.stringify({ message: 'Not Found' }))
      const result = await listRepoWebhooks('owner/repo')
      expect(result).toEqual([])
    })
  })

  // --- findCodekinWebhook ---

  describe('findCodekinWebhook', () => {
    it('returns matching webhook', async () => {
      mockGh.mockResolvedValue(JSON.stringify([sampleHook]))
      const result = await findCodekinWebhook('owner/repo', 'https://example.com/cc/api/webhooks/github')
      expect(result).not.toBeNull()
      expect(result!.id).toBe(42)
    })

    it('returns null when no match', async () => {
      mockGh.mockResolvedValue(JSON.stringify([sampleHook]))
      const result = await findCodekinWebhook('owner/repo', 'https://other.com/webhook')
      expect(result).toBeNull()
    })

    it('returns null when no hooks exist', async () => {
      mockGh.mockResolvedValue(JSON.stringify([]))
      const result = await findCodekinWebhook('owner/repo', 'https://example.com/cc/api/webhooks/github')
      expect(result).toBeNull()
    })
  })

  // --- getWebhookDeliveries ---

  describe('getWebhookDeliveries', () => {
    const sampleDelivery = {
      id: 1,
      delivered_at: '2026-04-12T10:00:00Z',
      status: 'OK',
      status_code: 200,
      event: 'ping',
      action: null,
    }

    it('returns deliveries on success', async () => {
      mockGh.mockResolvedValue(JSON.stringify([sampleDelivery]))
      const result = await getWebhookDeliveries('owner/repo', 42, 5)
      expect(result).toHaveLength(1)
      expect(result[0].status_code).toBe(200)
      expect(mockGh).toHaveBeenCalledWith(['api', '/repos/owner/repo/hooks/42/deliveries?per_page=5'])
    })

    it('returns empty array on error', async () => {
      mockGh.mockRejectedValue(new Error('not found'))
      const result = await getWebhookDeliveries('owner/repo', 42)
      expect(result).toEqual([])
    })
  })

  // --- previewWebhookSetup ---

  describe('previewWebhookSetup', () => {
    const webhookUrl = 'https://example.com/cc/api/webhooks/github'

    it('returns create when no webhook exists', async () => {
      mockGh.mockResolvedValue(JSON.stringify([]))
      const result = await previewWebhookSetup('owner/repo', webhookUrl)
      expect(result.action).toBe('create')
      expect(result.proposed.events).toContain('pull_request')
      expect(result.proposed.events).toContain('workflow_run')
    })

    it('returns none when webhook is fully configured', async () => {
      mockGh.mockResolvedValue(JSON.stringify([sampleHook]))
      const result = await previewWebhookSetup('owner/repo', webhookUrl)
      expect(result.action).toBe('none')
      expect(result.existing).toBeDefined()
    })

    it('returns update when events are missing', async () => {
      const hookMissingEvents = { ...sampleHook, events: ['push'] }
      mockGh.mockResolvedValue(JSON.stringify([hookMissingEvents]))
      const result = await previewWebhookSetup('owner/repo', webhookUrl)
      expect(result.action).toBe('update')
      expect(result.changes).toBeDefined()
      expect(result.changes!.some(c => c.includes('pull_request'))).toBe(true)
    })

    it('returns update when webhook is inactive', async () => {
      const inactiveHook = { ...sampleHook, active: false }
      mockGh.mockResolvedValue(JSON.stringify([inactiveHook]))
      const result = await previewWebhookSetup('owner/repo', webhookUrl)
      expect(result.action).toBe('update')
      expect(result.changes!.some(c => c.includes('Activate'))).toBe(true)
    })
  })

  // --- pingWebhook ---

  describe('pingWebhook', () => {
    it('returns true on success', async () => {
      mockGh.mockResolvedValue('')
      const result = await pingWebhook('owner/repo', 42)
      expect(result).toBe(true)
      expect(mockGh).toHaveBeenCalledWith([
        'api', '/repos/owner/repo/hooks/42/pings', '--method', 'POST',
      ])
    })

    it('returns false on error', async () => {
      mockGh.mockRejectedValue(new Error('404'))
      const result = await pingWebhook('owner/repo', 42)
      expect(result).toBe(false)
    })
  })
})
