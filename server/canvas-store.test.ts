/** Tests for CanvasStore: validation, revisions, pinning, pruning, persistence and deletion, on a real temp directory. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { CANVAS_LIMITS, CanvasError, CanvasStore, canvasTypeForFile } from './canvas-store.js'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])

let root: string
let store: CanvasStore

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'canvas-store-'))
  store = new CanvasStore(root)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const md = (content: string, title = 'Notes') =>
  ({ kind: 'markdown' as const, title, source: { type: 'agent' as const }, content, mediaType: 'text/markdown' })

describe('CanvasStore', () => {
  it('creates an item and reads its content back', async () => {
    const item = await store.create('s1', md('# Hello'))
    expect(item).toMatchObject({ kind: 'markdown', title: 'Notes', latest: 1, source: { type: 'agent' } })
    expect(item.revisions).toEqual([expect.objectContaining({ n: 1, size: 7, mediaType: 'text/markdown' })])
    const got = await store.get('s1', item.id)
    expect(got.revision).toBe(1)
    expect(got.content.toString()).toBe('# Hello')
    expect(store.list('s1').map(i => i.id)).toEqual([item.id])
    expect(store.list('other')).toEqual([])
  })

  it('normalizes titles and rejects bad input', async () => {
    expect((await store.create('s1', md('x', '  Two   words '))).title).toBe('Two words')
    await expect(store.create('s1', md('x', ' '))).rejects.toThrow(CanvasError)
    await expect(store.create('s1', md('x', 'a'.repeat(CANVAS_LIMITS.maxTitleLength + 1)))).rejects.toThrow(/at most/)
    await expect(store.create('s1', { ...md('x'), mediaType: 'text/html' })).rejects.toThrow(/can't hold text\/html/)
    await expect(store.create('s1', { ...md('x'), content: Buffer.from([0xff, 0xfe, 0xfd]) })).rejects.toThrow(/UTF-8/)
    await expect(store.create('s1', { ...md('x'), kind: 'chart' as never })).rejects.toThrow(/Unknown item kind/)
    await expect(store.create('s1', md('x'.repeat(CANVAS_LIMITS.maxTextBytes + 1)))).rejects.toThrow(/at most 1 MiB/)
  })

  it('checks image bytes against the declared type', async () => {
    const image = { kind: 'image' as const, title: 'Shot', source: { type: 'agent' as const }, mediaType: 'image/png' }
    await expect(store.create('s1', { ...image, content: PNG })).resolves.toMatchObject({ kind: 'image' })
    await expect(store.create('s1', { ...image, content: Buffer.from('<html>') })).rejects.toThrow(/not a valid image\/png/)
    await expect(store.create('s1', { ...image, mediaType: 'image/svg+xml', content: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' })).resolves.toBeTruthy()
    await expect(store.create('s1', { ...image, mediaType: 'image/svg+xml', content: '<script>x</script>' })).rejects.toThrow(/not a valid/)
  })

  it('accepts JSON tables only as arrays of objects', async () => {
    const table = { kind: 'table' as const, title: 'T', source: { type: 'agent' as const }, mediaType: 'application/json' }
    await expect(store.create('s1', { ...table, content: '[{"a":1}]' })).resolves.toBeTruthy()
    await expect(store.create('s1', { ...table, content: '{"a":1}' })).rejects.toThrow(/array of objects/)
    await expect(store.create('s1', { ...table, content: '[1,2]' })).rejects.toThrow(/array of objects/)
    await expect(store.create('s1', { ...table, content: '[' })).rejects.toThrow(/does not parse/)
  })

  it('stores diagram node metadata per revision, and refuses it elsewhere', async () => {
    const diagram = { kind: 'diagram' as const, title: 'Arch', source: { type: 'agent' as const }, mediaType: 'text/vnd.mermaid' }
    const item = await store.create('s1', { ...diagram, content: 'graph LR; A-->B', meta: { nodes: { A: { file: 'server/a.ts', line: 3 } } } })
    expect((await store.get('s1', item.id)).meta).toEqual({ nodes: { A: { file: 'server/a.ts', line: 3 } } })
    await expect(store.create('s1', { ...diagram, content: 'x', meta: { nodes: { A: { line: 0 } } } })).rejects.toThrow(/positive integer/)
    await expect(store.create('s1', { ...md('x'), meta: { nodes: {} } })).rejects.toThrow(/takes no extra data/)
  })

  it('adds revisions, skips unchanged content, and serves old revisions', async () => {
    const item = await store.create('s1', md('v1'))
    expect(await store.addRevision('s1', item.id, { content: 'v1', mediaType: 'text/markdown' })).toBeNull()
    const v2 = await store.addRevision('s1', item.id, { content: 'v2', mediaType: 'text/markdown', title: 'Renamed' })
    expect(v2).toMatchObject({ latest: 2, title: 'Renamed' })
    expect((await store.get('s1', item.id, 1)).content.toString()).toBe('v1')
    expect((await store.get('s1', item.id)).content.toString()).toBe('v2')
    await expect(store.get('s1', item.id, 9)).rejects.toThrow(/no longer available/)
  })

  it('pins, reports a pinned item falling behind, and unpins', async () => {
    const item = await store.create('s1', md('v1'))
    expect(store.summary('s1')).toEqual({ items: 1, pinnedBehind: false })
    await store.pin('s1', item.id, 1)
    await store.addRevision('s1', item.id, { content: 'v2', mediaType: 'text/markdown' })
    expect(store.summary('s1')).toEqual({ items: 1, pinnedBehind: true })
    await expect(store.pin('s1', item.id, 7)).rejects.toThrow(/not available/)
    expect((await store.pin('s1', item.id, null)).pinnedRevision).toBeUndefined()
    expect(store.summary('s1')).toEqual({ items: 1, pinnedBehind: false })
    expect(store.summary('empty')).toBeUndefined()
  })

  it('drops the oldest revisions past the limit, but never the pinned one', async () => {
    const item = await store.create('s1', md('r1'))
    await store.pin('s1', item.id, 1)
    for (let i = 2; i <= CANVAS_LIMITS.maxRevisions + 2; i++) {
      await store.addRevision('s1', item.id, { content: `r${i}`, mediaType: 'text/markdown' })
    }
    const [current] = store.list('s1')
    const ns = current.revisions.map(r => r.n)
    expect(ns).toHaveLength(CANVAS_LIMITS.maxRevisions)
    expect(ns[0]).toBe(1)
    expect(ns).not.toContain(2)
    expect(ns).not.toContain(3)
    expect(ns.at(-1)).toBe(CANVAS_LIMITS.maxRevisions + 2)
    expect(existsSync(path.join(root, 's1', item.id, '2'))).toBe(false)
    expect((await store.get('s1', item.id, 1)).content.toString()).toBe('r1')
  })

  it('serializes concurrent writes to one item', async () => {
    const item = await store.create('s1', md('v1'))
    await Promise.all([2, 3, 4, 5].map(n => store.addRevision('s1', item.id, { content: `v${n}`, mediaType: 'text/markdown' })))
    const [current] = store.list('s1')
    expect(current.revisions.map(r => r.n)).toEqual([1, 2, 3, 4, 5])
  })

  it('caps the number of items per session', async () => {
    for (let i = 0; i < CANVAS_LIMITS.maxItems; i++) await store.create('s1', md(`n${i}`))
    await expect(store.create('s1', md('one more'))).rejects.toThrow(/at most 100/)
  })

  it('reloads everything from disk, and skips corrupt files', async () => {
    const item = await store.create('s1', md('v1'))
    await store.pin('s1', item.id, 1)
    await store.create('odd id/with:chars', md('hashed dir'))
    const { writeFileSync } = await import('fs')
    writeFileSync(path.join(root, 's1', 'garbage.json'), '{not json')
    const reopened = new CanvasStore(root)
    expect(reopened.list('s1')).toEqual([expect.objectContaining({ id: item.id, pinnedRevision: 1 })])
    expect(reopened.list('odd id/with:chars')).toHaveLength(1)
    expect(readdirSync(root).some(d => d.startsWith('h-'))).toBe(true)
    expect((await reopened.get('s1', item.id)).content.toString()).toBe('v1')
  })

  it('deletes an item, and a whole session', async () => {
    const a = await store.create('s1', md('a'))
    const b = await store.create('s1', md('b'))
    await store.delete('s1', a.id)
    expect(store.list('s1').map(i => i.id)).toEqual([b.id])
    await expect(store.delete('s1', a.id)).rejects.toThrow(/no longer exists/)
    await store.deleteSession('s1')
    expect(store.list('s1')).toEqual([])
    expect(existsSync(path.join(root, 's1'))).toBe(false)
  })

  it('starts empty when the store directory cannot be read', async () => {
    const { writeFileSync } = await import('fs')
    const notADir = path.join(root, 'file')
    writeFileSync(notADir, 'x')
    expect(new CanvasStore(notADir).list('s1')).toEqual([])
  })

  it('rejects item ids that are not ours', async () => {
    await expect(store.get('s1', '../../etc/passwd')).rejects.toThrow(/Unknown Canvas item/)
  })
})

describe('canvasTypeForFile', () => {
  it('maps supported extensions and refuses the rest', () => {
    expect(canvasTypeForFile('docs/A.MD')).toEqual({ kind: 'markdown', mediaType: 'text/markdown' })
    expect(canvasTypeForFile('x.tsv')).toEqual({ kind: 'table', mediaType: 'text/tab-separated-values' })
    expect(canvasTypeForFile('x.mmd')).toEqual({ kind: 'diagram', mediaType: 'text/vnd.mermaid' })
    expect(canvasTypeForFile('x.svg')).toEqual({ kind: 'image', mediaType: 'image/svg+xml' })
    expect(canvasTypeForFile('x.html')).toBeNull()
    expect(canvasTypeForFile('x.json')).toBeNull()
  })
})
