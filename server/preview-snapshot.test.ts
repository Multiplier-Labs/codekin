/** Tests for preview snapshots: finding a browser, its flags, PreviewManager.snapshot, the stored record, and (with a browser) a real capture. */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import path from 'path'
import { CanvasStore } from './canvas-store.js'
import { PreviewManager, SNAPSHOT_VIEWPORTS } from './preview-manager.js'
import { browserArgs, findSnapshotBrowser, SnapshotError, takeSnapshot, type SnapshotOptions, type SnapshotResult } from './preview-snapshot.js'
import type { CanvasItem, PreviewTarget, Session, SnapshotMeta, WsServerMessage } from './types.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(path.join(tmpdir(), 'snapshot-test-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function executable(file: string): string {
  mkdirSync(path.dirname(file), { recursive: true })
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
  return file
}

function listen(handler: http.RequestListener): Promise<{ port: number; close: () => Promise<void> }> {
  const server = http.createServer(handler)
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ port: (server.address() as AddressInfo).port, close: () => new Promise(r => { server.close(() => { r() }) }) })
    })
  })
}

describe('findSnapshotBrowser', () => {
  it('honours CANVAS_SNAPSHOT_BROWSER: off, a path, or a path that is not there', () => {
    const chrome = executable(path.join(dir, 'my-chrome'))
    expect(findSnapshotBrowser({ CANVAS_SNAPSHOT_BROWSER: 'off', PATH: dir }, 'linux')).toBeNull()
    expect(findSnapshotBrowser({ CANVAS_SNAPSHOT_BROWSER: chrome, PATH: '' }, 'linux')).toBe(chrome)
    expect(findSnapshotBrowser({ CANVAS_SNAPSHOT_BROWSER: path.join(dir, 'missing'), PATH: '' }, 'linux')).toBeNull()
  })

  it('finds Chrome or Chromium on PATH before a Playwright browser', () => {
    const bin = path.join(dir, 'bin')
    const chromium = executable(path.join(bin, 'chromium'))
    executable(path.join(dir, 'pw', 'chromium_headless_shell-1200', 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
    expect(findSnapshotBrowser({ PATH: bin, PLAYWRIGHT_BROWSERS_PATH: path.join(dir, 'pw') }, 'linux')).toBe(chromium)
  })

  it('takes the newest Playwright headless shell, then full Chromium', () => {
    const pw = path.join(dir, 'pw')
    executable(path.join(pw, 'chromium_headless_shell-999', 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
    const newest = executable(path.join(pw, 'chromium_headless_shell-1234', 'chrome-headless-shell-linux64', 'chrome-headless-shell'))
    const env = { PATH: path.join(dir, 'empty'), PLAYWRIGHT_BROWSERS_PATH: pw, HOME: dir }
    expect(findSnapshotBrowser(env, 'linux')).toBe(newest)
    rmSync(path.join(pw, 'chromium_headless_shell-1234'), { recursive: true })
    rmSync(path.join(pw, 'chromium_headless_shell-999'), { recursive: true })
    const full = executable(path.join(pw, 'chromium-1300', 'chrome-linux64', 'chrome'))
    expect(findSnapshotBrowser(env, 'linux')).toBe(full)
  })
})

describe('browserArgs', () => {
  it('drives the browser over a pipe with a throwaway profile, and keeps an unsandboxed one on this machine', () => {
    const sandboxed = browserArgs('/tmp/p', true)
    expect(sandboxed).toContain('--remote-debugging-pipe')
    expect(sandboxed).toContain('--user-data-dir=/tmp/p')
    expect(sandboxed.some(a => a.startsWith('--remote-debugging-port'))).toBe(false)
    expect(sandboxed).not.toContain('--no-sandbox')
    expect(sandboxed.some(a => a.startsWith('--proxy-server'))).toBe(false)
    const bare = browserArgs('/tmp/p', false)
    expect(bare).toContain('--no-sandbox')
    expect(bare.some(a => a.startsWith('--proxy-server='))).toBe(true)
  })
})

describe('PreviewManager.snapshot', () => {
  const PNG = Buffer.from('89504e470d0a1a0a0000', 'hex')
  let calls: Array<{ browser: string; opts: SnapshotOptions }>
  let published: Array<{ previewItemId: string; meta: SnapshotMeta; mediaType: string }>
  let browser: string | null
  let result: (opts: SnapshotOptions) => Promise<SnapshotResult>
  let targets: Map<string, PreviewTarget>
  let manager: PreviewManager

  beforeEach(() => {
    calls = []
    published = []
    browser = '/usr/bin/chromium'
    targets = new Map()
    result = async (opts) => ({ image: PNG, mediaType: 'image/png', finalPath: `${opts.path}#done`, title: 'App', console: [{ level: 'error', message: 'boom', path: opts.path, at: 1 }], restricted: true, blocked: 2 })
    manager = new PreviewManager({
      getSession: () => ({ id: 's1' } as unknown as Session),
      broadcast: (_s: Session, _m: WsServerMessage) => undefined,
      target: async (_s, itemId) => targets.get(itemId) ?? null,
      publish: async () => { throw new Error('unused') },
      publishSnapshot: async (_s, previewItemId, image, meta) => {
        published.push({ previewItemId, meta, mediaType: image.mediaType })
        return { id: 'snap-1' } as CanvasItem
      },
      snapshotBrowser: () => browser,
      takeSnapshot: async (b, opts) => { calls.push({ browser: b, opts }); return result(opts) },
    })
    manager.configure({ ports: [], host: '127.0.0.1', denied: new Set([1234]) })
  })

  it('snapshots the page asked for at the viewport asked for, and keeps it with its console record', async () => {
    const dev = await listen((_q, s) => { s.end('ok') })
    try {
      targets.set('p1', { port: dev.port, path: '/' })
      expect(await manager.snapshot('s1', 'p1', { path: '/settings?tab=2', viewport: 'phone' })).toEqual({ snapshotItemId: 'snap-1' })
      expect(calls[0]).toEqual({ browser: '/usr/bin/chromium', opts: { port: dev.port, path: '/settings?tab=2', ...SNAPSHOT_VIEWPORTS.phone } })
      expect(published[0]).toEqual({
        previewItemId: 'p1', mediaType: 'image/png',
        meta: { path: '/settings?tab=2#done', title: 'App', port: dev.port, viewport: 'phone', console: [{ level: 'error', message: 'boom', path: '/settings?tab=2', at: 1 }], restricted: true, blocked: 2 },
      })
    } finally {
      await dev.close()
    }
  })

  it('falls back to the item\'s path and the full viewport for anything else', async () => {
    const dev = await listen((_q, s) => { s.end('ok') })
    try {
      targets.set('p1', { port: dev.port, path: '/home' })
      await manager.snapshot('s1', 'p1', { path: '//evil.example.com/', viewport: 'huge' })
      await manager.snapshot('s1', 'p1', { path: '/a b' })
      expect(calls.map(c => [c.opts.path, c.opts.width])).toEqual([['/home', 1280], ['/home', 1280]])
    } finally {
      await dev.close()
    }
  })

  it('says why it can\'t: no browser, not a preview, Codekin\'s own port, nothing listening, or the browser failed', async () => {
    targets.set('own', { port: 1234, path: '/' })
    targets.set('down', { port: 1, path: '/' })
    expect(await manager.snapshot('s1', 'missing')).toEqual({ error: 'That item is not a preview.' })
    expect(await manager.snapshot('s1', 'own')).toEqual({ error: expect.stringContaining('Codekin\'s own') })
    expect(await manager.snapshot('s1', 'down')).toEqual({ error: expect.stringContaining('Nothing is listening on port 1') })
    const dev = await listen((_q, s) => { s.end('ok') })
    try {
      targets.set('p1', { port: dev.port, path: '/' })
      result = async () => { throw new SnapshotError('The page took longer than 15 seconds to load.') }
      expect(await manager.snapshot('s1', 'p1')).toEqual({ error: 'The page took longer than 15 seconds to load.' })
    } finally {
      await dev.close()
    }
    browser = null
    const fresh = new PreviewManager({
      getSession: () => undefined, broadcast: () => undefined, target: async () => null, publish: async () => { throw new Error('unused') },
      publishSnapshot: async () => { throw new Error('unused') }, snapshotBrowser: () => null,
    })
    expect(await fresh.snapshot('s1', 'p1')).toEqual({ error: expect.stringContaining('need Chrome or Chromium') })
    expect(calls).toHaveLength(1)
  })

  it('takes one snapshot at a time per session', async () => {
    const dev = await listen((_q, s) => { s.end('ok') })
    try {
      targets.set('p1', { port: dev.port, path: '/' })
      let release!: () => void
      const gate = new Promise<void>((r) => { release = r })
      const first = result
      result = async (opts) => { await gate; return first(opts) }
      const one = manager.snapshot('s1', 'p1')
      await new Promise(r => setTimeout(r, 50))
      expect(await manager.snapshot('s1', 'p1')).toEqual({ error: 'A snapshot is already being taken in this session.' })
      release()
      expect(await one).toEqual({ snapshotItemId: 'snap-1' })
    } finally {
      await dev.close()
    }
  })
})

describe('snapshot items in the Canvas store', () => {
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)])
  const meta: SnapshotMeta = { path: '/', title: 'App', port: 5173, viewport: 'full', console: [{ level: 'warn', message: 'careful', path: '/', at: 1 }], restricted: true, blocked: 3 }

  it('keeps a snapshot record with an image, and refuses a malformed one', async () => {
    const store = new CanvasStore(dir)
    const item = await store.create('s1', { kind: 'image', title: 'Snapshot: web', source: { type: 'snapshot', preview: 'p1' }, content: PNG, mediaType: 'image/png', meta: { snapshot: meta } })
    expect((await store.get('s1', item.id)).meta).toEqual({ snapshot: meta })
    await expect(store.addRevision('s1', item.id, { content: PNG, mediaType: 'image/png', meta: { snapshot: { ...meta, viewport: 'huge' } } as never })).rejects.toThrow('Not a snapshot record.')
    await expect(store.addRevision('s1', item.id, { content: PNG, mediaType: 'image/png', meta: { snapshot: { ...meta, console: [{ level: 'info', message: 'x', path: '/', at: 1 }] } } as never })).rejects.toThrow('Not a snapshot record.')
    await expect(store.create('s1', { kind: 'markdown', title: 'x', source: { type: 'agent' }, content: 'x', mediaType: 'text/markdown', meta: { snapshot: meta } })).rejects.toThrow('takes no extra data')
  })
})

const realBrowser = findSnapshotBrowser()

describe.skipIf(!realBrowser)('takeSnapshot with a real browser', () => {
  it('loads the page from the dev server, waits for what it fetches, and records its console', async () => {
    const dev = await listen((req, res) => {
      if (req.url === '/data') { res.end('{"n":42}'); return }
      res.setHeader('Content-Type', 'text/html')
      res.end(`<title>Fixture</title><p id="x">loading</p><script>
        console.error('first problem'); console.warn('a warning')
        fetch('/data').then(r => r.json()).then(d => { document.getElementById('x').textContent = 'n=' + d.n; history.replaceState(null, '', '/done') })
      </script>`)
    })
    try {
      const shot = await takeSnapshot(realBrowser!, { port: dev.port, path: '/start', width: 400, height: 300 })
      expect(shot.mediaType).toBe('image/png')
      expect(shot.image.subarray(0, 4).toString('hex')).toBe('89504e47')
      expect(shot.title).toBe('Fixture')
      expect(shot.finalPath).toBe('/done')
      expect(shot.console.map(e => [e.level, e.message])).toEqual(expect.arrayContaining([['error', 'first problem'], ['warn', 'a warning']]))
    } finally {
      await dev.close()
    }
  // takeSnapshot bounds itself: 30s per attempt, and a second attempt without
  // the sandbox when it can't start. A cold Chrome on a busy CI runner can take
  // most of that, so outlast both attempts and let a slow run fail with the
  // snapshot's own error rather than an unexplained test timeout.
  }, 90_000)
})
