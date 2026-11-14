/**
 * Canvas item store (docs/CANVAS-SPEC.md §2).
 *
 * A Canvas item is a named, revisioned output shown beside a session's chat:
 * a Markdown document, a table, a diagram or an image. Items live outside the
 * repository, under `<root>/<session>/`:
 *
 *   <itemId>.json   item metadata and per-revision kind data (atomic rename)
 *   <itemId>/<n>    content of revision n
 *
 * Metadata is held in memory (loaded once from disk) so session lists can
 * summarize every session synchronously. Writes for one session run one at a
 * time, and the in-memory copy changes only after the disk write succeeded.
 */

import { createHash, randomUUID } from 'crypto'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { promises as fs } from 'fs'
import path from 'path'
import type { CanvasItem, CanvasItemKind, CanvasItemMeta, CanvasItemSource, CanvasRevision } from './protocol.js'

export const CANVAS_LIMITS = {
  maxItems: 100,
  maxRevisions: 50,
  maxTextBytes: 1024 * 1024,
  maxImageBytes: 2 * 1024 * 1024,
  maxTitleLength: 200,
  maxDiagramNodes: 500,
  maxNodeFieldLength: 1000,
} as const

export const CANVAS_KINDS: readonly CanvasItemKind[] = ['markdown', 'table', 'diagram', 'image', 'chart', 'html']

/** Media types each kind accepts. */
const MEDIA_TYPES: Record<CanvasItemKind, readonly string[]> = {
  markdown: ['text/markdown'],
  table: ['text/csv', 'text/tab-separated-values', 'application/json'],
  diagram: ['text/vnd.mermaid'],
  image: ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml'],
  /** A Vega-Lite spec (JSON), rendered in the sandbox origin. */
  chart: ['application/vnd.vegalite+json'],
  /** A self-contained page, rendered in the sandbox origin with no network. */
  html: ['text/html'],
}

const ITEM_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A request the store refuses; the message is meant for the user. */
export class CanvasError extends Error {}

/** On disk: the wire item plus kind data per revision (sent only with that revision). */
interface StoredItem {
  item: CanvasItem
  /** Revision number → kind data. JSON keys are strings on disk; numbers index them the same way. */
  meta: Record<number, CanvasItemMeta | undefined>
}

/** Content for a new item or revision. */
export interface CanvasContentInput {
  content: Buffer | string
  mediaType: string
  meta?: CanvasItemMeta
}

export interface CanvasCreateInput extends CanvasContentInput {
  kind: CanvasItemKind
  title: string
  source: CanvasItemSource
}

export interface CanvasRevisionContent {
  item: CanvasItem
  revision: number
  content: Buffer
  meta?: CanvasItemMeta
}

/** Kind and media type for a file opened in Canvas, by extension; null when unsupported. */
export function canvasTypeForFile(file: string): { kind: CanvasItemKind; mediaType: string } | null {
  const lower = file.toLowerCase()
  if (lower.endsWith('.vl.json') || lower.endsWith('.vegalite.json')) return { kind: 'chart', mediaType: 'application/vnd.vegalite+json' }
  const ext = path.extname(file).toLowerCase()
  switch (ext) {
    case '.md': case '.markdown': case '.mdx': return { kind: 'markdown', mediaType: 'text/markdown' }
    case '.csv': return { kind: 'table', mediaType: 'text/csv' }
    case '.tsv': return { kind: 'table', mediaType: 'text/tab-separated-values' }
    case '.mmd': case '.mermaid': return { kind: 'diagram', mediaType: 'text/vnd.mermaid' }
    case '.png': return { kind: 'image', mediaType: 'image/png' }
    case '.jpg': case '.jpeg': return { kind: 'image', mediaType: 'image/jpeg' }
    case '.gif': return { kind: 'image', mediaType: 'image/gif' }
    case '.webp': return { kind: 'image', mediaType: 'image/webp' }
    case '.svg': return { kind: 'image', mediaType: 'image/svg+xml' }
    case '.html': case '.htm': return { kind: 'html', mediaType: 'text/html' }
    default: return null
  }
}

/** Whether image bytes match their declared type (so text can't pose as an image). */
function imageMatches(mediaType: string, buf: Buffer): boolean {
  switch (mediaType) {
    case 'image/png': return buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    case 'image/jpeg': return buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff
    case 'image/gif': return /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))
    case 'image/webp': return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP'
    case 'image/svg+xml': {
      const text = decodeUtf8(buf)
      return text !== null && /<svg[\s>]/i.test(text.slice(0, 4096))
    }
    default: return false
  }
}

function decodeUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
}

function checkTitle(title: unknown): string {
  if (typeof title !== 'string' || !title.trim()) throw new CanvasError('An item needs a title.')
  const trimmed = title.trim().replace(/\s+/g, ' ')
  if (trimmed.length > CANVAS_LIMITS.maxTitleLength) throw new CanvasError(`A title can be at most ${CANVAS_LIMITS.maxTitleLength} characters.`)
  return trimmed
}

function checkMeta(kind: CanvasItemKind, meta: unknown): CanvasItemMeta | undefined {
  if (meta === undefined || meta === null) return undefined
  if (kind !== 'diagram' || typeof meta !== 'object') throw new CanvasError(`A ${kind} item takes no extra data.`)
  const nodes = (meta as { nodes?: unknown }).nodes
  if (nodes === undefined) return undefined
  if (typeof nodes !== 'object' || nodes === null || Array.isArray(nodes)) throw new CanvasError('Diagram nodes must be an object keyed by node id.')
  const entries = Object.entries(nodes as Record<string, unknown>)
  if (entries.length > CANVAS_LIMITS.maxDiagramNodes) throw new CanvasError(`A diagram can describe at most ${CANVAS_LIMITS.maxDiagramNodes} nodes.`)
  const out: NonNullable<CanvasItemMeta['nodes']> = {}
  const str = (v: unknown, what: string): string | undefined => {
    if (v === undefined) return undefined
    if (typeof v !== 'string' || v.length > CANVAS_LIMITS.maxNodeFieldLength) throw new CanvasError(`Diagram node ${what} must be text of at most ${CANVAS_LIMITS.maxNodeFieldLength} characters.`)
    return v
  }
  for (const [id, value] of entries) {
    if (!id || id.length > 200 || typeof value !== 'object' || value === null) throw new CanvasError('Each diagram node needs an id and an object.')
    const v = value as { file?: unknown; line?: unknown; description?: unknown }
    if (v.line !== undefined && (!Number.isInteger(v.line) || (v.line as number) < 1)) throw new CanvasError('Diagram node line must be a positive integer.')
    const file = str(v.file, 'file')
    const description = str(v.description, 'description')
    out[id] = {
      ...(file !== undefined ? { file } : {}),
      ...(v.line !== undefined ? { line: v.line as number } : {}),
      ...(description !== undefined ? { description } : {}),
    }
  }
  return { nodes: out }
}

/** Validate content for a kind; returns the bytes to store. */
function checkContent(kind: CanvasItemKind, input: CanvasContentInput): Buffer {
  if (!MEDIA_TYPES[kind].includes(input.mediaType)) {
    throw new CanvasError(`A ${kind} item can't hold ${input.mediaType}.`)
  }
  const buf = typeof input.content === 'string' ? Buffer.from(input.content, 'utf-8') : input.content
  if (!Buffer.isBuffer(buf)) throw new CanvasError('Missing content.')
  if (kind === 'image') {
    if (buf.length > CANVAS_LIMITS.maxImageBytes) throw new CanvasError(`Images can be at most ${CANVAS_LIMITS.maxImageBytes / 1024 / 1024} MiB.`)
    if (!imageMatches(input.mediaType, buf)) throw new CanvasError(`The content is not a valid ${input.mediaType} image.`)
    return buf
  }
  if (buf.length > CANVAS_LIMITS.maxTextBytes) throw new CanvasError(`Text items can be at most ${CANVAS_LIMITS.maxTextBytes / 1024 / 1024} MiB.`)
  const text = decodeUtf8(buf)
  if (text === null) throw new CanvasError('Text items must be UTF-8.')
  if (input.mediaType === 'application/vnd.vegalite+json') {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new CanvasError('The chart spec does not parse as JSON.') }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new CanvasError('A chart must be a Vega-Lite spec: a JSON object.')
  }
  if (input.mediaType === 'application/json') {
    let parsed: unknown
    try { parsed = JSON.parse(text) } catch { throw new CanvasError('The table JSON does not parse.') }
    if (!Array.isArray(parsed) || !parsed.every(r => typeof r === 'object' && r !== null && !Array.isArray(r))) {
      throw new CanvasError('A JSON table must be an array of objects.')
    }
  }
  return buf
}

/** Directory name for a session id; ids that aren't path-safe are hashed. */
function sessionDirName(sessionId: string): string {
  return /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
    ? sessionId
    : `h-${createHash('sha256').update(sessionId).digest('hex').slice(0, 40)}`
}

function isStoredItem(v: unknown): v is StoredItem {
  // Parsed from disk: check every level before trusting the declared type.
  if (typeof v !== 'object' || v === null) return false
  const { item, meta } = v as { item?: unknown; meta?: unknown }
  if (typeof item !== 'object' || item === null || typeof meta !== 'object' || meta === null) return false
  const { id, kind, revisions } = item as { id?: unknown; kind?: unknown; revisions?: unknown }
  return typeof id === 'string' && ITEM_ID_RE.test(id) && CANVAS_KINDS.includes(kind as CanvasItemKind) && Array.isArray(revisions)
}

export class CanvasStore {
  private readonly root: string
  /** session id → item id → stored item; filled from disk on first use. */
  private sessions: Map<string, Map<string, StoredItem>> | null = null
  private readonly queues = new Map<string, Promise<unknown>>()

  constructor(root: string) {
    this.root = root
  }

  // --- reads ---------------------------------------------------------------

  /** Items of a session, oldest first. */
  list(sessionId: string): CanvasItem[] {
    const items = this.loaded().get(sessionId)
    if (!items) return []
    return [...items.values()].map(s => s.item).sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  /** Sidebar summary; undefined when the session has no items. */
  summary(sessionId: string): { items: number; pinnedBehind: boolean } | undefined {
    const items = this.loaded().get(sessionId)
    if (!items?.size) return undefined
    let pinnedBehind = false
    for (const { item } of items.values()) {
      if (item.pinnedRevision !== undefined && item.latest > item.pinnedRevision) pinnedBehind = true
    }
    return { items: items.size, pinnedBehind }
  }

  find(sessionId: string, predicate: (item: CanvasItem) => boolean): CanvasItem | undefined {
    for (const { item } of this.loaded().get(sessionId)?.values() ?? []) {
      if (predicate(item)) return item
    }
    return undefined
  }

  /** One revision's content (the latest when `revision` is omitted). */
  async get(sessionId: string, itemId: string, revision?: number): Promise<CanvasRevisionContent> {
    const stored = this.stored(sessionId, itemId)
    const n = revision ?? stored.item.latest
    if (!stored.item.revisions.some(r => r.n === n)) throw new CanvasError(`Revision ${n} of "${stored.item.title}" is no longer available.`)
    const content = await fs.readFile(this.contentPath(sessionId, itemId, n))
    const meta = stored.meta[n]
    return { item: stored.item, revision: n, content, ...(meta ? { meta } : {}) }
  }

  // --- writes --------------------------------------------------------------

  async create(sessionId: string, input: CanvasCreateInput): Promise<CanvasItem> {
    if (!CANVAS_KINDS.includes(input.kind)) throw new CanvasError(`Unknown item kind: ${input.kind as string}`)
    const title = checkTitle(input.title)
    const content = checkContent(input.kind, input)
    const meta = checkMeta(input.kind, input.meta)
    return this.serial(sessionId, async () => {
      const items = this.sessionItems(sessionId)
      if (items.size >= CANVAS_LIMITS.maxItems) throw new CanvasError(`A session can hold at most ${CANVAS_LIMITS.maxItems} Canvas items. Delete some first.`)
      const now = new Date().toISOString()
      const id = randomUUID()
      const stored: StoredItem = {
        item: {
          id, kind: input.kind, title, source: input.source,
          revisions: [{ n: 1, createdAt: now, size: content.length, mediaType: input.mediaType }],
          latest: 1, createdAt: now, updatedAt: now,
        },
        meta: meta ? { 1: meta } : {},
      }
      await fs.mkdir(path.join(this.sessionDir(sessionId), id), { recursive: true, mode: 0o700 })
      await fs.writeFile(this.contentPath(sessionId, id, 1), content)
      await this.writeMeta(sessionId, stored)
      items.set(id, stored)
      return stored.item
    })
  }

  /** Add a revision. Returns null (and stores nothing) when the content is unchanged. */
  async addRevision(sessionId: string, itemId: string, input: CanvasContentInput & { title?: string }): Promise<CanvasItem | null> {
    const current = this.stored(sessionId, itemId)
    const content = checkContent(current.item.kind, input)
    const meta = checkMeta(current.item.kind, input.meta)
    const title = input.title !== undefined ? checkTitle(input.title) : undefined
    return this.serial(sessionId, async () => {
      const stored = this.stored(sessionId, itemId)
      const latest = stored.item.revisions.at(-1)
      if (latest && latest.size === content.length && latest.mediaType === input.mediaType &&
          (title === undefined || title === stored.item.title) &&
          JSON.stringify(meta ?? null) === JSON.stringify(stored.meta[latest.n] ?? null)) {
        const previous = await fs.readFile(this.contentPath(sessionId, itemId, latest.n)).catch(() => null)
        if (previous?.equals(content)) return null
      }
      const n = stored.item.latest + 1
      const now = new Date().toISOString()
      const revisions: CanvasRevision[] = [...stored.item.revisions, { n, createdAt: now, size: content.length, mediaType: input.mediaType }]
      const dropped = pruneRevisions(revisions, stored.item.pinnedRevision)
      const next: StoredItem = {
        item: { ...stored.item, ...(title ? { title } : {}), revisions: revisions.filter(r => !dropped.includes(r.n)), latest: n, updatedAt: now },
        meta: Object.fromEntries(Object.entries({ ...stored.meta, ...(meta ? { [n]: meta } : {}) })
          .filter(([k]) => !dropped.includes(Number(k)))),
      }
      await fs.writeFile(this.contentPath(sessionId, itemId, n), content)
      await this.writeMeta(sessionId, next)
      this.sessionItems(sessionId).set(itemId, next)
      await Promise.all(dropped.map(d => fs.rm(this.contentPath(sessionId, itemId, d), { force: true })))
      return next.item
    })
  }

  /** Pin at a revision (null unpins). */
  async pin(sessionId: string, itemId: string, revision: number | null): Promise<CanvasItem> {
    return this.serial(sessionId, async () => {
      const stored = this.stored(sessionId, itemId)
      if (revision !== null && !stored.item.revisions.some(r => r.n === revision)) {
        throw new CanvasError(`Revision ${revision} of "${stored.item.title}" is not available.`)
      }
      const item: CanvasItem = { ...stored.item }
      if (revision === null) delete item.pinnedRevision
      else item.pinnedRevision = revision
      const next = { ...stored, item }
      await this.writeMeta(sessionId, next)
      this.sessionItems(sessionId).set(itemId, next)
      return item
    })
  }

  async delete(sessionId: string, itemId: string): Promise<void> {
    this.stored(sessionId, itemId)
    await this.serial(sessionId, async () => {
      const dir = this.sessionDir(sessionId)
      await fs.rm(path.join(dir, `${itemId}.json`), { force: true })
      await fs.rm(path.join(dir, itemId), { recursive: true, force: true })
      this.loaded().get(sessionId)?.delete(itemId)
    })
  }

  /** Remove every item of a session (when the session is deleted). */
  async deleteSession(sessionId: string): Promise<void> {
    await this.serial(sessionId, async () => {
      this.loaded().delete(sessionId)
      await fs.rm(this.sessionDir(sessionId), { recursive: true, force: true })
    })
  }

  // --- internals -----------------------------------------------------------

  private loaded(): Map<string, Map<string, StoredItem>> {
    if (this.sessions) return this.sessions
    const sessions = new Map<string, Map<string, StoredItem>>()
    this.sessions = sessions
    // An unreadable store must not break session lists: start empty instead.
    const list = (dir: string) => {
      try {
        return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : []
      } catch (err) {
        console.error('[canvas] Cannot read', dir, err)
        return []
      }
    }
    for (const dir of list(this.root)) {
      if (!dir.isDirectory()) continue
      const items = new Map<string, StoredItem>()
      let sessionId: string | null = null
      for (const { name: file } of list(path.join(this.root, dir.name))) {
        if (!file.endsWith('.json')) continue
        try {
          const parsed = JSON.parse(readFileSync(path.join(this.root, dir.name, file), 'utf-8')) as StoredItem & { sessionId?: string }
          if (!isStoredItem(parsed) || typeof parsed.sessionId !== 'string') continue
          sessionId = parsed.sessionId
          items.set(parsed.item.id, { item: parsed.item, meta: parsed.meta })
        } catch {
          // A corrupt or partial file: skip the item rather than the session.
        }
      }
      if (sessionId && items.size && sessionDirName(sessionId) === dir.name) sessions.set(sessionId, items)
    }
    return sessions
  }

  private sessionItems(sessionId: string): Map<string, StoredItem> {
    const all = this.loaded()
    let items = all.get(sessionId)
    if (!items) {
      items = new Map()
      all.set(sessionId, items)
    }
    return items
  }

  private stored(sessionId: string, itemId: string): StoredItem {
    if (typeof itemId !== 'string' || !ITEM_ID_RE.test(itemId)) throw new CanvasError('Unknown Canvas item.')
    const stored = this.loaded().get(sessionId)?.get(itemId)
    if (!stored) throw new CanvasError('That Canvas item no longer exists.')
    return stored
  }

  private sessionDir(sessionId: string): string {
    return path.join(this.root, sessionDirName(sessionId))
  }

  private contentPath(sessionId: string, itemId: string, n: number): string {
    return path.join(this.sessionDir(sessionId), itemId, String(n))
  }

  private async writeMeta(sessionId: string, stored: StoredItem): Promise<void> {
    const dir = this.sessionDir(sessionId)
    await fs.mkdir(dir, { recursive: true, mode: 0o700 })
    const file = path.join(dir, `${stored.item.id}.json`)
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify({ sessionId, ...stored }), { mode: 0o600 })
    await fs.rename(tmp, file)
  }

  /** Run writes for one session one at a time. */
  private serial<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(sessionId) ?? Promise.resolve()
    const run = previous.catch(() => undefined).then(fn)
    const tail = run.catch(() => undefined)
    this.queues.set(sessionId, tail)
    void tail.then(() => { if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId) })
    return run
  }
}

/**
 * Revision numbers to drop so at most `maxRevisions` remain: oldest first,
 * never the pinned one or the newest.
 */
function pruneRevisions(revisions: CanvasRevision[], pinned: number | undefined): number[] {
  const excess = revisions.length - CANVAS_LIMITS.maxRevisions
  if (excess <= 0) return []
  const newest = revisions.at(-1)?.n
  return revisions.filter(r => r.n !== pinned && r.n !== newest).slice(0, excess).map(r => r.n)
}
