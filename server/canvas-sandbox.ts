/**
 * Where the Canvas sandbox page lives (docs/CANVAS-SPEC.md §8).
 *
 * Content that runs code (charts, HTML artifacts) renders in a page on a
 * separate origin, never Codekin's own, which holds the session credentials.
 * There are two ways to give it one:
 *
 * - CANVAS_SANDBOX_ORIGIN=https://sandbox.example.net: a hostname you serve
 *   the built page from (dist/sandbox), e.g. with nginx and the headers from
 *   `sandboxHeaders()`. Prefer a different registrable domain from Codekin's.
 * - Otherwise Codekin serves the page itself on a second port
 *   (CANVAS_SANDBOX_PORT, default: Codekin's port + 1; "off" disables). A
 *   different port is a different origin, which is all a local or desktop
 *   install needs.
 */

import { createReadStream, existsSync, realpathSync, statSync } from 'fs'
import http from 'http'
import path from 'path'
import { fileURLToPath } from 'url'

export interface SandboxConfig {
  /** A configured public origin (https://sandbox.example.net), or null. */
  origin: string | null
  /** Port Codekin serves the page on itself, or null (disabled or a configured origin). */
  port: number | null
  /** Built page directory (dist/sandbox), or null when it isn't built. */
  dir: string | null
  /** frame-ancestors for the page's CSP. */
  frameAncestors: string
}

function findDir(env: NodeJS.ProcessEnv): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const candidates = [
    env.CANVAS_SANDBOX_DIR,
    env.FRONTEND_DIST ? path.join(env.FRONTEND_DIST, 'sandbox') : undefined,
    path.resolve(here, '../../dist/sandbox'),
    path.resolve(here, '../dist/sandbox'),
  ].filter((p): p is string => !!p)
  return candidates.find(p => existsSync(path.join(p, 'index.html'))) ?? null
}

export function sandboxConfig(codekinPort: number, env: NodeJS.ProcessEnv = process.env): SandboxConfig {
  const raw = env.CANVAS_SANDBOX_ORIGIN?.trim()
  let origin: string | null = null
  if (raw) {
    try {
      const u = new URL(raw)
      if (u.protocol === 'https:' || u.protocol === 'http:') origin = u.origin
    } catch { /* ignored below */ }
    if (!origin) console.warn(`[canvas] CANVAS_SANDBOX_ORIGIN is not an http(s) origin: ${raw}`)
  }
  const portSetting = env.CANVAS_SANDBOX_PORT?.trim()
  const port = origin || portSetting === 'off' || portSetting === '0'
    ? null
    : portSetting && /^\d+$/.test(portSetting) ? Number(portSetting) : codekinPort + 1
  return {
    origin,
    port,
    dir: findDir(env),
    frameAncestors: env.CANVAS_SANDBOX_FRAME_ANCESTORS?.trim() || '*',
  }
}

/**
 * Headers for the sandbox page. It may run inline scripts (an HTML
 * artifact's frame inherits this policy) but reaches no network, so whatever
 * it renders can only show what it carries. It holds no credentials either.
 */
export function sandboxHeaders(frameAncestors = '*'): Record<string, string> {
  return {
    'Content-Security-Policy': [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "font-src 'self' data:",
      "media-src data: blob:",
      "connect-src 'none'",
      "frame-src 'self' blob: data:",
      "base-uri 'none'",
      "form-action 'none'",
      `frame-ancestors ${frameAncestors}`,
    ].join('; '),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  }
}

/**
 * The frame-src Codekin's own pages need: the configured origin, or the
 * sandbox port on any host (the browser may reach Codekin by any name).
 */
export function sandboxFrameSrc(config: SandboxConfig): string | null {
  if (config.origin) return config.origin
  if (config.port) return `http://*:${config.port} https://*:${config.port}`
  return null
}

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
}

/** Serve the built sandbox page (static files only) on its own port. */
export function startSandboxServer(config: SandboxConfig, host: string): http.Server | null {
  if (!config.port || !config.dir) {
    if (config.port && !config.dir) console.warn('[canvas] Sandbox page not built (dist/sandbox) — charts and HTML items show their source')
    return null
  }
  const root = realpathSync(config.dir)
  const headers = sandboxHeaders(config.frameAncestors)
  const server = http.createServer((req, res) => {
    const respond = (status: number, extra: Record<string, string> = {}) => { res.writeHead(status, { ...headers, ...extra }) }
    if (req.method !== 'GET' && req.method !== 'HEAD') { respond(405); res.end(); return }
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0])
    const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
    const file = path.resolve(root, rel)
    const type = TYPES[path.extname(file)]
    if (!file.startsWith(root + path.sep) || !type || !existsSync(file) || !statSync(file).isFile()) { respond(404); res.end(); return }
    respond(200, {
      'Content-Type': type,
      'Cache-Control': rel === 'index.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
    })
    if (req.method === 'HEAD') { res.end(); return }
    createReadStream(file).pipe(res)
  })
  server.on('error', (err) => { console.warn(`[canvas] Sandbox server on port ${config.port} failed: ${err.message} — charts and HTML items show their source`) })
  server.listen(config.port, host, () => { console.log(`[canvas] Sandbox page on port ${config.port}`) })
  return server
}
