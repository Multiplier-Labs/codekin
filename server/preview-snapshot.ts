/**
 * Preview snapshots (docs/CANVAS-SPEC.md §8, "Snapshots"): load a dev server
 * page in a headless Chrome or Chromium on this machine and take a
 * screenshot, with the console errors and warnings seen while it loaded.
 *
 * A snapshot travels as an ordinary image item, so it reaches every client
 * that can see Canvas, including the hosted web app through a relay, where
 * the live preview can't be shown.
 *
 * - The browser is driven over `--remote-debugging-pipe`, so no debugging
 *   port is opened on the machine.
 * - Each snapshot gets a fresh, temporary profile: no cookies, storage or
 *   logins carry over, and nothing is left behind.
 * - When Chrome's sandbox can't start (Ubuntu 23.10+ restricts the user
 *   namespaces it needs), the snapshot fails with setup guidance, unless
 *   `CANVAS_SNAPSHOT_NO_SANDBOX=1` allows running without it. The page then
 *   only reaches localhost: every other request goes to a dead proxy.
 */

import { spawn, type ChildProcess } from 'child_process'
import { existsSync, readdirSync, statSync } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { homedir, platform, tmpdir } from 'os'
import path from 'path'
import type { Readable, Writable } from 'stream'

export interface SnapshotConsoleEntry {
  level: 'error' | 'warn'
  message: string
  /** Page path it happened on. */
  path: string
  at: number
}

export interface SnapshotOptions {
  /** Dev server port on this machine. */
  port: number
  /** Path to load, starting with '/'. */
  path: string
  width: number
  height: number
  /** Emulate a phone (touch, mobile viewport, 2x pixels). */
  mobile?: boolean
}

export interface SnapshotResult {
  image: Buffer
  mediaType: 'image/png' | 'image/jpeg'
  /** Path (with query and hash) the page ended on, and its title. */
  finalPath: string
  title: string
  console: SnapshotConsoleEntry[]
  /** Chrome ran without its sandbox, so requests beyond localhost were blocked. */
  restricted: boolean
  /** How many requests were blocked for leaving this machine (restricted only). */
  blocked: number
}

export class SnapshotError extends Error {}

/** Snapshot images must fit a Canvas image item. */
export const SNAPSHOT_MAX_BYTES = 2 * 1024 * 1024
const MAX_CONSOLE = 50
const MAX_MESSAGE = 1000
const TOTAL_TIMEOUT_MS = 30_000
const LOAD_TIMEOUT_MS = 15_000
/** After load, wait for the network to be quiet this long (single-page apps fetch after load)… */
const QUIET_MS = 500
/** …but no longer than this. */
const SETTLE_MAX_MS = 5_000
/** What a request gets from the dead proxy when the page may reach only localhost. */
const BLOCKED_ERROR = 'net::ERR_PROXY_CONNECTION_FAILED'

// --- finding a browser -------------------------------------------------------

const PATH_NAMES = ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'chrome', 'microsoft-edge']
const MAC_APPS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]
/** Inside a Playwright browser folder, where its executable is. Headless shells first: smaller and faster. */
const PLAYWRIGHT_EXECUTABLES: Array<[prefix: string, rel: string[]]> = [
  ['chromium_headless_shell-', [
    'chrome-headless-shell-linux64/chrome-headless-shell',
    'chrome-headless-shell-mac-arm64/chrome-headless-shell',
    'chrome-headless-shell-mac-x64/chrome-headless-shell',
    'chrome-linux/headless_shell',
    'chrome-mac/headless_shell',
  ]],
  ['chromium-', [
    'chrome-linux64/chrome',
    'chrome-linux/chrome',
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ]],
]

function isExecutable(file: string): boolean {
  try {
    const s = statSync(file)
    return s.isFile() && (s.mode & 0o111) !== 0
  } catch {
    return false
  }
}

function onPath(name: string, envPath: string | undefined): string | null {
  for (const dir of (envPath ?? '').split(path.delimiter)) {
    if (!dir) continue
    const file = path.join(dir, name)
    if (isExecutable(file)) return file
  }
  return null
}

/** The newest Playwright-installed Chromium, if any. */
function playwrightBrowser(env: NodeJS.ProcessEnv, os: NodeJS.Platform): string | null {
  const roots = [
    env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0' ? env.PLAYWRIGHT_BROWSERS_PATH : null,
    os === 'darwin' ? path.join(homedir(), 'Library', 'Caches', 'ms-playwright') : path.join(homedir(), '.cache', 'ms-playwright'),
  ].filter((r): r is string => !!r && existsSync(r))
  for (const root of roots) {
    let dirs: string[]
    try { dirs = readdirSync(root) } catch { continue }
    for (const [prefix, rels] of PLAYWRIGHT_EXECUTABLES) {
      const versions = dirs.filter(d => d.startsWith(prefix) && /^\d+$/.test(d.slice(prefix.length)))
        .sort((a, b) => Number(b.slice(prefix.length)) - Number(a.slice(prefix.length)))
      for (const dir of versions) {
        for (const rel of rels) {
          const file = path.join(root, dir, rel)
          if (isExecutable(file)) return file
        }
      }
    }
  }
  return null
}

/**
 * The browser snapshots use: `CANVAS_SNAPSHOT_BROWSER` (a path, or `off`),
 * else Chrome, Chromium or Edge on PATH or in /Applications, else a browser
 * Playwright installed. Null when there is none (or snapshots are off).
 */
export function findSnapshotBrowser(env: NodeJS.ProcessEnv = process.env, os: NodeJS.Platform = platform()): string | null {
  const configured = env.CANVAS_SNAPSHOT_BROWSER?.trim()
  if (configured) {
    if (configured === 'off') return null
    return isExecutable(configured) ? configured : null
  }
  for (const name of PATH_NAMES) {
    const found = onPath(name, env.PATH)
    if (found) return found
  }
  if (os === 'darwin') {
    for (const app of MAC_APPS) if (isExecutable(app)) return app
  }
  return playwrightBrowser(env, os)
}

/** Whether this machine allows snapshots without Chrome's sandbox (`CANVAS_SNAPSHOT_NO_SANDBOX=1`). */
export function noSandboxAllowed(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(env.CANVAS_SNAPSHOT_NO_SANDBOX?.trim() ?? '')
}

export const NO_SANDBOX_MESSAGE =
  "Chrome's sandbox can't start on this computer (Ubuntu 23.10 and later restrict the user namespaces it needs). " +
  'Use a browser that ships an AppArmor profile, or set CANVAS_SNAPSHOT_NO_SANDBOX=1 to take snapshots without the sandbox; ' +
  'the page can then load only from this computer.'

/** Command-line flags for one snapshot browser. */
export function browserArgs(profileDir: string, sandboxed: boolean): string[] {
  const args = [
    '--headless=new',
    '--remote-debugging-pipe',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--disable-default-apps',
    '--disable-domain-reliability',
    '--no-pings',
    '--mute-audio',
    '--hide-scrollbars',
    '--disable-gpu',
    '--password-store=basic',
    '--use-mock-keychain',
    'about:blank',
  ]
  if (!sandboxed) {
    // No sandbox: keep the page to this machine. Chrome sends localhost
    // straight to the server and everything else to the proxy, which isn't there.
    args.unshift('--no-sandbox', '--proxy-server=socks5://127.0.0.1:9', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp')
  }
  return args
}

// --- a minimal DevTools protocol client over the pipe -----------------------

interface CdpMessage {
  id?: number
  method?: string
  params?: Record<string, unknown>
  sessionId?: string
  result?: Record<string, unknown>
  error?: { message?: string }
}

class Cdp {
  private nextId = 1
  private pending = new Map<number, { resolve: (r: Record<string, unknown>) => void; reject: (e: Error) => void }>()
  private listeners = new Set<(msg: CdpMessage) => void>()
  private buffer = ''
  private closed: Error | null = null

  constructor(private readonly out: Writable, input: Readable) {
    input.setEncoding('utf8')
    input.on('data', (chunk: string) => {
      this.buffer += chunk
      let end: number
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        let msg: CdpMessage
        try { msg = JSON.parse(raw) as CdpMessage } catch { continue }
        if (msg.id !== undefined) {
          const p = this.pending.get(msg.id)
          if (!p) continue
          this.pending.delete(msg.id)
          if (msg.error) p.reject(new SnapshotError(msg.error.message ?? 'The browser refused a command.'))
          else p.resolve(msg.result ?? {})
        } else {
          for (const l of this.listeners) l(msg)
        }
      }
    })
    const fail = () => { this.close(new SnapshotError('The browser closed.')) }
    input.on('close', fail)
    input.on('error', fail)
    out.on('error', fail)
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(this.closed)
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.out.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
    })
  }

  on(listener: (msg: CdpMessage) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  close(err: Error): void {
    if (this.closed) return
    this.closed = err
    for (const p of this.pending.values()) p.reject(err)
    this.pending.clear()
  }
}

// --- taking a snapshot ------------------------------------------------------

function clip(text: string): string {
  return text.length > MAX_MESSAGE ? `${text.slice(0, MAX_MESSAGE)}…` : text
}

/** A console call's arguments as one line of text. */
function consoleText(args: unknown): string {
  if (!Array.isArray(args)) return ''
  return args.map((a) => {
    const r = a as { value?: unknown; description?: string; unserializableValue?: string; type?: string }
    if (typeof r.value === 'string') return r.value
    if (r.value !== undefined && r.value !== null && typeof r.value !== 'object') return String(r.value as string | number | boolean)
    if (r.value !== undefined) { try { return JSON.stringify(r.value) } catch { /* below */ } }
    return r.description ?? r.unserializableValue ?? r.type ?? ''
  }).join(' ')
}

function pathOf(url: unknown): string {
  if (typeof url !== 'string') return ''
  try {
    const u = new URL(url)
    return `${u.pathname}${u.search}${u.hash}`
  } catch {
    return ''
  }
}

function launch(executable: string, profileDir: string, sandboxed: boolean): { proc: ChildProcess; cdp: Cdp; stderr: () => string } {
  const proc = spawn(executable, browserArgs(profileDir, sandboxed), {
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
    // Its own process group, so stopping it takes its helpers too.
    detached: true,
  })
  let err = ''
  proc.stderr?.setEncoding('utf8')
  proc.stderr?.on('data', (d: string) => { if (err.length < 16_384) err += d })
  const cdp = new Cdp(proc.stdio[3] as Writable, proc.stdio[4] as Readable)
  proc.once('exit', () => { cdp.close(new SnapshotError('The browser closed.')) })
  proc.once('error', (e) => { cdp.close(new SnapshotError(`The browser could not start: ${e.message}`)) })
  return { proc, cdp, stderr: () => err }
}

function stop(proc: ChildProcess): void {
  if (proc.exitCode !== null || proc.signalCode !== null || !proc.pid) return
  try { process.kill(-proc.pid, 'SIGKILL') } catch { try { proc.kill('SIGKILL') } catch { /* gone */ } }
}

/** Resolves when the process and its pipes are closed, or after `ms`. */
function exited(proc: ChildProcess, ms: number): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return new Promise((resolve) => { const t = setTimeout(resolve, 50); proc.stderr?.once('close', () => { clearTimeout(t); resolve() }) })
  }
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms)
    proc.once('close', () => { clearTimeout(t); resolve() })
  })
}

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p.finally(() => { clearTimeout(timer) }),
    new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new SnapshotError(message)) }, ms) }),
  ])
}

async function capture(cdp: Cdp, opts: SnapshotOptions, restricted: boolean): Promise<SnapshotResult> {
  await cdp.send('Browser.getVersion')
  const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' }) as { targetId: string }
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId: string }
  const page = (method: string, params: Record<string, unknown> = {}) => cdp.send(method, params, sessionId)

  const entries: SnapshotConsoleEntry[] = []
  let currentPath = opts.path
  const add = (level: 'error' | 'warn', message: string, at = Date.now()) => {
    if (!message || entries.length >= MAX_CONSOLE) return
    entries.push({ level, message: clip(message), path: currentPath, at })
  }
  let blocked = 0
  let inflight = 0
  let lastActivity = Date.now()
  let loaded!: () => void
  const loadFired = new Promise<void>((resolve) => { loaded = resolve })
  const off = cdp.on((msg) => {
    if (msg.sessionId !== sessionId || !msg.method) return
    const p = msg.params ?? {}
    switch (msg.method) {
      case 'Page.loadEventFired': loaded(); break
      case 'Page.frameNavigated': {
        const frame = p.frame as { parentId?: string; url?: string } | undefined
        if (frame && !frame.parentId) currentPath = pathOf(frame.url) || currentPath
        break
      }
      case 'Network.requestWillBeSent': inflight++; lastActivity = Date.now(); break
      case 'Network.loadingFinished': inflight = Math.max(0, inflight - 1); lastActivity = Date.now(); break
      case 'Network.loadingFailed':
        inflight = Math.max(0, inflight - 1)
        lastActivity = Date.now()
        if (restricted && p.errorText === BLOCKED_ERROR) blocked++
        break
      case 'Runtime.consoleAPICalled': {
        const type = p.type as string
        if (type === 'error' || type === 'assert') add('error', consoleText(p.args))
        else if (type === 'warning') add('warn', consoleText(p.args))
        break
      }
      case 'Runtime.exceptionThrown': {
        const d = p.exceptionDetails as { text?: string; exception?: { description?: string } } | undefined
        add('error', d?.exception?.description ?? d?.text ?? 'Uncaught error')
        break
      }
      case 'Log.entryAdded': {
        const e = p.entry as { level?: string; text?: string; url?: string } | undefined
        // Requests blocked for leaving the machine are counted, not listed.
        if (restricted && e?.text?.includes(BLOCKED_ERROR)) break
        if (e?.level === 'error' || e?.level === 'warning') add(e.level === 'error' ? 'error' : 'warn', e.url ? `${e.text ?? ''} (${e.url})` : e.text ?? '')
        break
      }
    }
  })
  try {
    await Promise.all([page('Page.enable'), page('Runtime.enable'), page('Log.enable'), page('Network.enable')])
    await page('Emulation.setDeviceMetricsOverride', {
      width: opts.width, height: opts.height, deviceScaleFactor: opts.mobile ? 2 : 1, mobile: !!opts.mobile,
    })
    if (opts.mobile) await page('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 })

    const nav = await page('Page.navigate', { url: `http://localhost:${opts.port}${opts.path}` }) as { errorText?: string }
    if (nav.errorText) {
      throw new SnapshotError(nav.errorText === 'net::ERR_CONNECTION_REFUSED'
        ? `Nothing answered on localhost:${opts.port}. Start the dev server, then take the snapshot again.`
        : `The page didn't load: ${nav.errorText}.`)
    }
    await withTimeout(loadFired, LOAD_TIMEOUT_MS, 'The page took longer than 15 seconds to load.')
    // Let a single-page app fetch and render what it does after load.
    const settleUntil = Date.now() + SETTLE_MAX_MS
    while (Date.now() < settleUntil && (inflight > 0 || Date.now() - lastActivity < QUIET_MS)) {
      await new Promise(r => setTimeout(r, 100))
    }

    const where = await page('Runtime.evaluate', {
      expression: 'JSON.stringify([location.pathname + location.search + location.hash, document.title])',
      returnByValue: true,
    }) as { result?: { value?: unknown } }
    let finalPath = currentPath
    let title = ''
    try {
      const value = where.result?.value
      const [p, t] = JSON.parse(typeof value === 'string' ? value : '[]') as [unknown, unknown]
      if (typeof p === 'string') finalPath = p
      if (typeof t === 'string') title = t.slice(0, 200)
    } catch { /* keep the defaults */ }

    let shot = await page('Page.captureScreenshot', { format: 'png' }) as { data?: string }
    let image = Buffer.from(shot.data ?? '', 'base64')
    let mediaType: SnapshotResult['mediaType'] = 'image/png'
    for (const quality of [85, 65, 45]) {
      if (image.length <= SNAPSHOT_MAX_BYTES) break
      shot = await page('Page.captureScreenshot', { format: 'jpeg', quality }) as { data?: string }
      image = Buffer.from(shot.data ?? '', 'base64')
      mediaType = 'image/jpeg'
    }
    if (!image.length) throw new SnapshotError('The browser returned no image.')
    if (image.length > SNAPSHOT_MAX_BYTES) throw new SnapshotError('The snapshot is too large to keep. Try a smaller viewport.')
    return { image, mediaType, finalPath, title, console: entries, restricted, blocked }
  } finally {
    off()
  }
}

/**
 * Run one snapshot in a fresh browser; the browser and its profile are gone afterwards.
 * Each browser launch, Chrome's start-up included, is limited to `timeoutMs`.
 */
export async function takeSnapshot(
  executable: string,
  opts: SnapshotOptions,
  allowNoSandbox = noSandboxAllowed(),
  timeoutMs = TOTAL_TIMEOUT_MS,
): Promise<SnapshotResult> {
  const run = async (sandboxed: boolean): Promise<SnapshotResult> => {
    const profileDir = await mkdtemp(path.join(tmpdir(), 'codekin-snapshot-'))
    const { proc, cdp, stderr } = launch(executable, profileDir, sandboxed)
    try {
      return await withTimeout(capture(cdp, opts, !sandboxed), timeoutMs, `The snapshot took longer than ${Math.round(timeoutMs / 1000)} seconds.`)
    } catch (err) {
      // A browser that died at once has its reason on stderr: let it arrive.
      await exited(proc, 1000)
      if (sandboxed && /No usable sandbox/i.test(stderr())) throw new NoSandbox()
      if (err instanceof SnapshotError && /browser (closed|could not start)/.test(err.message)) {
        const detail = stderr().split('\n').map(l => l.trim()).find(l => /FATAL|ERROR|error/.test(l))
        throw new SnapshotError(detail ? `${err.message} ${clip(detail)}` : err.message)
      }
      throw err
    } finally {
      cdp.close(new SnapshotError('Done.'))
      stop(proc)
      await rm(profileDir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
  try {
    return await run(true)
  } catch (err) {
    if (!(err instanceof NoSandbox)) throw err
    // Running without the sandbox is the machine owner's call, never a silent fallback.
    if (!allowNoSandbox) throw new SnapshotError(NO_SANDBOX_MESSAGE)
    return run(false)
  }
}

class NoSandbox extends Error {}
