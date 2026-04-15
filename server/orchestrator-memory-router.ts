/**
 * Memory CRUD, trust records, and notification routes for the orchestrator.
 */

import { Router } from 'express'
import type { Request } from 'express'
import { OrchestratorMemory, type MemoryType, type TrustLevel } from './orchestrator-memory.js'
import type { OrchestratorMonitor } from './orchestrator-monitor.js'

// ---------------------------------------------------------------------------
// Request body interfaces
// ---------------------------------------------------------------------------

interface MemoryUpsertBody {
  id?: string
  memoryType: MemoryType
  scope?: string | null
  title?: string | null
  content: string
  sourceRef?: string | null
  confidence?: number
  expiresAt?: string | null
  isPinned?: boolean
  tags?: string[]
}

interface TrustActionBody {
  action: string
  category: string
  repo?: string | null
}

interface TrustPinBody extends TrustActionBody {
  level: TrustLevel
}

interface NotificationMarkBody {
  ids: string[]
}

// ---------------------------------------------------------------------------
// Router factory
// ---------------------------------------------------------------------------

export function createMemoryRouter(
  verifyOrchestratorAuth: (req: Request) => boolean,
  memory: OrchestratorMemory,
  monitorRef?: { current: OrchestratorMonitor | null },
): Router {
  const router = Router()

  // -------------------------------------------------------------------------
  // Memory
  // -------------------------------------------------------------------------

  /** Search memory. */
  router.get('/api/orchestrator/memory', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const query = req.query.q as string | undefined
    const type = req.query.type as string | undefined
    const limit = parseInt(req.query.limit as string || '20', 10)

    if (query) {
      const items = memory.search(query, limit)
      res.json({ items })
    } else {
      const items = memory.list({
        memoryType: type as MemoryType | undefined,
        limit,
      })
      res.json({ items })
    }
  })

  /** Add or update a memory item. */
  router.post('/api/orchestrator/memory', (req: Request<Record<string, string>, unknown, MemoryUpsertBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { id, memoryType, scope, title, content, sourceRef, confidence, expiresAt, isPinned, tags } = req.body
    if (!memoryType || !content) {
      return res.status(400).json({ error: 'Missing required fields: memoryType, content' })
    }

    const itemId = memory.upsert({
      id,
      memoryType,
      scope: scope ?? null,
      title: title ?? null,
      content,
      sourceRef: sourceRef ?? null,
      confidence: confidence ?? 0.8,
      expiresAt: expiresAt ?? null,
      isPinned: isPinned ?? false,
      tags: tags ?? [],
    })

    res.json({ id: itemId })
  })

  /** Delete a memory item. */
  router.delete('/api/orchestrator/memory/:id', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const deleted = memory.delete(req.params.id)
    res.json({ deleted })
  })

  // -------------------------------------------------------------------------
  // Trust
  // -------------------------------------------------------------------------

  /** List all trust records. */
  router.get('/api/orchestrator/trust', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    res.json({ records: memory.listTrustRecords() })
  })

  /** Compute trust level for an action. */
  router.get('/api/orchestrator/trust/level', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, severity, repo } = req.query as Record<string, string>
    if (!action || !category) {
      return res.status(400).json({ error: 'Provide ?action=X&category=Y' })
    }

    const level = memory.computeTrustLevel(action, category, severity ?? 'medium', repo ?? null)
    res.json({ level })
  })

  /** Record an approval. */
  router.post('/api/orchestrator/trust/approve', (req: Request<Record<string, string>, unknown, TrustActionBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo } = req.body
    if (!action || !category) {
      return res.status(400).json({ error: 'Missing required fields: action, category' })
    }

    const record = memory.recordApproval(action, category, repo ?? null)
    res.json({ record })
  })

  /** Record a rejection (resets trust to ASK). */
  router.post('/api/orchestrator/trust/reject', (req: Request<Record<string, string>, unknown, TrustActionBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo } = req.body
    if (!action || !category) {
      return res.status(400).json({ error: 'Missing required fields: action, category' })
    }

    const record = memory.recordRejection(action, category, repo ?? null)
    res.json({ record })
  })

  /** Pin trust to a specific level (user override). */
  router.post('/api/orchestrator/trust/pin', (req: Request<Record<string, string>, unknown, TrustPinBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const { action, category, repo, level } = req.body
    if (!action || !category || !level) {
      return res.status(400).json({ error: 'Missing required fields: action, category, level' })
    }

    memory.pinTrust(action, category, repo ?? null, level)
    res.json({ ok: true })
  })

  /** Reset all trust records. */
  router.post('/api/orchestrator/trust/reset', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    memory.resetAllTrust()
    res.json({ ok: true })
  })

  // -------------------------------------------------------------------------
  // Notifications
  // -------------------------------------------------------------------------

  /** Get pending notifications from the monitor. */
  router.get('/api/orchestrator/notifications', (req, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const monitor = monitorRef?.current
    if (!monitor) return res.json({ notifications: [] })

    const all = req.query.all === 'true'
    res.json({ notifications: all ? monitor.getAll() : monitor.getPending() })
  })

  /** Mark notifications as delivered. */
  router.post('/api/orchestrator/notifications/mark-delivered', (req: Request<Record<string, string>, unknown, NotificationMarkBody>, res) => {
    if (!verifyOrchestratorAuth(req)) return res.status(401).json({ error: 'Unauthorized' })

    const monitor = monitorRef?.current
    if (!monitor) return res.json({ ok: true })

    const { ids } = req.body
    if (Array.isArray(ids)) monitor.markDelivered(ids)
    res.json({ ok: true })
  })

  return router
}
