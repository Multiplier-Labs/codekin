/**
 * Canvas for sessions (docs/CANVAS-SPEC.md): the session-facing side of the
 * item store. Resolves files a user opens, broadcasts item lists to the
 * session's clients, records chat-card events in the transcript, and turns
 * store failures into `canvas_error` replies.
 */

import { promises as fs, realpathSync } from 'fs'
import path from 'path'
import { CANVAS_LIMITS, CanvasError, CanvasStore, canvasTypeForFile, type CanvasCreateInput } from './canvas-store.js'
import type { CanvasItem, Session, WsServerMessage } from './types.js'

export interface CanvasSessionsDeps {
  getSession: (id: string) => Session | undefined
  broadcast: (session: Session, msg: WsServerMessage) => void
  broadcastAndHistory: (session: Session, msg: WsServerMessage) => void
  /** Tell every client the session list changed (Canvas counts are on it). */
  sessionsChanged: () => void
}

/** Reply to a failed request: the store's message, or a generic one (logged). */
function errorMessage(err: unknown): string {
  if (err instanceof CanvasError) return err.message
  console.error('[canvas]', err)
  return 'The Canvas request failed.'
}

/** A path inside `root` (symlinks resolved); throws when it leaves it. */
function resolveInside(root: string, rel: unknown): string {
  if (typeof rel !== 'string' || !rel || rel.includes('\0') || path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) {
    throw new CanvasError('Open a file inside the session\'s folder.')
  }
  let realRoot: string
  let real: string
  try {
    realRoot = realpathSync(root)
    real = realpathSync(path.resolve(root, rel))
  } catch {
    throw new CanvasError(`${rel} was not found.`)
  }
  if (!real.startsWith(realRoot + path.sep)) throw new CanvasError(`${rel} is outside the session's folder.`)
  return real
}

export class CanvasSessions {
  constructor(private readonly store: CanvasStore, private readonly deps: CanvasSessionsDeps) {}

  /** Sidebar summary for a session; undefined when it has no items. */
  summary(sessionId: string): { items: number; pinnedBehind: boolean } | undefined {
    return this.store.summary(sessionId)
  }

  list(sessionId: string): WsServerMessage {
    return { type: 'canvas_items', sessionId, items: this.store.list(sessionId) }
  }

  async get(sessionId: string, itemId: string, revision?: number): Promise<WsServerMessage> {
    try {
      if (revision !== undefined && (!Number.isInteger(revision) || revision < 1)) throw new CanvasError('Invalid revision.')
      const r = await this.store.get(sessionId, itemId, revision)
      const image = r.item.kind === 'image'
      return {
        type: 'canvas_item', sessionId, item: r.item, revision: r.revision,
        content: r.content.toString(image ? 'base64' : 'utf-8'), encoding: image ? 'base64' : 'utf8',
        ...(r.meta ? { meta: r.meta } : {}),
      }
    } catch (err) {
      return {
        type: 'canvas_error', sessionId, message: errorMessage(err),
        ...(typeof itemId === 'string' ? { itemId } : {}), ...(typeof revision === 'number' ? { revision } : {}),
      }
    }
  }

  /**
   * Open a file from the session's folder, or from an attached folder
   * (`root`), as an item. Opening the same file again adds a revision when it
   * changed. Returns an error message, or null.
   */
  async openFile(sessionId: string, rel: unknown, root?: unknown): Promise<string | null> {
    const session = this.deps.getSession(sessionId)
    if (!session) return 'Session not found'
    try {
      if (root !== undefined && (typeof root !== 'string' || !session.addDirs?.includes(root))) {
        throw new CanvasError('That folder is not attached to this session.')
      }
      const base = typeof root === 'string' ? root : session.workingDir
      const file = resolveInside(base, rel)
      const relPath = path.relative(realpathSync(base), file).split(path.sep).join('/')
      const type = canvasTypeForFile(file)
      if (!type) throw new CanvasError(`Canvas can't show ${path.basename(file)} yet. It shows Markdown, CSV/TSV tables, Mermaid diagrams and images.`)
      const stat = await fs.stat(file)
      if (!stat.isFile()) throw new CanvasError(`${relPath} is not a file.`)
      const limit = type.kind === 'image' ? CANVAS_LIMITS.maxImageBytes : CANVAS_LIMITS.maxTextBytes
      if (stat.size > limit) throw new CanvasError(`${relPath} is too large for Canvas (limit ${limit / 1024 / 1024} MiB).`)
      const content = await fs.readFile(file)

      const existing = this.store.find(sessionId, i =>
        i.source.type === 'file' && i.source.path === relPath && (i.source.root ?? undefined) === (typeof root === 'string' ? root : undefined))
      if (existing) {
        const updated = await this.store.addRevision(sessionId, existing.id, { content, mediaType: type.mediaType })
        if (updated) this.changed(session, updated, 'updated')
        return null
      }
      const input: CanvasCreateInput = {
        kind: type.kind, mediaType: type.mediaType, content,
        title: path.basename(relPath),
        source: { type: 'file', path: relPath, ...(typeof root === 'string' ? { root } : {}) },
      }
      this.changed(session, await this.store.create(sessionId, input), 'created')
      return null
    } catch (err) {
      return errorMessage(err)
    }
  }

  /** Create an item for the session (agent or tool output). */
  async create(sessionId: string, input: CanvasCreateInput): Promise<CanvasItem> {
    const session = this.deps.getSession(sessionId)
    if (!session) throw new CanvasError('Session not found')
    const item = await this.store.create(sessionId, input)
    this.changed(session, item, 'created')
    return item
  }

  async pin(sessionId: string, itemId: string, revision: unknown): Promise<string | null> {
    const session = this.deps.getSession(sessionId)
    if (!session) return 'Session not found'
    try {
      if (revision !== null && (typeof revision !== 'number' || !Number.isInteger(revision))) throw new CanvasError('Invalid revision.')
      await this.store.pin(sessionId, itemId, revision)
      this.broadcastList(session)
      return null
    } catch (err) {
      return errorMessage(err)
    }
  }

  async delete(sessionId: string, itemId: string): Promise<string | null> {
    const session = this.deps.getSession(sessionId)
    if (!session) return 'Session not found'
    try {
      await this.store.delete(sessionId, itemId)
      this.broadcastList(session)
      return null
    } catch (err) {
      return errorMessage(err)
    }
  }

  /** Remove a deleted session's items. */
  removeSession(sessionId: string): void {
    void this.store.deleteSession(sessionId).catch((err: unknown) => { console.error('[canvas] Failed to remove items of', sessionId, err) })
  }

  private changed(session: Session, item: CanvasItem, action: 'created' | 'updated'): void {
    this.deps.broadcastAndHistory(session, {
      type: 'canvas_event', sessionId: session.id, itemId: item.id, kind: item.kind, title: item.title, revision: item.latest, action,
    })
    this.broadcastList(session)
  }

  private broadcastList(session: Session): void {
    this.deps.broadcast(session, this.list(session.id))
    this.deps.sessionsChanged()
  }
}
