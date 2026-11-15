/**
 * The preview proxy (docs/CANVAS-SPEC.md §8): shows a dev server running on
 * this machine inside Canvas.
 *
 * Each preview gets its own proxy port, so the app runs on its own origin,
 * never Codekin's. The proxy forwards HTTP and WebSocket (hot reload) to one
 * localhost port and nowhere else, and:
 *
 * - admits a browser only after it opened the preview's entry URL, which
 *   carries a per-preview key (then held in an HttpOnly cookie). Codekin hands
 *   that URL only to its own authenticated clients, so another machine that
 *   can reach the port gets nothing;
 * - presents requests as the dev server's own (Host and Origin
 *   `localhost:<port>`), which dev servers' host and origin checks accept;
 * - lets the page be framed (drops X-Frame-Options and frame-ancestors) and
 *   adds a small script to HTML pages for the element picker, console errors
 *   and the location bar (see previewClientScript).
 */

import { timingSafeEqual } from 'crypto'
import http from 'http'
import net from 'net'
import { pipeline } from 'stream'

export const PREVIEW_ENTRY_PATH = '/__codekin/enter'
export const PREVIEW_SCRIPT_PATH = '/__codekin/preview.js'
/** Every cookie Codekin sets on a preview origin starts with this. */
export const PREVIEW_COOKIE_PREFIX = 'codekin_preview_'

/** The largest HTML page the proxy rewrites; larger ones pass through without the script. */
const MAX_HTML_BYTES = 8 * 1024 * 1024

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export interface PreviewProxyOptions {
  targetPort: number
  /** The secret the entry URL carries. */
  key: string
  /** Cookie that holds the key; per proxy port, since cookies don't separate ports. */
  cookieName: string
  /** Hosts to try for the target, in order (dev servers bind IPv4, IPv6 or both). */
  targetHosts?: string[]
  /**
   * Which preview holds this origin now. Each browser keeps the holder it last
   * entered in a cookie; a browser that last saw another holder (or none) gets
   * the origin's storage cleared on entry, so no app reads another's storage.
   */
  holder: string
  /** Codekin's port(s): the only parent page the injected script answers. */
  hostPorts?: number[]
}

function sameKey(a: string, b: string): boolean {
  const x = Buffer.from(a)
  const y = Buffer.from(b)
  return x.length === y.length && timingSafeEqual(x, y)
}

function cookies(header: string | undefined): Array<[string, string]> {
  if (!header) return []
  return header.split(';').map(p => p.trim()).filter(Boolean).map(p => {
    const i = p.indexOf('=')
    return i < 0 ? [p, ''] : [p.slice(0, i), p.slice(i + 1)]
  })
}

/** Codekin's own preview cookies never reach the app. */
function appCookies(header: string | undefined): string | undefined {
  const kept = cookies(header).filter(([name]) => !name.startsWith(PREVIEW_COOKIE_PREFIX))
  return kept.length ? kept.map(([k, v]) => `${k}=${v}`).join('; ') : undefined
}

/** Whether a request carries this preview's key. */
export function admitted(req: http.IncomingMessage, opts: Pick<PreviewProxyOptions, 'key' | 'cookieName'>): boolean {
  const value = cookies(req.headers.cookie).find(([name]) => name === opts.cookieName)?.[1]
  return value !== undefined && sameKey(value, opts.key)
}

/**
 * A redirect target that stays on the proxy: a path, never another host.
 * Browsers drop tabs and newlines and read backslashes as slashes, so
 * `/\t/evil.example` would leave: control characters, spaces and
 * backslashes are refused outright, and the result must resolve here.
 */
export function safePath(to: string | null | undefined): string {
  // eslint-disable-next-line no-control-regex
  if (!to || !to.startsWith('/') || /[\u0000-\u0020\u007f\\]/.test(to)) return '/'
  try {
    const u = new URL(to, 'http://proxy.invalid')
    if (u.origin !== 'http://proxy.invalid') return '/'
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return '/'
  }
}

/** Whether a response is a page (gets the preview script), not a fragment a page fetched. */
export function isDocument(req: http.IncomingMessage, html: string): boolean {
  const dest = req.headers['sec-fetch-dest']
  if (dest) return dest === 'document' || dest === 'iframe'
  return /<(html|head)[\s>]/i.test(html.slice(0, 4096))
}

/** Request headers as the dev server should see them. */
export function upstreamHeaders(req: http.IncomingMessage, targetPort: number): http.OutgoingHttpHeaders {
  const proxyOrigin = req.headers.host ? `http://${req.headers.host}` : null
  const appOrigin = `http://localhost:${targetPort}`
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === 'host' || k === 'cookie') continue
    out[k] = v
  }
  out.host = `localhost:${targetPort}`
  const cookie = appCookies(req.headers.cookie)
  if (cookie) out.cookie = cookie
  if (proxyOrigin && req.headers.origin === proxyOrigin) out.origin = appOrigin
  if (proxyOrigin && typeof req.headers.referer === 'string' && req.headers.referer.startsWith(proxyOrigin + '/')) {
    out.referer = appOrigin + req.headers.referer.slice(proxyOrigin.length)
  }
  // Bodies are rewritten for HTML only; uncompressed costs nothing on localhost.
  out['accept-encoding'] = 'identity'
  return out
}

/** Drop frame-ancestors from a CSP; null when nothing else is left. */
function withoutFrameAncestors(csp: string): string | null {
  const kept = csp.split(';').map(d => d.trim()).filter(d => d && !/^frame-ancestors(\s|$)/i.test(d))
  return kept.length ? kept.join('; ') : null
}

/** A Location header that points back at the dev server, as a path on the proxy. */
export function rewriteLocation(location: string, targetPort: number): string {
  try {
    const u = new URL(location)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname) && (u.port ? Number(u.port) : 80) === targetPort
    return local && u.protocol === 'http:' ? `${u.pathname}${u.search}${u.hash}` : location
  } catch {
    return location
  }
}

/** Response headers as the browser should see them. */
export function downstreamHeaders(headers: http.IncomingHttpHeaders, targetPort: number): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {}
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || HOP_BY_HOP.has(k) || k === 'x-frame-options') continue
    if (k === 'content-security-policy') {
      const list = (Array.isArray(v) ? v : [v]).map(withoutFrameAncestors).filter((c): c is string => !!c)
      if (list.length) (out as Record<string, string[]>)[k] = list
      continue
    }
    if (k === 'location' && typeof v === 'string') { out[k] = rewriteLocation(v, targetPort); continue }
    if (k === 'set-cookie' && Array.isArray(v)) {
      // A Domain attribute names the dev server's host, which the browser may not be on.
      // The app never sets Codekin's own cookies (the key, or the holder marker).
      const kept = v.filter(c => !c.trimStart().startsWith(PREVIEW_COOKIE_PREFIX)).map(c => c.replace(/;\s*domain=[^;]*/i, ''))
      if (kept.length) out[k] = kept
      continue
    }
    out[k] = v
  }
  return out
}

/** Add the preview script to an HTML page: early in <head>, so it sees the app's first errors. */
export function injectScript(html: string): string {
  const tag = `<script src="${PREVIEW_SCRIPT_PATH}"></script>`
  const head = /<head(\s[^>]*)?>/i.exec(html)
  if (head) return html.slice(0, head.index + head[0].length) + tag + html.slice(head.index + head[0].length)
  const root = /<html(\s[^>]*)?>/i.exec(html)
  if (root) return html.slice(0, root.index + root[0].length) + tag + html.slice(root.index + root[0].length)
  return tag + html
}

function plainPage(res: http.ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
  })
  res.end(`<!doctype html><meta charset="utf-8"><title>${title}</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#555}</style><p>${body}</p>`)
}

export function createPreviewProxy(opts: PreviewProxyOptions): http.Server {
  const hosts = opts.targetHosts ?? ['127.0.0.1', '::1']
  /** The host that answered last: tried first. Each request tries every host once. */
  let preferred = 0
  const order = () => hosts.map((_, i) => hosts[(preferred + i) % hosts.length])
  const worked = (host: string) => { preferred = Math.max(0, hosts.indexOf(host)) }

  const forward = (req: http.IncomingMessage, res: http.ServerResponse, tries: string[]) => {
    const host = tries[0]
    const upstream = http.request({
      host, port: opts.targetPort, method: req.method, path: req.url, headers: upstreamHeaders(req, opts.targetPort),
    }, (up) => {
      worked(host)
      const headers = downstreamHeaders(up.headers, opts.targetPort)
      const type = up.headers['content-type'] ?? ''
      const encoded = up.headers['content-encoding'] && up.headers['content-encoding'] !== 'identity'
      const html = /^text\/html/i.test(type) && !encoded && req.method !== 'HEAD' && up.statusCode !== 204 && up.statusCode !== 304
      if (!html) {
        res.writeHead(up.statusCode ?? 502, headers)
        // Ends or aborts together: a dead upstream ends the response, a closed response the upstream.
        pipeline(up, res, () => { upstream.destroy() })
        return
      }
      const chunks: Buffer[] = []
      let size = 0
      let passThrough = false
      up.on('data', (chunk: Buffer) => {
        if (passThrough) return
        size += chunk.length
        chunks.push(chunk)
        if (size > MAX_HTML_BYTES) {
          // Too large to rewrite: send what we have, then stream the rest.
          passThrough = true
          up.pause()
          res.writeHead(up.statusCode ?? 200, headers)
          for (const c of chunks) res.write(c)
          pipeline(up, res, () => { upstream.destroy() })
        }
      })
      up.on('end', () => {
        if (passThrough) return
        const text = Buffer.concat(chunks).toString('utf-8')
        const body = isDocument(req, text) ? Buffer.from(injectScript(text)) : Buffer.concat(chunks)
        delete headers['content-length']
        res.writeHead(up.statusCode ?? 200, { ...headers, 'content-length': body.length })
        res.end(body)
      })
      up.on('error', () => { res.destroy() })
    })
    // The browser went away (a reload, a closed stream): stop asking the dev server.
    res.on('close', () => { if (!res.writableFinished) upstream.destroy() })
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      // Another loopback address may answer; only bodiless requests can be sent again.
      const replayable = req.method === 'GET' || req.method === 'HEAD'
      if (err.code === 'ECONNREFUSED' && replayable && tries.length > 1 && !res.headersSent) { forward(req, res, tries.slice(1)); return }
      if (res.headersSent) { res.destroy(); return }
      plainPage(res, 502, 'Not running', `Nothing is answering on port ${opts.targetPort}. Start the dev server, then reload.`)
    })
    req.pipe(upstream)
  }

  const server = http.createServer((req, res) => {
    try {
      handle(req, res)
    } catch (err) {
      console.warn('[preview] bad request', err instanceof Error ? err.message : err)
      if (!res.headersSent) { res.writeHead(400); res.end() } else res.destroy()
    }
  })

  const handle = (req: http.IncomingMessage, res: http.ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://proxy')
    if (url.pathname === PREVIEW_ENTRY_PATH) {
      const key = url.searchParams.get('k')
      if (!key || !sameKey(key, opts.key)) { plainPage(res, 403, 'Preview', 'This preview link has expired. Open the preview from Codekin again.'); return }
      // Decided per browser: another browser may still hold an earlier app's storage here.
      const holderCookie = `${opts.cookieName}_holder`
      const lastHolder = cookies(req.headers.cookie).find(([name]) => name === holderCookie)?.[1]
      const clearSiteData = lastHolder === undefined || !sameKey(lastHolder, opts.holder)
      res.writeHead(302, {
        'Set-Cookie': [
          `${opts.cookieName}=${opts.key}; Path=/; HttpOnly; SameSite=Lax`,
          // Outlives the browser session, like the storage it vouches for.
          `${holderCookie}=${opts.holder}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`,
        ],
        Location: safePath(url.searchParams.get('to')),
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
        // A new holder of this origin starts clean: no storage or service worker from another app.
        ...(clearSiteData ? { 'Clear-Site-Data': '"storage"' } : {}),
      })
      res.end()
      return
    }
    if (!admitted(req, opts)) { plainPage(res, 403, 'Preview', 'Open this preview from the Canvas in Codekin.'); return }
    // Preview origins are shared over time: a service worker would outlive the app that registered it.
    if (req.headers['service-worker'] === 'script') { plainPage(res, 403, 'Preview', 'Service workers are off in Codekin previews.'); return }
    if (url.pathname === PREVIEW_SCRIPT_PATH) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-cache' })
      res.end(previewClientScript(opts.hostPorts ?? []))
      return
    }
    forward(req, res, order())
  }

  // Upgraded connections leave the server's HTTP bookkeeping, so close() and
  // closeAllConnections() miss them: track both ends here and destroy them too,
  // or a closed preview keeps talking to its old dev server.
  const upgraded = new Set<net.Socket>()
  const track = (s: net.Socket) => {
    upgraded.add(s)
    s.once('close', () => { upgraded.delete(s) })
  }
  const closeAll = server.closeAllConnections.bind(server)
  server.closeAllConnections = () => {
    closeAll()
    for (const s of upgraded) s.destroy()
    upgraded.clear()
  }

  // WebSockets (hot reload): the same admission and header rewriting, then raw bytes both ways.
  server.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
    if (!admitted(req, opts)) { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    track(socket)
    const headers = upstreamHeaders(req, opts.targetPort)
    delete headers['accept-encoding']
    const lines = [`${req.method ?? 'GET'} ${req.url ?? '/'} HTTP/1.1`]
    for (const [k, v] of Object.entries(headers)) {
      for (const value of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(value)}`)
    }
    lines.push('Connection: Upgrade', `Upgrade: ${req.headers.upgrade ?? 'websocket'}`)
    const tries = order()
    let done = false
    socket.on('error', () => { done = true })
    socket.on('close', () => { done = true })
    // Hosts are tried one after another; the client socket is wired only to the one that connects.
    const connect = (i: number) => {
      if (done) return
      const host = tries[i]
      const upstream = net.connect(opts.targetPort, host)
      track(upstream)
      let connected = false
      upstream.once('connect', () => {
        connected = true
        worked(host)
        upstream.write(lines.join('\r\n') + '\r\n\r\n')
        if (head.length) upstream.write(head)
        socket.pipe(upstream).pipe(socket)
        socket.on('close', () => { upstream.destroy() })
        upstream.on('close', () => { socket.destroy() })
      })
      upstream.on('error', (err: NodeJS.ErrnoException) => {
        if (!connected && err.code === 'ECONNREFUSED' && i + 1 < tries.length) { connect(i + 1); return }
        socket.destroy()
      })
    }
    connect(0)
  })

  return server
}

/**
 * The script added to previewed pages. It does nothing until Codekin's
 * Canvas (the parent frame) says hello, and then only talks to that origin:
 *
 * - reports the page's location and title as they change;
 * - reports console errors and warnings, uncaught errors and rejections;
 * - on request, lets the user pick an element (hover outline, click to
 *   choose, Escape to cancel) and reports it: a CSS selector, tag, text,
 *   markup excerpt and, for React dev builds, the component;
 * - goes back, forward or reloads on request.
 *
 * Everything it sends is treated by Codekin as untrusted text from the app.
 */
export function previewClientScript(hostPorts: number[] = []): string {
  return `(${previewClient.toString()})(${JSON.stringify(hostPorts)});`
}

/* c8 ignore start -- runs in the previewed page, not in Node */
function previewClient(hostPorts: number[]): void {
  const w = window as Window & { __codekinPreview?: boolean }
  if (w.__codekinPreview || window.parent === window) return
  w.__codekinPreview = true

  let host: string | null = null
  const queue: unknown[] = []
  let sent = 0
  const post = (msg: Record<string, unknown>) => {
    if (host) window.parent.postMessage(msg, host)
    else if (queue.length < 50) queue.push(msg)
  }
  const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s)

  const where = () => ({ type: 'codekin-preview:location', path: location.pathname + location.search + location.hash, title: document.title })
  const sendLocation = () => { post(where()) }
  for (const name of ['pushState', 'replaceState'] as const) {
    const original = history[name].bind(history)
    history[name] = (...args: Parameters<History['pushState']>) => { original(...args); setTimeout(sendLocation, 0) }
  }
  window.addEventListener('popstate', sendLocation)
  window.addEventListener('hashchange', sendLocation)
  window.addEventListener('load', sendLocation)

  const fmt = (v: unknown): string => {
    if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack.split('\n').slice(1, 6).join('\n')}` : ''}`
    if (typeof v === 'string') return v
    try { return JSON.stringify(v) ?? String(v) } catch { return String(v) }
  }
  const report = (level: 'error' | 'warn', message: string) => {
    if (++sent > 200) return
    post({ type: 'codekin-preview:console', level, message: clip(message, 4000), path: location.pathname })
  }
  for (const level of ['error', 'warn'] as const) {
    const original = console[level].bind(console)
    console[level] = (...args: unknown[]) => { report(level, args.map(fmt).join(' ')); original(...args) }
  }
  window.addEventListener('error', (e) => {
    report('error', e.error ? fmt(e.error) : `${e.message}${e.filename ? ` (${e.filename}:${e.lineno})` : ''}`)
  })
  window.addEventListener('unhandledrejection', (e) => { report('error', `Unhandled rejection: ${fmt(e.reason)}`) })

  // --- element picker ---
  let picking = false
  let box: HTMLDivElement | null = null
  let tag: HTMLDivElement | null = null
  let hovered: Element | null = null

  const selectorFor = (el: Element): string => {
    const parts: string[] = []
    let node: Element | null = el
    while (node && node.nodeType === 1 && parts.length < 6) {
      const testId = node.getAttribute('data-testid')
      if (node.id) { parts.unshift(`#${CSS.escape(node.id)}`); break }
      if (testId) { parts.unshift(`[data-testid="${testId.replace(/"/g, '\\"')}"]`); break }
      let part = node.tagName.toLowerCase()
      const parent: Element | null = node.parentElement
      if (parent) {
        const same = Array.from(parent.children).filter(c => c.tagName === node!.tagName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
      }
      parts.unshift(part)
      node = parent
    }
    return parts.join(' > ')
  }
  const label = (el: Element) => {
    const cls = typeof el.className === 'string' && el.className.trim() ? `.${el.className.trim().split(/\s+/).slice(0, 2).join('.')}` : ''
    return `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${cls}`
  }
  /** The React component that rendered an element, in development builds. */
  const component = (el: Element): { name?: string; source?: string } | undefined => {
    try {
      const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'))
      if (!key) return undefined
      type Fiber = { type?: unknown; return?: Fiber | null; _debugSource?: { fileName?: string; lineNumber?: number } }
      let fiber = (el as unknown as Record<string, Fiber | undefined>)[key]
      let source: string | undefined
      for (let i = 0; fiber && i < 30; i++, fiber = fiber.return ?? undefined) {
        if (!source && fiber._debugSource?.fileName) source = `${fiber._debugSource.fileName}:${fiber._debugSource.lineNumber ?? 0}`
        const t = fiber.type as { displayName?: string; name?: string } | string | undefined
        if (typeof t === 'function' || (typeof t === 'object' && t)) {
          const name = (t as { displayName?: string; name?: string }).displayName || (t as { name?: string }).name
          if (name) return { name, ...(source ? { source } : {}) }
        }
      }
      return source ? { source } : undefined
    } catch {
      return undefined
    }
  }
  const draw = (el: Element) => {
    const r = el.getBoundingClientRect()
    if (!box || !tag) return
    Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` })
    tag.textContent = label(el)
    Object.assign(tag.style, { left: `${Math.max(0, r.left)}px`, top: `${r.top > 22 ? r.top - 22 : r.bottom + 2}px` })
  }
  const onMove = (e: MouseEvent) => {
    const el = e.target as Element | null
    if (!el || el === box || el === tag) return
    hovered = el
    draw(el)
  }
  const swallow = (e: Event) => { e.preventDefault(); e.stopPropagation(); e.stopImmediatePropagation() }
  const onClick = (e: MouseEvent) => {
    swallow(e)
    const el = hovered ?? (e.target as Element | null)
    if (!el) return
    const r = el.getBoundingClientRect()
    const text = (el as HTMLElement).innerText?.replace(/\s+/g, ' ').trim() ?? ''
    post({
      type: 'codekin-preview:picked',
      selector: selectorFor(el),
      tag: el.tagName.toLowerCase(),
      label: label(el),
      text: clip(text, 300),
      html: clip(el.outerHTML, 3000),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      path: location.pathname + location.search,
      component: component(el),
    })
    setPicking(false)
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { swallow(e); setPicking(false) } }
  const blockers = ['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'dblclick', 'contextmenu'] as const
  function setPicking(on: boolean) {
    if (on === picking) return
    picking = on
    if (on) {
      box = document.createElement('div')
      tag = document.createElement('div')
      Object.assign(box.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', outline: '2px solid #f97316', background: 'rgba(249,115,22,0.10)', borderRadius: '2px' })
      Object.assign(tag.style, { position: 'fixed', zIndex: '2147483647', pointerEvents: 'none', font: '11px/18px ui-monospace,monospace', padding: '0 6px', background: '#f97316', color: '#fff', borderRadius: '3px', whiteSpace: 'nowrap' })
      document.documentElement.append(box, tag)
      document.addEventListener('mousemove', onMove, true)
      document.addEventListener('click', onClick, true)
      document.addEventListener('keydown', onKey, true)
      for (const b of blockers) document.addEventListener(b, swallow, true)
      document.documentElement.style.cursor = 'crosshair'
    } else {
      box?.remove(); tag?.remove(); box = null; tag = null; hovered = null
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('click', onClick, true)
      document.removeEventListener('keydown', onKey, true)
      for (const b of blockers) document.removeEventListener(b, swallow, true)
      document.documentElement.style.cursor = ''
      post({ type: 'codekin-preview:pick-ended' })
    }
  }

  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return
    const d = e.data as { type?: unknown; on?: unknown; go?: unknown } | null
    if (!d || typeof d.type !== 'string' || !d.type.startsWith('codekin-preview:')) return
    if (d.type === 'codekin-preview:hello') {
      if (host && host !== e.origin) return
      // Only Codekin itself: a top-level page on Codekin's port. Another
      // page that frames this preview gets nothing.
      if (window.parent !== window.top) return
      const u = new URL(e.origin)
      const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80))
      if (hostPorts.length && !hostPorts.includes(port)) return
      host = e.origin
      for (const m of queue.splice(0)) window.parent.postMessage(m, host)
      sendLocation()
      return
    }
    if (e.origin !== host) return
    if (d.type === 'codekin-preview:pick') setPicking(d.on === true)
    else if (d.type === 'codekin-preview:history') history.go(d.go === 1 ? 1 : -1)
    else if (d.type === 'codekin-preview:reload') location.reload()
  })
  // Ask the parent to introduce itself; this carries nothing.
  window.parent.postMessage({ type: 'codekin-preview:ready' }, '*')
}
/* c8 ignore stop */
