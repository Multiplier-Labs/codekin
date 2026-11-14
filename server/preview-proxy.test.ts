import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'http'
import net from 'net'
import type { AddressInfo } from 'net'
import { createPreviewProxy, downstreamHeaders, injectScript, PREVIEW_ENTRY_PATH, PREVIEW_SCRIPT_PATH, rewriteLocation, safePath } from './preview-proxy.js'

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
      'set-cookie': ['sid=1; Domain=localhost; Path=/'],
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
    proxy = createPreviewProxy({ targetPort: upstreamPort, key, cookieName: 'placeholder', targetHosts: ['127.0.0.1'] })
    proxyPort = await listen(proxy)
    // The cookie is per proxy port; rebuild now that the port is known.
    proxy.close()
    proxy = createPreviewProxy({ targetPort: upstreamPort, key, cookieName: `codekin_preview_${proxyPort}`, targetHosts: ['127.0.0.1'] })
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
})
