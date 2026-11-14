/**
 * Canvas for sessions (docs/CANVAS-SPEC.md): the session-facing side of the
 * item store. Resolves files a user opens, broadcasts item lists to the
 * session's clients, records chat-card events in the transcript, and turns
 * store failures into `canvas_error` replies.
 */

import { promises as fs, realpathSync } from 'fs'
import path from 'path'
import { CANVAS_KINDS, CANVAS_LIMITS, CanvasError, CanvasStore, canvasTypeForFile, type CanvasCreateInput } from './canvas-store.js'
import { SCREENSHOTS_DIR } from './config.js'
import type { McpAppCall } from './mcp-app.js'
import type { CanvasItem, CanvasItemKind, CanvasItemSource, Session, WsServerMessage } from './types.js'

/** What an agent sends to show or revise an item (canvas_show / canvas_update). */
export interface CanvasPublishInput {
  /** Revise this item instead of creating one. */
  itemId?: unknown
  title?: unknown
  kind?: unknown
  /** Inline text: Markdown, CSV/TSV/JSON rows, or Mermaid source. */
  content?: unknown
  /** A file in the session's folder (or an attached one) instead of `content`; required for images. */
  path?: unknown
  /** Table encoding of inline content (default csv). */
  format?: unknown
  /** Diagram node id → { file, line, description }. */
  nodes?: unknown
}

type AgentKind = Exclude<CanvasItemKind, 'mcp_app'>
const AGENT_KINDS = CANVAS_KINDS.filter((k): k is AgentKind => k !== 'mcp_app')

const TABLE_MEDIA: Record<string, string> = { csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json' }
const TEXT_MEDIA: Record<Exclude<CanvasItemKind, 'image' | 'table' | 'mcp_app'>, string> = { markdown: 'text/markdown', diagram: 'text/vnd.mermaid', chart: 'application/vnd.vegalite+json', html: 'text/html' }

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

/**
 * A file an agent names: relative to the session's folder, or absolute
 * inside it, an attached folder, or the screenshots folder.
 */
function resolveAgentPath(session: Session, p: unknown): string {
  if (typeof p !== 'string' || !p || p.includes('\0')) throw new CanvasError('path must be a file path.')
  if (!path.isAbsolute(p)) return resolveInside(session.workingDir, p)
  let real: string
  try {
    real = realpathSync(p)
  } catch {
    throw new CanvasError(`${p} was not found.`)
  }
  for (const root of [session.workingDir, ...(session.addDirs ?? []), SCREENSHOTS_DIR]) {
    let realRoot: string
    try { realRoot = realpathSync(root) } catch { continue }
    if (real.startsWith(realRoot + path.sep)) return real
  }
  throw new CanvasError(`${p} is outside the session's folder.`)
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
      if (!type) throw new CanvasError(`Canvas can't show ${path.basename(file)} yet. It shows Markdown, CSV/TSV tables, Mermaid diagrams, images, Vega-Lite charts (.vl.json) and HTML pages.`)
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

  /**
   * Show an item the agent made (canvas_show), or add a revision to one
   * (canvas_update, with `itemId`). Content is inline text or a file in the
   * session's folder, an attached folder, or Codekin's screenshots folder.
   * Returns the item; throws CanvasError for anything the agent should fix.
   */
  async publish(sessionId: string, input: CanvasPublishInput, source: CanvasItemSource = { type: 'agent' }): Promise<CanvasItem> {
    const session = this.deps.getSession(sessionId)
    if (!session) throw new CanvasError('Session not found')
    const existing = input.itemId !== undefined
      ? this.store.list(sessionId).find(i => i.id === input.itemId)
      : undefined
    if (input.itemId !== undefined && !existing) throw new CanvasError(`No Canvas item ${String(input.itemId)} in this session. Use canvas_show to create one.`)

    // MCP Apps come from tool calls (publishMcpApp), never from the agent's own tools.
    const kind = (existing?.kind ?? input.kind) as AgentKind | undefined
    if (!kind || !AGENT_KINDS.includes(kind)) throw new CanvasError(`kind must be one of: ${AGENT_KINDS.join(', ')}.`)
    if (input.kind !== undefined && existing && input.kind !== existing.kind) throw new CanvasError(`Item ${existing.id} is a ${existing.kind}; its kind can't change.`)
    if (input.content !== undefined && input.path !== undefined) throw new CanvasError('Pass either content or path, not both.')

    let content: Buffer | string
    let mediaType: string
    let fileName: string | undefined
    if (input.path !== undefined) {
      const file = resolveAgentPath(session, input.path)
      const type = canvasTypeForFile(file)
      const stat = await fs.stat(file)
      if (!stat.isFile()) throw new CanvasError(`${String(input.path)} is not a file.`)
      const limit = kind === 'image' ? CANVAS_LIMITS.maxImageBytes : CANVAS_LIMITS.maxTextBytes
      if (stat.size > limit) throw new CanvasError(`${String(input.path)} is too large for Canvas (limit ${limit / 1024 / 1024} MiB).`)
      content = await fs.readFile(file)
      fileName = path.basename(file)
      if (kind === 'table' && /\.json$/i.test(file)) mediaType = 'application/json'
      else if (type && type.kind === kind) mediaType = type.mediaType
      else if (kind === 'markdown' || kind === 'diagram' || kind === 'chart' || kind === 'html') mediaType = TEXT_MEDIA[kind]
      else throw new CanvasError(`${fileName} can't be shown as a ${kind}.`)
    } else {
      if (typeof input.content !== 'string') throw new CanvasError('Pass content (text) or path (a file).')
      if (kind === 'image') throw new CanvasError('Images need a path to the image file.')
      content = input.content
      if (kind === 'table') {
        const format = input.format ?? 'csv'
        if (typeof format !== 'string' || !TABLE_MEDIA[format]) throw new CanvasError('format must be csv, tsv or json.')
        mediaType = TABLE_MEDIA[format]
      } else {
        mediaType = TEXT_MEDIA[kind]
      }
    }
    const meta = input.nodes !== undefined ? { nodes: input.nodes } as CanvasCreateInput['meta'] : undefined

    if (existing) {
      const updated = await this.store.addRevision(sessionId, existing.id, {
        content, mediaType, meta, ...(input.title !== undefined ? { title: input.title as string } : {}),
      })
      if (updated) this.changed(session, updated, 'updated')
      return updated ?? existing
    }
    const title = input.title ?? fileName
    const item = await this.store.create(sessionId, { kind, title: title as string, source, content, mediaType, meta })
    this.changed(session, item, 'created')
    return item
  }

  /**
   * Show a tool call with a UI (MCP Apps) as a Canvas item: one item per
   * call, holding its input, result and UI document, so reopening it later
   * restores the view without running the tool again.
   */
  async publishMcpApp(sessionId: string, call: McpAppCall): Promise<CanvasItem | null> {
    const session = this.deps.getSession(sessionId)
    if (!session) return null
    try {
      const title = call.tool.replace(/[_-]+/g, ' ').replace(/^\w/, c => c.toUpperCase())
      const item = await this.store.create(sessionId, {
        kind: 'mcp_app',
        title,
        source: { type: 'mcp', server: call.server },
        mediaType: 'application/vnd.codekin.mcp-app+json',
        content: JSON.stringify({ ...call, at: new Date().toISOString() }),
      })
      this.changed(session, item, 'created')
      return item
    } catch (err) {
      console.warn('[canvas] Could not store the MCP App for', call.server, call.tool, err instanceof Error ? err.message : err)
      return null
    }
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
      by: item.source.type,
    })
    this.broadcastList(session)
  }

  private broadcastList(session: Session): void {
    this.deps.broadcast(session, this.list(session.id))
    this.deps.sessionsChanged()
  }
}
