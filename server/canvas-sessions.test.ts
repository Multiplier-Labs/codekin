/** Tests for CanvasSessions: opening files safely, revisions on re-open, broadcasts and chat-card events. */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { CanvasStore } from './canvas-store.js'
import { CanvasSessions } from './canvas-sessions.js'
import type { Session, WsServerMessage } from './types.js'

let tmp: string
let repo: string
let attached: string
let session: Session
let canvas: CanvasSessions
let broadcasts: WsServerMessage[]
let history: WsServerMessage[]
let sessionsChanged: ReturnType<typeof vi.fn>

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'canvas-sessions-'))
  repo = path.join(tmp, 'repo')
  attached = path.join(tmp, 'other')
  mkdirSync(path.join(repo, 'docs'), { recursive: true })
  mkdirSync(attached)
  writeFileSync(path.join(repo, 'docs', 'plan.md'), '# Plan')
  writeFileSync(path.join(repo, 'data.csv'), 'a,b\n1,2')
  writeFileSync(path.join(repo, 'page.html'), '<p>')
  writeFileSync(path.join(repo, 'notes.txt'), 'plain')
  writeFileSync(path.join(attached, 'notes.md'), '# Notes')
  writeFileSync(path.join(tmp, 'secret.md'), 'outside')
  symlinkSync(path.join(tmp, 'secret.md'), path.join(repo, 'link.md'))

  session = { id: 's1', workingDir: repo, addDirs: [attached] } as unknown as Session
  broadcasts = []
  history = []
  sessionsChanged = vi.fn()
  canvas = new CanvasSessions(new CanvasStore(path.join(tmp, 'store')), {
    getSession: id => (id === 's1' ? session : undefined),
    broadcast: (_s, msg) => broadcasts.push(msg),
    broadcastAndHistory: (_s, msg) => { history.push(msg); broadcasts.push(msg) },
    sessionsChanged,
  })
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe('CanvasSessions.openFile', () => {
  it('opens a file as an item, posts a chat card and broadcasts the list', async () => {
    expect(await canvas.openFile('s1', 'docs/plan.md')).toBeNull()
    expect(history).toEqual([expect.objectContaining({ type: 'canvas_event', action: 'created', kind: 'markdown', title: 'plan.md', revision: 1 })])
    const list = broadcasts.find(m => m.type === 'canvas_items') as Extract<WsServerMessage, { type: 'canvas_items' }>
    expect(list.items[0].source).toEqual({ type: 'file', path: 'docs/plan.md' })
    expect(sessionsChanged).toHaveBeenCalled()
    expect(canvas.summary('s1')).toEqual({ items: 1, pinnedBehind: false })
  })

  it('adds a revision when the same file is opened after a change, and nothing when unchanged', async () => {
    await canvas.openFile('s1', 'docs/plan.md')
    await canvas.openFile('s1', 'docs/plan.md')
    expect(history).toHaveLength(1)
    writeFileSync(path.join(repo, 'docs', 'plan.md'), '# Plan v2')
    await canvas.openFile('s1', 'docs/plan.md')
    expect(history.at(-1)).toMatchObject({ action: 'updated', revision: 2 })
    expect(canvas.summary('s1')?.items).toBe(1)
  })

  it('opens files from attached folders only', async () => {
    expect(await canvas.openFile('s1', 'notes.md', attached)).toBeNull()
    const list = broadcasts.filter(m => m.type === 'canvas_items').at(-1) as Extract<WsServerMessage, { type: 'canvas_items' }>
    expect(list.items[0].source).toEqual({ type: 'file', path: 'notes.md', root: attached })
    expect(await canvas.openFile('s1', 'secret.md', tmp)).toMatch(/not attached/)
  })

  it('refuses paths that leave the folder, including through symlinks', async () => {
    expect(await canvas.openFile('s1', '../secret.md')).toMatch(/inside the session's folder/)
    expect(await canvas.openFile('s1', path.join(tmp, 'secret.md'))).toMatch(/inside the session's folder/)
    expect(await canvas.openFile('s1', 'link.md')).toMatch(/outside the session's folder/)
    expect(await canvas.openFile('s1', 'missing.md')).toMatch(/not found/)
    expect(await canvas.openFile('s1', 'docs')).toMatch(/can't show/)
    expect(history).toEqual([])
  })

  it('names the supported types for files it cannot show', async () => {
    expect(await canvas.openFile('s1', 'notes.txt')).toMatch(/Markdown, CSV\/TSV tables, Mermaid diagrams, images, Vega-Lite charts/)
    expect(await canvas.openFile('s1', 'page.html')).toBeNull()
  })

  it('reports an unknown session', async () => {
    expect(await canvas.openFile('nope', 'docs/plan.md')).toBe('Session not found')
  })
})

describe('CanvasSessions reads and changes', () => {
  it('returns content as UTF-8 text, and errors as canvas_error', async () => {
    await canvas.openFile('s1', 'data.csv')
    const [item] = (canvas.list('s1') as Extract<WsServerMessage, { type: 'canvas_items' }>).items
    expect(await canvas.get('s1', item.id)).toMatchObject({ type: 'canvas_item', revision: 1, content: 'a,b\n1,2', encoding: 'utf8' })
    expect(await canvas.get('s1', item.id, 0)).toEqual({ type: 'canvas_error', sessionId: 's1', message: 'Invalid revision.', itemId: item.id, revision: 0 })
    expect(await canvas.get('s1', 'not-an-id')).toMatchObject({ type: 'canvas_error', message: 'Unknown Canvas item.' })
  })

  it('returns images base64-encoded', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])
    writeFileSync(path.join(repo, 'shot.png'), png)
    const item = await canvas.publish('s1', { kind: 'image', path: 'shot.png' })
    expect(await canvas.get('s1', item.id)).toMatchObject({ encoding: 'base64', content: png.toString('base64') })
  })

  it('pins and deletes, broadcasting the list each time', async () => {
    await canvas.openFile('s1', 'docs/plan.md')
    const [item] = (canvas.list('s1') as Extract<WsServerMessage, { type: 'canvas_items' }>).items
    broadcasts = []
    expect(await canvas.pin('s1', item.id, 1)).toBeNull()
    expect(await canvas.pin('s1', item.id, 1.5)).toBe('Invalid revision.')
    expect(await canvas.delete('s1', item.id)).toBeNull()
    expect(broadcasts.map(m => m.type)).toEqual(['canvas_items', 'canvas_items'])
    expect(canvas.summary('s1')).toBeUndefined()
  })
})

describe('CanvasSessions.publish (agent tools)', () => {
  it('shows inline Markdown, records an agent card, and revises by id', async () => {
    const item = await canvas.publish('s1', { title: 'Report', kind: 'markdown', content: '# One' })
    expect(item).toMatchObject({ kind: 'markdown', title: 'Report', source: { type: 'agent' }, latest: 1 })
    expect(history.at(-1)).toMatchObject({ type: 'canvas_event', action: 'created', by: 'agent', title: 'Report' })

    const v2 = await canvas.publish('s1', { itemId: item.id, content: '# Two', title: 'Report v2' })
    expect(v2).toMatchObject({ latest: 2, title: 'Report v2' })
    expect(history.at(-1)).toMatchObject({ action: 'updated', revision: 2 })

    // Unchanged content: no revision, no card.
    const cards = history.length
    expect(await canvas.publish('s1', { itemId: item.id, content: '# Two' })).toMatchObject({ latest: 2 })
    expect(history).toHaveLength(cards)
  })

  it('encodes inline tables by format and checks them', async () => {
    expect((await canvas.publish('s1', { title: 'T', kind: 'table', content: 'a,b\n1,2' })).revisions[0].mediaType).toBe('text/csv')
    expect((await canvas.publish('s1', { title: 'T', kind: 'table', content: 'a\tb', format: 'tsv' })).revisions[0].mediaType).toBe('text/tab-separated-values')
    expect((await canvas.publish('s1', { title: 'T', kind: 'table', content: '[{"a":1}]', format: 'json' })).revisions[0].mediaType).toBe('application/json')
    await expect(canvas.publish('s1', { title: 'T', kind: 'table', content: '{}', format: 'json' })).rejects.toThrow(/array of objects/)
    await expect(canvas.publish('s1', { title: 'T', kind: 'table', content: 'x', format: 'xml' })).rejects.toThrow(/csv, tsv or json/)
  })

  it('keeps diagram node metadata', async () => {
    const item = await canvas.publish('s1', { title: 'Arch', kind: 'diagram', content: 'graph LR; A-->B', nodes: { A: { file: 'src/a.ts' } } })
    expect((await canvas.get('s1', item.id))).toMatchObject({ meta: { nodes: { A: { file: 'src/a.ts' } } } })
  })

  it('reads files by relative or absolute path inside the session, titled by file name', async () => {
    expect(await canvas.publish('s1', { kind: 'table', path: 'data.csv' })).toMatchObject({ title: 'data.csv', kind: 'table' })
    expect(await canvas.publish('s1', { kind: 'markdown', path: path.join(repo, 'docs', 'plan.md') })).toMatchObject({ title: 'plan.md' })
    expect(await canvas.publish('s1', { kind: 'markdown', path: path.join(attached, 'notes.md') })).toMatchObject({ title: 'notes.md' })
    writeFileSync(path.join(repo, 'rows.json'), '[{"a":1}]')
    expect((await canvas.publish('s1', { kind: 'table', path: 'rows.json' })).revisions[0].mediaType).toBe('application/json')
  })

  it('refuses what the agent should fix', async () => {
    await expect(canvas.publish('s1', { kind: 'markdown', path: path.join(tmp, 'secret.md') })).rejects.toThrow(/outside the session's folder/)
    await expect(canvas.publish('s1', { kind: 'markdown', path: 'link.md' })).rejects.toThrow(/outside the session's folder/)
    await expect(canvas.publish('s1', { kind: 'video', content: 'x' })).rejects.toThrow(/kind must be one of/)
    await expect(canvas.publish('s1', { title: 'C', kind: 'chart', content: 'x' })).rejects.toThrow(/does not parse/)
    await expect(canvas.publish('s1', { kind: 'image', content: 'x' })).rejects.toThrow(/Images need a path/)
    await expect(canvas.publish('s1', { kind: 'markdown', content: 'x', path: 'data.csv' })).rejects.toThrow(/either content or path/)
    await expect(canvas.publish('s1', { kind: 'markdown' })).rejects.toThrow(/Pass content/)
    await expect(canvas.publish('s1', { kind: 'image', path: 'data.csv' })).rejects.toThrow(/can't be shown as a image/)
    await expect(canvas.publish('s1', { itemId: 'nope', content: 'x' })).rejects.toThrow(/No Canvas item nope/)
    const md = await canvas.publish('s1', { title: 'M', kind: 'markdown', content: 'x' })
    await expect(canvas.publish('s1', { itemId: md.id, kind: 'table', content: 'a' })).rejects.toThrow(/kind can't change/)
    await expect(canvas.publish('nope', { kind: 'markdown', content: 'x' })).rejects.toThrow(/Session not found/)
  })
})

describe('CanvasSessions.publishMcpApp', () => {
  it('stores a tool call with a UI as an mcp_app item from that server, with a chat card', async () => {
    const item = await canvas.publishMcpApp('s1', {
      server: 'latency', tool: 'latency_report', toolInput: {}, result: { content: [] }, resourceUri: 'ui://latency/r.html', html: '<p>app</p>',
    })
    expect(item).toMatchObject({ kind: 'mcp_app', title: 'Latency report', source: { type: 'mcp', server: 'latency' } })
    expect(history.at(-1)).toMatchObject({ type: 'canvas_event', kind: 'mcp_app', by: 'mcp' })
    const got = await canvas.get('s1', item!.id)
    expect(JSON.parse((got as { content: string }).content)).toMatchObject({ server: 'latency', html: '<p>app</p>' })
  })

  it('is not something the agent can publish itself', async () => {
    await expect(canvas.publish('s1', { title: 'x', kind: 'mcp_app', content: '{}' })).rejects.toThrow(/kind must be one of/)
  })
})

describe('CanvasSessions.publishPreview', () => {
  it('stores a port as a preview item, and revises it for the same port', async () => {
    const item = await canvas.publishPreview('s1', { port: 5173, title: 'Web' })
    expect(item).toMatchObject({ kind: 'preview', title: 'Web', source: { type: 'agent' } })
    expect(await canvas.previewTarget('s1', item.id)).toEqual({ port: 5173, path: '/' })

    const again = await canvas.publishPreview('s1', { port: 5173, path: '/settings' })
    expect(again.id).toBe(item.id)
    expect(again.latest).toBe(2)
    expect(await canvas.previewTarget('s1', item.id)).toEqual({ port: 5173, path: '/settings' })
    // Same target again: no new revision.
    expect((await canvas.publishPreview('s1', { port: 5173, path: '/settings' })).latest).toBe(2)

    const other = await canvas.publishPreview('s1', { port: 3000 })
    expect(other.id).not.toBe(item.id)
    expect(other.title).toBe('localhost:3000')
  })

  it('keeps one item per launch configuration', async () => {
    const a = await canvas.publishPreview('s1', { port: 5173 }, { type: 'launch', config: 'web' })
    const b = await canvas.publishPreview('s1', { port: 5174 }, { type: 'launch', config: 'web' })
    expect(b.id).toBe(a.id)
    expect(a.title).toBe('web')
    expect(await canvas.previewTarget('s1', a.id)).toEqual({ port: 5174, path: '/', config: 'web' })
  })

  it('finds an agent preview by port after a restart', async () => {
    const item = await canvas.publishPreview('s1', { port: 5173 })
    const fresh = new CanvasSessions(new CanvasStore(path.join(tmp, 'store')), {
      getSession: id => (id === 's1' ? session : undefined),
      broadcast: () => {}, broadcastAndHistory: () => {}, sessionsChanged: () => {},
    })
    expect((await fresh.publishPreview('s1', { port: 5173, path: '/x' })).id).toBe(item.id)
  })

  it('checks the port and path, and agents cannot make previews through canvas_show', async () => {
    await expect(canvas.publishPreview('s1', { port: 0 })).rejects.toThrow(/port/)
    await expect(canvas.publishPreview('s1', { port: '5173' })).rejects.toThrow(/port/)
    await expect(canvas.publishPreview('s1', { port: 5173, path: 'settings' })).rejects.toThrow(/start with \//)
    await expect(canvas.publishPreview('s1', { port: 5173, path: '//evil.example.com' })).rejects.toThrow(/start with \//)
    await expect(canvas.publish('s1', { kind: 'preview', title: 'x', content: '{}' })).rejects.toThrow(/kind must be one of/)
  })

  it('tells the preview manager when an item is deleted', async () => {
    const itemDeleted = vi.fn()
    const c = new CanvasSessions(new CanvasStore(path.join(tmp, 'store2')), {
      getSession: id => (id === 's1' ? session : undefined),
      broadcast: () => {}, broadcastAndHistory: () => {}, sessionsChanged: () => {}, itemDeleted,
    })
    const item = await c.publishPreview('s1', { port: 5173 })
    expect(await c.delete('s1', item.id)).toBeNull()
    expect(itemDeleted).toHaveBeenCalledWith('s1', item.id)
  })
})

describe('CanvasSessions file content and item cap', () => {
  it('marks a revision an agent showed by path as file content', async () => {
    const item = await canvas.publish('s1', { kind: 'markdown', title: 'Plan', path: 'docs/plan.md' })
    expect(item.revisions[0].fromFile).toBe(true)
    const inline = await canvas.publish('s1', { kind: 'markdown', title: 'Note', content: '# x' })
    expect(inline.revisions[0].fromFile).toBeUndefined()
  })

  it('makes room for a new MCP App at the item cap by dropping the oldest unpinned one', async () => {
    const call = { server: 'latency', tool: 'report', toolInput: {}, result: { content: [] }, resourceUri: 'ui://x', html: '<p>app</p>' }
    const first = await canvas.publishMcpApp('s1', call)
    for (let i = 1; i < 100; i++) await canvas.publish('s1', { kind: 'markdown', title: `n${i}`, content: 'x' })
    const next = await canvas.publishMcpApp('s1', call)
    expect(next).not.toBeNull()
    const ids = (canvas.list('s1') as Extract<WsServerMessage, { type: 'canvas_items' }>).items.map(i => i.id)
    expect(ids).not.toContain(first!.id)
    expect(ids).toHaveLength(100)
  })
})
