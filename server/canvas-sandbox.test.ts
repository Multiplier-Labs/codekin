/** Tests for the Canvas sandbox origin: configuration, headers, frame-src and the static page server. */
import { describe, it, expect, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import type { AddressInfo } from 'net'
import type http from 'http'
import { tmpdir } from 'os'
import path from 'path'
import { sandboxConfig, sandboxFrameSrc, sandboxHeaders, startSandboxServer } from './canvas-sandbox.js'

let dir: string | null = null
let server: http.Server | null = null
afterEach(async () => {
  if (server) await new Promise(r => server!.close(r))
  server = null
  if (dir) rmSync(dir, { recursive: true, force: true })
  dir = null
})

function builtPage() {
  dir = mkdtempSync(path.join(tmpdir(), 'sandbox-'))
  mkdirSync(path.join(dir, 'assets'))
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><script type="module" src="./assets/a.js"></script>')
  writeFileSync(path.join(dir, 'assets', 'a.js'), 'console.log(1)')
  writeFileSync(path.join(dir, 'secret.txt'), 'nope')
  writeFileSync(path.join(path.dirname(dir), 'outside.js'), 'nope')
  return dir
}

describe('sandboxConfig', () => {
  it('defaults to Codekin\'s port + 1 served by Codekin', () => {
    expect(sandboxConfig(32352, {})).toMatchObject({ origin: null, port: 32353, frameAncestors: '*' })
  })
  it('uses a configured origin instead of a port', () => {
    expect(sandboxConfig(1, { CANVAS_SANDBOX_ORIGIN: 'https://sandbox.example.net/path' })).toMatchObject({ origin: 'https://sandbox.example.net', port: null })
    expect(sandboxConfig(1, { CANVAS_SANDBOX_ORIGIN: 'javascript:alert(1)' }).origin).toBeNull()
  })
  it('takes a port, or off', () => {
    expect(sandboxConfig(1, { CANVAS_SANDBOX_PORT: '40000' }).port).toBe(40000)
    expect(sandboxConfig(1, { CANVAS_SANDBOX_PORT: 'off' }).port).toBeNull()
    expect(sandboxConfig(1, { CANVAS_SANDBOX_FRAME_ANCESTORS: 'https://codekin.example.com' }).frameAncestors).toBe('https://codekin.example.com')
  })
  it('finds a built page from CANVAS_SANDBOX_DIR or FRONTEND_DIST', () => {
    const d = builtPage()
    expect(sandboxConfig(1, { CANVAS_SANDBOX_DIR: d }).dir).toBe(d)
    expect(sandboxConfig(1, { CANVAS_SANDBOX_DIR: '/nope', FRONTEND_DIST: path.dirname(d) }).dir).not.toBe('/nope')
  })
})

describe('sandbox policies', () => {
  it('lets the page run inline scripts but reach no network', () => {
    const csp = sandboxHeaders('https://codekin.example.com')['Content-Security-Policy']
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("script-src 'self' 'unsafe-inline'")
    expect(csp).not.toContain('unsafe-eval')
    expect(csp).toContain('frame-ancestors https://codekin.example.com')
  })
  it('gives Codekin a frame-src for the sandbox only', () => {
    expect(sandboxFrameSrc(sandboxConfig(1, { CANVAS_SANDBOX_ORIGIN: 'https://s.example.net' }))).toBe('https://s.example.net')
    expect(sandboxFrameSrc(sandboxConfig(32352, {}))).toBe('http://*:32353 https://*:32353')
    expect(sandboxFrameSrc(sandboxConfig(1, { CANVAS_SANDBOX_PORT: 'off' }))).toBeNull()
  })
})

describe('startSandboxServer', () => {
  it('serves the page and its assets with the sandbox headers, and nothing else', async () => {
    const d = builtPage()
    const port = 41000 + Math.floor(Math.random() * 2000)
    server = startSandboxServer({ origin: null, port, dir: d, frameAncestors: '*' }, '127.0.0.1')
    await new Promise(r => server!.once('listening', r))
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`
    const page = await fetch(`${base}/`)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'none'")
    expect(page.headers.get('content-type')).toContain('text/html')
    expect((await fetch(`${base}/assets/a.js`)).status).toBe(200)
    expect((await fetch(`${base}/secret.txt`)).status).toBe(404)
    expect((await fetch(`${base}/..%2Foutside.js`)).status).toBe(404)
    expect((await fetch(`${base}/`, { method: 'POST' })).status).toBe(405)
  })
  it('does nothing without a port or a built page', () => {
    expect(startSandboxServer({ origin: null, port: null, dir: '/x', frameAncestors: '*' }, '127.0.0.1')).toBeNull()
    expect(startSandboxServer({ origin: null, port: 1, dir: null, frameAncestors: '*' }, '127.0.0.1')).toBeNull()
  })
})
