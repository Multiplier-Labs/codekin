import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'
import { createPreviewProxy, downstreamHeaders, injectScript, PREVIEW_ENTRY_PATH, PREVIEW_SCRIPT_PATH, previewClientScript, rewriteLocation, safePath } from './preview-proxy.js'

const listen = (server: http.Server) => new Promise<number>((resolve) => {
  server.listen(0, '127.0.0.1', () => { resolve((server.address() as AddressInfo).port) })
})

function request(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => { resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString() }) })
    }).on('error', reject)
  })
}

describe('preview proxy helpers', () => {
  it('keeps redirects on the proxy', () => {
    expect(safePath('/settings?a=1')).toBe('/settings?a=1')
    expect(safePath('//evil.example.com')).toBe('/')
    expect(safePath('/\\evil.example.com')).toBe('/')
    expect(safePath('/\t/evil.example/x')).toBe('/')
    expect(safePath('/a\nb')).toBe('/')
    expect(safePath('/a\\b')).toBe('/')
    expect(safePath('/settings#tab')).toBe('/settings#tab')
    expect(safePath('https://evil.example.com')).toBe('/')
    expect(safePath(null)).toBe('/')
  })

  it('turns redirects to the dev server into paths', () => {
    expect(rewriteLocation('http://localhost:5173/login?x=1', 5173)).toBe('/login?x=1')
    expect(rewriteLocation('http://127.0.0.1:5173/', 5173)).toBe('/')
    expect(rewriteLocation('http://localhost:9999/', 5173)).toBe('http://localhost:9999/')
    expect(rewriteLocation('https://auth.example.com/', 5173)).toBe('https://auth.example.com/')
    expect(rewriteLocation('/relative', 5173)).toBe('/relative')
  })

  it('lets the page be framed and drops cookie domains', () => {
    const out = downstreamHeaders({
      'x-frame-options': 'DENY',
      'content-security-policy': "default-src 'self'; frame-ancestors 'none'",
      'set-cookie': ['sid=1; Domain=localhost; Path=/', 'codekin_preview_4000_holder=forged; Path=/'],
      connection: 'keep-alive',
    }, 5173)
    expect(out['x-frame-options']).toBeUndefined()
    expect(out.connection).toBeUndefined()
    expect(out['content-security-policy']).toEqual(["default-src 'self'"])
    expect(out['set-cookie']).toEqual(['sid=1; Path=/'])
  })

  it('adds the script early in <head>', () => {
    expect(injectScript('<html><head><title>x</title></head></html>')).toBe(`<html><head><script src="${PREVIEW_SCRIPT_PATH}"></script><title>x</title></head></html>`)
    expect(injectScript('<!doctype html><HEAD lang="en"><body>')).toContain(`<HEAD lang="en"><script src="${PREVIEW_SCRIPT_PATH}">`)
    expect(injectScript('<p>bare</p>')).toBe(`<script src="${PREVIEW_SCRIPT_PATH}"></script><p>bare</p>`)
  })
})

describe('createPreviewProxy', () => {
  let upstream: http.Server
  let proxy: http.Server
  let upstreamPort: number
  let proxyPort: number
  let seen: http.IncomingHttpHeaders[]
  const key = 'k'.repeat(32)
  const cookie = () => `codekin_preview_${proxyPort}=${key}; app=1`

  beforeEach(async () => {
    seen = []
    upstream = http.createServer((req, res) => {
      seen.push(req.headers)
      if (req.url === '/redirect') { res.writeHead(302, { Location: `http://localhost:${upstreamPort}/next` }); res.end(); return }
      if (req.url === '/data') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}'); return }
      res.writeHead(200, { 'Content-Type': 'text/html', 'X-Frame-Options': 'SAMEORIGIN' })
      res.end('<html><head></head><body>app</body></html>')
    })
    upstream.on('upgrade', (req, socket: net.Socket) => {
      seen.push(req.headers)
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
      socket.on('data', (d) => { socket.write(`echo:${d.toString()}`) })
    })
    upstreamPort = await listen(upstream)
    proxy = createPreviewProxy({ targetPort: upstreamPort, key, cookieName: 'placeholder', holder: 'h1', targetHosts: ['127.0.0.1'] })
    proxyPort = await listen(proxy)
    // The cookie is per proxy port; rebuild now that the port is known.
    proxy.close()
    proxy = createPreviewProxy({ targetPort: upstreamPort, key, cookieName: `codekin_preview_${proxyPort}`, holder: 'h1', targetHosts: ['127.0.0.1'] })
    await new Promise<void>((resolve) => proxy.listen(proxyPort, '127.0.0.1', resolve))
  })

  afterEach(() => {
    proxy.closeAllConnections()
    proxy.close()
    upstream.closeAllConnections()
    upstream.close()
  })

  it('admits only a browser that opened the entry URL', async () => {
    expect((await request(proxyPort, '/')).status).toBe(403)
    expect((await request(proxyPort, `${PREVIEW_ENTRY_PATH}?k=wrong&to=/`)).status).toBe(403)
    const entry = await request(proxyPort, `${PREVIEW_ENTRY_PATH}?k=${key}&to=${encodeURIComponent('/settings')}`)
    expect(entry.status).toBe(302)
    expect(entry.headers.location).toBe('/settings')
    expect(entry.headers['set-cookie']?.[0]).toMatch(new RegExp(`^codekin_preview_${proxyPort}=${key}; Path=/; HttpOnly; SameSite=Lax`))
    expect(seen).toHaveLength(0)
  })

  it('forwards as the dev server\'s own host, and adds the script to HTML', async () => {
    const res = await request(proxyPort, '/', { cookie: cookie(), origin: `http://127.0.0.1:${proxyPort}` })
    expect(res.status).toBe(200)
    expect(res.headers['x-frame-options']).toBeUndefined()
    expect(res.body).toContain(`<script src="${PREVIEW_SCRIPT_PATH}"></script>`)
    expect(Number(res.headers['content-length'])).toBe(Buffer.byteLength(res.body))
    expect(seen[0].host).toBe(`localhost:${upstreamPort}`)
    expect(seen[0].origin).toBe(`http://localhost:${upstreamPort}`)
    // The app keeps its cookies; Codekin's key never reaches it.
    expect(seen[0].cookie).toBe('app=1')
  })

  it('passes other responses through and rewrites redirects', async () => {
    const data = await request(proxyPort, '/data', { cookie: cookie() })
    expect(data.body).toBe('{"ok":true}')
    const redirect = await request(proxyPort, '/redirect', { cookie: cookie() })
    expect(redirect.headers.location).toBe('/next')
  })

  it('serves the preview script', async () => {
    const res = await request(proxyPort, PREVIEW_SCRIPT_PATH, { cookie: cookie() })
    expect(res.headers['content-type']).toMatch(/javascript/)
    expect(res.body).toContain('codekin-preview:hello')
    // It parses as a script.
    expect(() => new Function(res.body)).not.toThrow()
  })

  it('says when the dev server is not running', async () => {
    upstream.close()
    upstream.closeAllConnections()
    await new Promise(r => setTimeout(r, 20))
    const res = await request(proxyPort, '/', { cookie: cookie() })
    expect(res.status).toBe(502)
    expect(res.body).toContain(`port ${upstreamPort}`)
  })

  it('forwards WebSocket upgrades (hot reload) with rewritten headers', async () => {
    const reply = await new Promise<string>((resolve, reject) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write([
          'GET /hmr HTTP/1.1', `Host: 127.0.0.1:${proxyPort}`, 'Upgrade: websocket', 'Connection: Upgrade',
          `Origin: http://127.0.0.1:${proxyPort}`, `Cookie: ${cookie()}`, 'Sec-WebSocket-Key: x', '', '',
        ].join('\r\n'))
      })
      let buf = ''
      socket.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('101') && !buf.includes('echo')) socket.write('ping')
        if (buf.includes('echo:ping')) { socket.destroy(); resolve(buf) }
      })
      socket.on('error', reject)
    })
    expect(reply).toContain('101 Switching Protocols')
    const up = seen.find(h => h.upgrade)!
    expect(up.host).toBe(`localhost:${upstreamPort}`)
    expect(up.origin).toBe(`http://localhost:${upstreamPort}`)
    expect(up.cookie).toBe('app=1')
  })

  it('closeAllConnections also ends upgraded connections, both ends', async () => {
    let upstreamSide: net.Socket | undefined
    upstream.prependListener('upgrade', (_req, socket: net.Socket) => { upstreamSide = socket })
    const socket = net.connect(proxyPort, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      socket.on('connect', () => {
        socket.write([
          'GET /hmr HTTP/1.1', `Host: 127.0.0.1:${proxyPort}`, 'Upgrade: websocket', 'Connection: Upgrade',
          `Origin: http://127.0.0.1:${proxyPort}`, `Cookie: ${cookie()}`, 'Sec-WebSocket-Key: x', '', '',
        ].join('\r\n'))
      })
      let buf = ''
      socket.on('data', (d) => {
        buf += d.toString()
        if (buf.includes('101') && !buf.includes('echo')) socket.write('ping')
        if (buf.includes('echo:ping')) resolve()
      })
      socket.on('error', reject)
    })
    const clientClosed = new Promise<void>(r => socket.on('close', () => r()))
    // The dev server sees the proxy hang up (http.Server keeps its end half-open).
    const upstreamEnded = new Promise<void>(r => upstreamSide!.on('end', () => r()))
    proxy.closeAllConnections()
    proxy.close()
    await Promise.all([clientClosed, upstreamEnded])
    expect(socket.destroyed).toBe(true)
  })

  it('refuses an upgrade without the key', async () => {
    const reply = await new Promise<string>((resolve) => {
      const socket = net.connect(proxyPort, '127.0.0.1', () => {
        socket.write(['GET /hmr HTTP/1.1', 'Host: x', 'Upgrade: websocket', 'Connection: Upgrade', '', ''].join('\r\n'))
      })
      let buf = ''
      socket.on('data', (d) => { buf += d.toString() })
      socket.on('close', () => { resolve(buf) })
    })
    expect(reply).toContain('403')
    expect(seen).toHaveLength(0)
  })

  it('injects the script into pages, not into fragments a page fetches', async () => {
    const page = await request(proxyPort, '/', { cookie: cookie(), 'sec-fetch-dest': 'document' })
    expect(page.body).toContain(PREVIEW_SCRIPT_PATH)
    const fragment = await request(proxyPort, '/', { cookie: cookie(), 'sec-fetch-dest': 'empty' })
    expect(fragment.body).not.toContain(PREVIEW_SCRIPT_PATH)
  })

  it('refuses service worker scripts', async () => {
    const res = await request(proxyPort, '/sw.js', { cookie: cookie(), 'service-worker': 'script' })
    expect(res.status).toBe(403)
  })

  it('answers a bad entry URL instead of throwing', async () => {
    const res = await request(proxyPort, `${PREVIEW_ENTRY_PATH}?k=${key}&to=%2F%E6%97%A5`)
    expect([302, 400]).toContain(res.status)
  })

  it('drops the upstream request when the browser goes away', async () => {
    let upstreamClosed = false
    upstream.removeAllListeners('request')
    upstream.on('request', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.write('data: 1\n\n')
      req.socket.on('close', () => { upstreamClosed = true })
    })
    await new Promise<void>((resolve) => {
      const r = http.get({ host: '127.0.0.1', port: proxyPort, path: '/events', headers: { cookie: cookie() } }, (res) => {
        res.once('data', () => { r.destroy(); resolve() })
      })
    })
    for (let i = 0; i < 40 && !upstreamClosed; i++) await new Promise(r => setTimeout(r, 25))
    expect(upstreamClosed).toBe(true)
  })
})

describe('createPreviewProxy host fallback and site data', () => {
  it('tries the next host for each request', async () => {
    const up = http.createServer((_q, r) => { r.writeHead(200, { 'Content-Type': 'text/plain' }); r.end('v4') })
    const upPort = await listen(up)
    const k = 'k'.repeat(32)
    // The first host refuses: every request still reaches the second.
    const proxy = createPreviewProxy({ targetPort: upPort, key: k, cookieName: 'c', holder: 'h1', targetHosts: ['127.0.0.2', '127.0.0.1'] })
    const port = await listen(proxy)
    try {
      for (let i = 0; i < 3; i++) expect((await request(port, '/', { cookie: `c=${k}` })).body).toBe('v4')
    } finally {
      proxy.closeAllConnections(); proxy.close(); up.closeAllConnections(); up.close()
    }
  })

  it('clears site data for each browser that last entered another holder, and only for those', async () => {
    const up = http.createServer((_q, r) => { r.writeHead(200); r.end() })
    const upPort = await listen(up)
    const k = 'k'.repeat(32)
    const proxy = createPreviewProxy({ targetPort: upPort, key: k, cookieName: 'c', holder: 'app-y', targetHosts: ['127.0.0.1'] })
    const port = await listen(proxy)
    const enter = (cookie?: string) => request(port, `${PREVIEW_ENTRY_PATH}?k=${k}&to=/`, cookie ? { cookie } : {})
    try {
      // A browser new to this origin starts clean, and is told who holds it.
      const fresh = await enter()
      expect(fresh.headers['clear-site-data']).toBe('"storage"')
      expect(fresh.headers['set-cookie']?.[1]).toMatch(/^c_holder=app-y; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+/)
      // A second browser that last held app X here is cleared too, though the first already entered.
      expect((await enter('c_holder=app-x')).headers['clear-site-data']).toBe('"storage"')
      // A browser that already entered this holder keeps the app's storage.
      expect((await enter('c_holder=app-y')).headers['clear-site-data']).toBeUndefined()
    } finally {
      proxy.closeAllConnections(); proxy.close(); up.closeAllConnections(); up.close()
    }
  })
})

describe('preview script', () => {
  it('names the Codekin port it answers', () => {
    expect(previewClientScript([32352])).toMatch(/\)\(\[32352\]\);$/)
  })
})
