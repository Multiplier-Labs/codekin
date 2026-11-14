/**
 * Live previews (docs/CANVAS-SPEC.md §8): dev servers on this machine shown
 * in a session's Canvas.
 *
 * A preview item names a local port. Opening it gives it a proxy on one of
 * Codekin's preview ports (preview-proxy.ts), so the app runs on its own
 * origin, and watches whether the port answers. Servers get running in two
 * ways, and Codekin runs a command only in the second:
 *
 * - the agent starts one in its own shell (under the session's approval
 *   rules) and calls canvas_preview with the port;
 * - the user starts a configuration from the repository's
 *   `.claude/launch.json`, after seeing its command. Codekin then owns that
 *   process: it keeps its output, and stops it with the preview, the session
 *   or Codekin itself.
 */

import { spawn, type ChildProcess } from 'child_process'
import { randomBytes } from 'crypto'
import type http from 'http'
import net from 'net'
import type { CanvasPublishInput } from './canvas-sessions.js'
import { CanvasError } from './canvas-store.js'
import { buildHarnessEnv } from './harness-env.js'
import { launchDigest, publicConfig, readLaunchConfigs, type ResolvedLaunchConfig } from './preview-config.js'
import { createPreviewProxy, PREVIEW_ENTRY_PATH } from './preview-proxy.js'
import type { CanvasItem, CanvasItemSource, PreviewState, PreviewStatus, PreviewTarget, Session, WsServerMessage } from './types.js'

export interface PreviewSettings {
  /** Ports Codekin may run preview proxies on; empty turns previews off. */
  ports: number[]
  /** Address the proxies listen on (Codekin's BIND_HOST). */
  host: string
  /** Target ports a preview may not show: Codekin's own, the sandbox's, the proxies'. */
  denied: Set<number>
  /** Codekin's own port: the only parent page the preview script answers. */
  codekinPort?: number
}

/**
 * Preview proxy ports: CANVAS_PREVIEW_PORTS as a range ("32362-32371") or a
 * list ("4000,4001"), "off" to disable; by default the ten ports from
 * Codekin's port + 10.
 */
export function previewSettings(codekinPort: number, sandboxPort: number | null, host: string, env: NodeJS.ProcessEnv = process.env): PreviewSettings {
  const raw = env.CANVAS_PREVIEW_PORTS?.trim()
  let ports: number[] = []
  if (raw === 'off' || raw === '0') ports = []
  else if (raw) {
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(raw)
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])]
      for (let p = Math.min(a, b); p <= Math.max(a, b) && ports.length < 100; p++) ports.push(p)
    } else {
      ports = raw.split(',').map(s => Number(s.trim())).filter(p => Number.isInteger(p))
    }
    ports = ports.filter(p => p >= 1 && p <= 65535 && p !== codekinPort && p !== sandboxPort)
    if (!ports.length) console.warn(`[preview] CANVAS_PREVIEW_PORTS gives no usable port: ${raw} — previews are off`)
  } else {
    for (let p = codekinPort + 10; p < codekinPort + 20 && p <= 65535; p++) ports.push(p)
  }
  return { ports, host, denied: new Set([codekinPort, ...(sandboxPort ? [sandboxPort] : []), ...ports]), codekinPort }
}

/** frame-src entries for Codekin's pages: the preview ports on any host (the browser may reach Codekin by any name). */
export function previewFrameSrc(settings: PreviewSettings): string | null {
  return settings.ports.length ? settings.ports.map(p => `http://*:${p}`).join(' ') : null
}

/** Whether something accepts connections on a local port (IPv4 or IPv6 loopback). */
export function probePort(port: number, hosts = ['127.0.0.1', '::1'], timeoutMs = 800): Promise<boolean> {
  const one = (host: string) => new Promise<boolean>((resolve) => {
    const socket = net.connect({ port, host })
    const done = (ok: boolean) => { socket.destroy(); resolve(ok) }
    socket.setTimeout(timeoutMs, () => { done(false) })
    socket.once('connect', () => { done(true) })
    socket.once('error', () => { done(false) })
  })
  return Promise.all(hosts.map(one)).then(r => r.some(Boolean))
}

/** Credentials in Codekin's environment (API keys, tokens, webhook secrets): a dev server gets none of them. */
const SECRET_NAME = /(^|_)(TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_KEY|CREDENTIALS?|AUTH_FILE)(_|$)/i

/**
 * The dev server's environment: what agent CLIs get, without Codekin's own
 * variables, credentials or NODE_ENV (a production NODE_ENV on the host
 * breaks dev servers), plus the configuration's env and PORT.
 */
export function devServerEnv(extra: Record<string, string>, port: number): Record<string, string> {
  const own = (key: string) => key === 'NODE_ENV' || key.startsWith('CODEKIN_') || key.startsWith('CANVAS_') || key.startsWith('RELAY_') || SECRET_NAME.test(key)
  const env = Object.fromEntries(Object.entries(buildHarnessEnv()).filter(([key]) => !own(key)))
  return { ...env, PORT: String(port), ...extra }
}

// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;?]{0,32}[ -/]{0,8}[@-~]|\x1b\][^\x07\x1b]{0,512}\x07/g
const MAX_LOG_LINES = 1000
const MAX_LINE = 2000
const PROBE_MS = 3000
const STARTING_PROBE_MS = 500
const START_TIMEOUT_MS = 120_000
const KILL_GRACE_MS = 5000

interface Proxy { server: http.Server; port: number; key: string }

/** A launch the user approved no longer matches the file. */
const CHANGED = 'The launch configuration changed since you saw it. Check the command and start it again.'

interface Entry {
  sessionId: string
  itemId: string
  targetPort: number
  path: string
  config?: string
  proxy?: Proxy
  proc?: ChildProcess
  managed: boolean
  command?: string
  status: PreviewStatus
  exitCode?: number | null
  error?: string
  notice?: string
  startedAt?: number
  stopping?: boolean
  /** The configuration it was started with: Restart runs exactly this again. */
  launched?: ResolvedLaunchConfig
  logs: string[]
  pending: string[]
  partial: Record<'out' | 'err', string>
  logTimer?: ReturnType<typeof setTimeout>
  probeTimer?: ReturnType<typeof setTimeout>
  lastUsed: number
}

export interface PreviewManagerDeps {
  getSession: (id: string) => Session | undefined
  broadcast: (session: Session, msg: WsServerMessage) => void
  /** A preview item's target, or null when the item isn't a preview. */
  target: (sessionId: string, itemId: string) => Promise<PreviewTarget | null>
  /** Create or revise the preview item for a port or launch configuration. */
  publish: (sessionId: string, input: { port: number; path?: string }, source: CanvasItemSource) => Promise<CanvasItem>
}

/** A failure whose message is meant for the user (or the agent). */
export class PreviewError extends Error {}

export class PreviewManager {
  private settings: PreviewSettings = { ports: [], host: '127.0.0.1', denied: new Set() }
  private entries = new Map<string, Entry>()
  /** Proxy port each preview had last, so its origin (and the app's storage there) stays the same. */
  private sticky = new Map<string, number>()
  /** Which preview last held each proxy port: a new holder starts with that origin's storage cleared. */
  private portHolder = new Map<number, string>()
  /** One operation at a time per session (open, launch, stop, restart): no two starts of one server. */
  private queues = new Map<string, Promise<unknown>>()

  private serial<T>(sessionId: string, op: () => Promise<T>): Promise<T> {
    const run = (this.queues.get(sessionId) ?? Promise.resolve()).then(op, op)
    const tail = run.catch(() => undefined)
    this.queues.set(sessionId, tail)
    void tail.then(() => { if (this.queues.get(sessionId) === tail) this.queues.delete(sessionId) })
    return run
  }

  constructor(private readonly deps: PreviewManagerDeps) {}

  configure(settings: PreviewSettings): void {
    this.settings = settings
  }

  get enabled(): boolean {
    return this.settings.ports.length > 0
  }

  /** Why a target port can't be previewed, or null. */
  checkTarget(port: number): string | null {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port must be a number from 1 to 65535.'
    if (this.settings.denied.has(port)) return `Port ${port} is Codekin's own; previews show your dev servers.`
    return null
  }

  /** Before canvas_preview stores an item: the port is allowed and answers. */
  async checkAgentTarget(input: CanvasPublishInput | { port?: unknown }): Promise<void> {
    const port = (input as { port?: unknown }).port
    if (typeof port !== 'number') throw new PreviewError('port must be the dev server\'s port, a number.')
    const denied = this.checkTarget(port)
    if (denied) throw new PreviewError(denied)
    if (!await probePort(port)) {
      throw new PreviewError(`Nothing is listening on port ${port} yet. Start the dev server first (in the background, so your shell isn't blocked), wait until it is ready, then call canvas_preview again.`)
    }
  }

  async configs(sessionId: string): Promise<WsServerMessage> {
    const session = this.deps.getSession(sessionId)
    if (!session) return { type: 'canvas_error', message: 'Session not found', sessionId }
    const r = await readLaunchConfigs(session.workingDir)
    return { type: 'preview_configs', sessionId, file: r.file, configs: r.configs.map(publicConfig), ...(r.error ? { error: r.error } : {}) }
  }

  /** Get a preview ready to show: its proxy, and whether its server answers. Returns an error message, or null. */
  open(sessionId: string, itemId: string): Promise<string | null> {
    return this.serial(sessionId, () => this.openNow(sessionId, itemId))
  }

  private async openNow(sessionId: string, itemId: string): Promise<string | null> {
    try {
      const target = await this.deps.target(sessionId, itemId)
      if (!target) return 'That item is not a preview.'
      const denied = this.checkTarget(target.port)
      if (denied) return denied
      const entry = this.entry(sessionId, itemId, target)
      // A new revision may point elsewhere (a server Codekin runs keeps its port).
      if (!entry.proc) this.retarget(entry, target.port)
      entry.path = target.path
      entry.lastUsed = Date.now()
      await this.ensureProxy(entry)
      if (!entry.proc) await this.refresh(entry)
      this.schedule(entry)
      this.emit(entry)
      return null
    } catch (err) {
      return this.message(err)
    }
  }

  /**
   * Start a launch configuration the user approved: `digest` names what they
   * saw (publicConfig), and a file that says something else by now is
   * refused. Returns an error message, or null.
   */
  launch(sessionId: string, name: string, digest: string | undefined): Promise<string | null> {
    return this.serial(sessionId, () => this.launchNow(sessionId, name, digest))
  }

  private async launchNow(sessionId: string, name: string, digest: string | undefined, approved?: ResolvedLaunchConfig): Promise<string | null> {
    try {
      const session = this.deps.getSession(sessionId)
      if (!session) return 'Session not found'
      let config = approved
      if (!config) {
        const { configs, error } = await readLaunchConfigs(session.workingDir)
        config = configs.find(c => c.name === name)
        if (!config) return error ?? `There is no launch configuration named "${name}" in .claude/launch.json.`
        if (config.error) return `${config.name}: ${config.error}`
        if (config.executable && digest !== launchDigest(config)) {
          // Show the user what the file says now.
          void this.configs(sessionId).then(msg => { this.deps.broadcast(session, msg) })
          return CHANGED
        }
      }
      const denied = this.checkTarget(config.port)
      if (denied) return denied
      const item = await this.deps.publish(sessionId, { port: config.port }, { type: 'launch', config: config.name })
      const target = await this.deps.target(sessionId, item.id)
      const entry = this.entry(sessionId, item.id, target ?? { port: config.port, path: '/', config: config.name })
      if (entry.proc) { this.emit(entry); return null }
      this.retarget(entry, config.port)
      entry.config = config.name
      entry.lastUsed = Date.now()
      entry.error = undefined
      entry.notice = undefined
      entry.exitCode = undefined
      await this.ensureProxy(entry)
      if (!config.executable) {
        // A server you run yourself: attach only.
        entry.managed = false
        await this.refresh(entry)
      } else if (await probePort(config.port)) {
        entry.managed = false
        entry.status = 'running'
        entry.notice = `Port ${config.port} was already in use, so Codekin didn't start "${config.name}". This shows what answers there.`
      } else {
        this.spawn(entry, config)
      }
      this.schedule(entry)
      this.emit(entry)
      return null
    } catch (err) {
      return this.message(err)
    }
  }

  /** Stop a server Codekin started. Returns an error message, or null. */
  stop(sessionId: string, itemId: string): Promise<string | null> {
    return this.serial(sessionId, async () => {
      const entry = this.entries.get(key(sessionId, itemId))
      if (!entry?.proc) return 'Codekin didn\'t start this server, so it can\'t stop it. Stop it where it runs.'
      this.kill(entry)
      return null
    })
  }

  /** Stop and start again, with the configuration it was started with (not what the file says now). */
  restart(sessionId: string, itemId: string): Promise<string | null> {
    return this.serial(sessionId, async () => {
      const entry = this.entries.get(key(sessionId, itemId))
      const launched = entry?.launched
      if (!entry || !launched) return 'Only a server Codekin started can be restarted here. Start it from its launch configuration.'
      if (entry.proc) {
        const proc = entry.proc
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, KILL_GRACE_MS + 1000)
          proc.once('exit', () => { clearTimeout(timer); resolve() })
          this.kill(entry)
        })
      }
      entry.logs = []
      entry.pending = []
      this.sendLog(entry, [], true)
      return this.launchNow(sessionId, launched.name, undefined, launched)
    })
  }

  logs(sessionId: string, itemId: string): WsServerMessage {
    const entry = this.entries.get(key(sessionId, itemId))
    return { type: 'preview_log', sessionId, itemId, lines: entry?.logs ?? [], reset: true }
  }

  /** The item was deleted: stop its server and proxy. */
  forget(sessionId: string, itemId: string): void {
    const entry = this.entries.get(key(sessionId, itemId))
    if (!entry) return
    this.entries.delete(key(sessionId, itemId))
    this.sticky.delete(key(sessionId, itemId))
    this.teardown(entry)
  }

  removeSession(sessionId: string): void {
    for (const entry of [...this.entries.values()]) if (entry.sessionId === sessionId) this.forget(sessionId, entry.itemId)
  }

  /** Stop every server Codekin started and close the proxies. */
  async shutdown(): Promise<void> {
    const running = [...this.entries.values()].filter(e => e.proc)
    await Promise.all(running.map(e => new Promise<void>((resolve) => {
      const pid = e.proc!.pid
      const timer = setTimeout(() => {
        // Codekin is going away: whatever is left of the group goes too.
        if (pid) signalGroup(pid, 'SIGKILL')
        resolve()
      }, 2000)
      e.proc!.once('exit', () => { clearTimeout(timer); resolve() })
      this.kill(e)
    })))
    for (const entry of this.entries.values()) this.teardown(entry)
    this.entries.clear()
  }

  // --- internals ---

  private entry(sessionId: string, itemId: string, target: PreviewTarget): Entry {
    const k = key(sessionId, itemId)
    let entry = this.entries.get(k)
    if (!entry) {
      entry = {
        sessionId, itemId, targetPort: target.port, path: target.path, config: target.config,
        managed: false, status: 'stopped', logs: [], pending: [], partial: { out: '', err: '' }, lastUsed: Date.now(),
      }
      this.entries.set(k, entry)
    }
    return entry
  }

  private state(e: Entry): PreviewState {
    return {
      itemId: e.itemId,
      status: e.status,
      targetPort: e.targetPort,
      managed: e.managed && !!e.proc,
      ...(e.proxy ? { proxyPort: e.proxy.port, entry: `${PREVIEW_ENTRY_PATH}?k=${e.proxy.key}&to=${encodeURIComponent(e.path)}` } : {}),
      ...(e.config ? { config: e.config } : {}),
      ...(e.command ? { command: e.command } : {}),
      ...(e.exitCode !== undefined ? { exitCode: e.exitCode } : {}),
      ...(e.error ? { error: e.error } : {}),
      ...(e.notice ? { notice: e.notice } : {}),
    }
  }

  private emit(e: Entry): void {
    const session = this.deps.getSession(e.sessionId)
    if (session) this.deps.broadcast(session, { type: 'preview_state', sessionId: e.sessionId, preview: this.state(e) })
  }

  private message(err: unknown): string {
    if (err instanceof PreviewError || err instanceof CanvasError) return err.message
    console.error('[preview]', err)
    return 'The preview request failed.'
  }

  private async ensureProxy(entry: Entry): Promise<void> {
    if (entry.proxy || !this.enabled) {
      if (!this.enabled) entry.error = 'Previews are turned off on this Codekin (CANVAS_PREVIEW_PORTS=off).'
      return
    }
    const k = key(entry.sessionId, entry.itemId)
    for (let round = 0; round < 2; round++) {
      const used = new Set([...this.entries.values()].flatMap(e => (e.proxy ? [e.proxy.port] : [])))
      const preferred = this.sticky.get(k)
      const order = [...(preferred !== undefined ? [preferred] : []), ...this.settings.ports].filter((p, i, a) => !used.has(p) && a.indexOf(p) === i)
      for (const port of order) {
        const proxyKey = randomBytes(24).toString('base64url')
        // An origin another preview used (or an earlier Codekin) may hold its
        // storage and service workers: the new holder starts with them cleared.
        const clearSiteData = this.portHolder.get(port) !== k
        const server = createPreviewProxy({
          targetPort: entry.targetPort, key: proxyKey, cookieName: `codekin_preview_${port}`, clearSiteData,
          ...(this.settings.codekinPort ? { hostPorts: [this.settings.codekinPort] } : {}),
        })
        if (await listen(server, port, this.settings.host)) {
          entry.proxy = { server, port, key: proxyKey }
          this.sticky.set(k, port)
          this.portHolder.set(port, k)
          if (entry.error?.startsWith('No preview port')) entry.error = undefined
          return
        }
      }
      // Every port is taken: reclaim the preview opened longest ago.
      const oldest = [...this.entries.values()].filter(e => e.proxy && e !== entry).sort((a, b) => a.lastUsed - b.lastUsed)[0]
      if (!oldest) break
      this.closeProxy(oldest)
      this.emit(oldest)
    }
    entry.error = `No preview port is free (Codekin uses ${this.settings.ports[0]}–${this.settings.ports.at(-1)}).`
  }

  /** Point the preview at another port: its proxy forwards to one port only, so it is replaced. */
  private retarget(entry: Entry, port: number): void {
    if (entry.targetPort === port) return
    this.closeProxy(entry)
    entry.targetPort = port
    entry.error = undefined
    entry.notice = undefined
  }

  private closeProxy(entry: Entry): void {
    if (!entry.proxy) return
    entry.proxy.server.closeAllConnections?.()
    entry.proxy.server.close()
    entry.proxy = undefined
    if (!entry.proc && entry.probeTimer) { clearTimeout(entry.probeTimer); entry.probeTimer = undefined }
  }

  private teardown(entry: Entry): void {
    if (entry.proc) this.kill(entry)
    this.closeProxy(entry)
    if (entry.probeTimer) clearTimeout(entry.probeTimer)
    if (entry.logTimer) clearTimeout(entry.logTimer)
    entry.probeTimer = undefined
    entry.logTimer = undefined
  }

  /** Probe the target; for a server Codekin started, "starting" until it answers. */
  private async refresh(entry: Entry): Promise<boolean> {
    const up = await probePort(entry.targetPort)
    const before = `${entry.status}|${entry.error ?? ''}`
    if (entry.proc) {
      if (up && entry.status === 'starting') entry.status = 'running'
      if (!up && entry.status === 'starting' && entry.startedAt && Date.now() - entry.startedAt > START_TIMEOUT_MS) {
        entry.error = `"${entry.config}" is running but nothing answers on port ${entry.targetPort}. Check its output, and that port in .claude/launch.json.`
      }
    } else if (entry.status !== 'crashed' || up) {
      entry.status = up ? 'running' : 'stopped'
      // Something answers again (the agent restarted it): an old crash or timeout no longer applies.
      if (up) { entry.exitCode = undefined; entry.error = undefined }
    }
    return before !== `${entry.status}|${entry.error ?? ''}`
  }

  private schedule(entry: Entry): void {
    if (entry.probeTimer) clearTimeout(entry.probeTimer)
    if (!entry.proxy && !entry.proc) { entry.probeTimer = undefined; return }
    const delay = entry.proc && entry.status === 'starting' ? STARTING_PROBE_MS : PROBE_MS
    entry.probeTimer = setTimeout(() => {
      if (this.entries.get(key(entry.sessionId, entry.itemId)) !== entry) return
      void this.refresh(entry).then((changed) => {
        if (changed) this.emit(entry)
        this.schedule(entry)
      })
    }, delay)
    entry.probeTimer.unref?.()
  }

  private spawn(entry: Entry, config: ResolvedLaunchConfig): void {
    entry.launched = config
    entry.managed = true
    entry.command = config.command ?? undefined
    entry.status = 'starting'
    entry.startedAt = Date.now()
    entry.stopping = false
    entry.partial = { out: '', err: '' }
    this.addLog(entry, `$ ${config.command}${config.cwd ? `   (in ${config.cwd})` : ''}`)
    let child: ChildProcess
    try {
      child = spawn(config.executable!, config.args, {
        cwd: config.absCwd,
        env: devServerEnv(config.env, config.port),
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (err) {
      entry.status = 'crashed'
      entry.error = `Couldn't start ${config.command}: ${err instanceof Error ? err.message : String(err)}`
      return
    }
    entry.proc = child
    child.stdout?.on('data', (chunk: Buffer) => { this.output(entry, 'out', chunk) })
    child.stderr?.on('data', (chunk: Buffer) => { this.output(entry, 'err', chunk) })
    child.once('error', (err) => {
      if (entry.proc !== child) return
      entry.proc = undefined
      entry.status = 'crashed'
      entry.error = `Couldn't start ${config.command}: ${err.message}`
      this.addLog(entry, `[codekin] ${entry.error}`)
      this.emit(entry)
    })
    child.once('exit', (code, signal) => {
      if (entry.proc !== child) return
      entry.proc = undefined
      for (const stream of ['out', 'err'] as const) if (entry.partial[stream]) { this.addLog(entry, entry.partial[stream]); entry.partial[stream] = '' }
      entry.exitCode = code
      if (entry.stopping || code === 0) {
        entry.status = 'stopped'
        this.addLog(entry, `[codekin] Server stopped${code !== null ? ` (exit code ${code})` : ''}.`)
      } else {
        entry.status = 'crashed'
        entry.error = code !== null ? `"${entry.config}" exited with code ${code}.` : `"${entry.config}" was ended by ${signal ?? 'a signal'}.`
        this.addLog(entry, `[codekin] ${entry.error}`)
      }
      entry.stopping = false
      this.emit(entry)
      this.schedule(entry)
    })
  }

  private kill(entry: Entry): void {
    const child = entry.proc
    if (!child?.pid) return
    entry.stopping = true
    const pid = child.pid
    if (process.platform === 'win32') { child.kill('SIGTERM'); return }
    // The whole process group: npm/yarn wrappers start the real server as a
    // child, and it may outlive the wrapper. Whatever is left after the grace
    // period is killed, whether or not the wrapper already exited.
    signalGroup(pid, 'SIGTERM')
    const timer = setTimeout(() => { signalGroup(pid, 'SIGKILL') }, KILL_GRACE_MS)
    timer.unref?.()
  }

  private output(entry: Entry, stream: 'out' | 'err', chunk: Buffer): void {
    const text = entry.partial[stream] + chunk.toString('utf-8')
    const lines = text.split(/\r?\n/)
    entry.partial[stream] = lines.pop() ?? ''
    if (entry.partial[stream].length > MAX_LINE) { lines.push(entry.partial[stream]); entry.partial[stream] = '' }
    for (const line of lines) this.addLog(entry, line)
  }

  private addLog(entry: Entry, raw: string): void {
    // Clipped first: the line comes from the dev server, at any length.
    const line = raw.slice(0, MAX_LINE * 2).replace(ANSI, '').replace(/\r/g, '').slice(0, MAX_LINE)
    entry.logs.push(line)
    if (entry.logs.length > MAX_LOG_LINES) entry.logs.splice(0, entry.logs.length - MAX_LOG_LINES)
    entry.pending.push(line)
    if (!entry.logTimer) {
      entry.logTimer = setTimeout(() => {
        entry.logTimer = undefined
        const lines = entry.pending.splice(0)
        if (lines.length) this.sendLog(entry, lines.slice(-MAX_LOG_LINES))
      }, 300)
      entry.logTimer.unref?.()
    }
  }

  private sendLog(entry: Entry, lines: string[], reset = false): void {
    const session = this.deps.getSession(entry.sessionId)
    if (session) this.deps.broadcast(session, { type: 'preview_log', sessionId: entry.sessionId, itemId: entry.itemId, lines, ...(reset ? { reset: true } : {}) })
  }
}

/** Signal a process group; false when it is gone. */
function signalGroup(pid: number, sig: NodeJS.Signals): boolean {
  if (pid <= 1) return false
  try { process.kill(-pid, sig); return true } catch { return false }
}

function key(sessionId: string, itemId: string): string {
  return `${sessionId}:${itemId}`
}

function listen(server: http.Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const onError = () => { server.removeListener('listening', onListening); resolve(false) }
    const onListening = () => { server.removeListener('error', onError); resolve(true) }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}
