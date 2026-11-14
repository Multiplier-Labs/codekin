import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'
import { tmpdir } from 'os'
import path from 'path'
import { devServerEnv, PreviewManager, previewFrameSrc, previewSettings, probePort } from './preview-manager.js'
import type { CanvasItem, CanvasItemSource, PreviewState, PreviewTarget, Session, WsServerMessage } from './types.js'

async function freePort(): Promise<number> {
  const s = net.createServer()
  await new Promise<void>(r => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise(r => s.close(r))
  return port
}

async function until<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - start > ms) throw new Error('timed out')
    await new Promise(r => setTimeout(r, 50))
  }
}

describe('previewSettings', () => {
  it('defaults to ten ports from Codekin\'s port + 10, denying its own', () => {
    const s = previewSettings(32352, 32353, '127.0.0.1', {})
    expect(s.ports).toEqual([32362, 32363, 32364, 32365, 32366, 32367, 32368, 32369, 32370, 32371])
    expect(s.denied.has(32352) && s.denied.has(32353) && s.denied.has(32362)).toBe(true)
    expect(previewFrameSrc(s)).toContain('http://*:32362')
  })

  it('reads a range, a list, or off', () => {
    expect(previewSettings(1000, null, 'h', { CANVAS_PREVIEW_PORTS: '4000-4002' }).ports).toEqual([4000, 4001, 4002])
    expect(previewSettings(1000, null, 'h', { CANVAS_PREVIEW_PORTS: '4000, 4005,1000' }).ports).toEqual([4000, 4005])
    const off = previewSettings(1000, null, 'h', { CANVAS_PREVIEW_PORTS: 'off' })
    expect(off.ports).toEqual([])
    expect(previewFrameSrc(off)).toBeNull()
  })
})

describe('devServerEnv', () => {
  it('drops Codekin\'s variables and NODE_ENV, and sets PORT', () => {
    const before = { ...process.env }
    process.env.NODE_ENV = 'production'
    process.env.CODEKIN_AUTH_TOKEN = 'secret'
    process.env.AUTH_TOKEN = 'secret'
    try {
      const env = devServerEnv({ MODE: 'x' }, 5173)
      expect(env.NODE_ENV).toBeUndefined()
      expect(env.CODEKIN_AUTH_TOKEN).toBeUndefined()
      expect(env.AUTH_TOKEN).toBeUndefined()
      expect(env.PORT).toBe('5173')
      expect(env.MODE).toBe('x')
    } finally {
      process.env = before
    }
  })
})

describe('PreviewManager', () => {
  let root: string
  let sent: WsServerMessage[]
  let items: Map<string, { item: CanvasItem; target: PreviewTarget }>
  let manager: PreviewManager
  let devPort: number
  let proxyPorts: number[]
  const session = () => ({ id: 's1', workingDir: root } as unknown as Session)

  const states = () => sent.filter((m): m is Extract<WsServerMessage, { type: 'preview_state' }> => m.type === 'preview_state').map(m => m.preview)
  const last = (): PreviewState | undefined => states().at(-1)

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'preview-'))
    devPort = await freePort()
    proxyPorts = [await freePort(), await freePort()]
    sent = []
    items = new Map()
    let n = 0
    manager = new PreviewManager({
      getSession: (id) => (id === 's1' ? session() : undefined),
      broadcast: (_s, msg) => { sent.push(msg) },
      target: async (_s, itemId) => items.get(itemId)?.target ?? null,
      publish: async (_s, input: { port: number; path?: string }, source: CanvasItemSource) => {
        const existing = [...items.values()].find(i => source.type === 'launch' && i.item.source.type === 'launch' && i.item.source.config === source.config)
        if (existing) return existing.item
        const item = { id: `item-${++n}`, kind: 'preview', title: 'x', source, revisions: [], latest: 1, createdAt: '', updatedAt: '' } as CanvasItem
        items.set(item.id, { item, target: { port: input.port, path: input.path ?? '/', ...(source.type === 'launch' ? { config: source.config } : {}) } })
        return item
      },
    })
    manager.configure({ ports: proxyPorts, host: '127.0.0.1', denied: new Set([1234, ...proxyPorts]) })
    mkdirSync(path.join(root, '.claude'))
    writeFileSync(path.join(root, 'server.js'), `
      const http = require('http')
      console.log('booting on', process.env.PORT)
      if (process.argv[2] === 'crash') { console.error('boom'); process.exit(3) }
      setTimeout(() => http.createServer((q, s) => { s.setHeader('Content-Type', 'text/html'); s.end('<html><head></head><body>dev</body></html>') }).listen(Number(process.env.PORT), '127.0.0.1', () => console.log('ready')), 200)
    `)
    writeFileSync(path.join(root, '.claude/launch.json'), JSON.stringify({
      version: '0.0.1',
      configurations: [
        { name: 'web', program: 'server.js', port: devPort },
        { name: 'crashy', program: 'server.js', args: ['crash'], port: devPort },
        { name: 'codekin', program: 'server.js', port: 1234 },
      ],
    }))
  })

  afterEach(async () => {
    await manager.shutdown()
    rmSync(root, { recursive: true, force: true })
  })

  it('lists launch configurations without env values or absolute paths', async () => {
    const msg = await manager.configs('s1')
    expect(msg.type).toBe('preview_configs')
    if (msg.type !== 'preview_configs') return
    expect(msg.configs.map(c => c.name)).toEqual(['web', 'crashy', 'codekin'])
    expect(msg.configs[0].command).toBe('node server.js')
    expect(JSON.stringify(msg)).not.toContain(root)
  })

  it('starts a configuration, reports it running, proxies it, and stops it', async () => {
    expect(await manager.launch('s1', 'web')).toBeNull()
    expect(last()).toMatchObject({ status: 'starting', managed: true, config: 'web', command: 'node server.js', targetPort: devPort })
    const running = await until(() => states().find(s => s.status === 'running'))
    expect(proxyPorts).toContain(running.proxyPort)
    expect(running.entry).toMatch(/^\/__codekin\/enter\?k=[\w-]+&to=%2F$/)

    // Through the proxy, with the entry URL's cookie.
    const entry = await new Promise<string[]>((resolve) => {
      http.get({ host: '127.0.0.1', port: running.proxyPort, path: running.entry }, (res) => { res.resume(); resolve(res.headers['set-cookie'] ?? []) })
    })
    const body = await new Promise<string>((resolve) => {
      http.get({ host: '127.0.0.1', port: running.proxyPort, path: '/', headers: { cookie: entry[0].split(';')[0] } }, (res) => {
        let b = ''
        res.on('data', (c: Buffer) => { b += c.toString() })
        res.on('end', () => { resolve(b) })
      })
    })
    expect(body).toContain('dev')
    expect(body).toContain('/__codekin/preview.js')

    const logs = manager.logs('s1', running.itemId)
    expect(logs.type === 'preview_log' && logs.lines.some(l => l.includes('booting on'))).toBe(true)

    expect(manager.stop('s1', running.itemId)).toBeNull()
    await until(() => last()?.status === 'stopped' ? true : undefined)
    expect(await probePort(devPort)).toBe(false)
  })

  it('reports a crash with its exit code', async () => {
    await manager.launch('s1', 'crashy')
    const crashed = await until(() => states().find(s => s.status === 'crashed'))
    expect(crashed.exitCode).toBe(3)
    expect(crashed.error).toMatch(/exited with code 3/)
  })

  it('shows what already answers on a busy port instead of starting another', async () => {
    const other = http.createServer((_q, s) => { s.end('other') })
    await new Promise<void>(r => other.listen(devPort, '127.0.0.1', r))
    try {
      await manager.launch('s1', 'web')
      expect(last()).toMatchObject({ status: 'running', managed: false })
      expect(last()?.notice).toMatch(/already in use/)
    } finally {
      other.close()
    }
  })

  it('refuses Codekin\'s own ports and unknown configurations', async () => {
    expect(await manager.launch('s1', 'codekin')).toMatch(/Codekin's own/)
    expect(await manager.launch('s1', 'nope')).toMatch(/no launch configuration named "nope"/)
    await expect(manager.checkAgentTarget({ port: 1234 })).rejects.toThrow(/Codekin's own/)
    await expect(manager.checkAgentTarget({ port: devPort })).rejects.toThrow(/Nothing is listening/)
  })

  it('opens an agent\'s preview and follows its port', async () => {
    items.set('agent-1', { item: { id: 'agent-1' } as CanvasItem, target: { port: devPort, path: '/a' } })
    expect(await manager.open('s1', 'agent-1')).toBeNull()
    expect(last()).toMatchObject({ status: 'stopped', managed: false })
    expect(last()?.entry).toContain('to=%2Fa')
    expect(manager.stop('s1', 'agent-1')).toMatch(/didn't start this server/)

    const dev = http.createServer((_q, s) => { s.end('ok') })
    await new Promise<void>(r => dev.listen(devPort, '127.0.0.1', r))
    try {
      await until(() => last()?.status === 'running' ? true : undefined)
    } finally {
      dev.close()
    }
  })

  it('reclaims the preview opened longest ago when every port is taken', async () => {
    for (const id of ['a', 'b', 'c']) items.set(id, { item: { id } as CanvasItem, target: { port: devPort, path: '/' } })
    await manager.open('s1', 'a')
    await manager.open('s1', 'b')
    await manager.open('s1', 'c')
    const latest = new Map(states().map(s => [s.itemId, s]))
    expect(latest.get('a')?.proxyPort).toBeUndefined()
    expect(latest.get('c')?.proxyPort).toBe(proxyPorts.find(p => p !== latest.get('b')?.proxyPort))
  })

  it('stops everything when the item is deleted', async () => {
    await manager.launch('s1', 'web')
    const running = await until(() => states().find(s => s.status === 'running'))
    manager.forget('s1', running.itemId)
    await new Promise(r => setTimeout(r, 500))
    expect(await probePort(devPort)).toBe(false)
  })
})
