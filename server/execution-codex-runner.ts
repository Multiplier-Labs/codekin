/**
 * Runs one bounded execution job on Codex (docs/EXECUTION-API.md §Inference profile).
 *
 * Each job runs on a fresh ephemeral thread whose base instructions are the
 * job's own, in a fresh empty working directory. The `codex app-server`
 * process underneath is kept warm and reused for later jobs (up to
 * `warmMaxAgeMs`, default an hour) — but only after a clean, completed turn;
 * a guard trip, cancellation, deadline or any incomplete turn replaces it. The job
 * gets no tools: tool-bearing features are disabled, every MCP server in the
 * Codex config is disabled by name, the sandbox is read-only and approvals
 * are never granted. A runtime guard then fails the job closed if anything
 * slips through anyway — an MCP server starting, any item other than the
 * user message / reasoning / the answer, or any server-initiated request.
 *
 * Unlike CodexProcess (interactive coding sessions) no conversation is ever
 * shared: each job's thread is unsubscribed when it ends, so nothing can leak
 * from one job's context into another's.
 */

import { spawn, execFile, type ChildProcess } from 'child_process'
import { createInterface } from 'readline'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'fs'
import { tmpdir, homedir } from 'os'
import { join } from 'path'
import { buildHarnessEnv } from './harness-env.js'
import type { JobError, JobErrorCode, JobUsage } from './execution-store.js'

// ---------------------------------------------------------------------------
// Runner contract (shared with tests' fake runners)
// ---------------------------------------------------------------------------

export interface RunSpec {
  instructions: string
  input: string
  output: { type: 'json'; schemaName: string; schema: Record<string, unknown> } | { type: 'text' }
  model: string | null
  effort: string | null
  /** Epoch ms; the attempt is killed at this time. */
  deadlineAt: number
}

export interface RateLimitSnapshot {
  usedPercent: number | null
  windowDurationMins: number | null
  resetsAt: string | null
  planType: string | null
  hasCredits: boolean | null
  limitReached: string | null
  at: string
}

export type RunOutcome =
  | { ok: true; text: string; model: string | null; usage: JobUsage | null; billingMode: BillingMode }
  | { ok: false; error: JobError; canceled?: boolean; billingMode?: BillingMode }

export interface RunHooks {
  onRateLimits?: (rl: RateLimitSnapshot) => void
}

export type BillingMode = 'subscription' | 'metered' | 'unknown'

export interface HarnessAccount {
  type: string
  planType: string | null
}

export interface ProbeResult {
  available: boolean
  version: string | null
  account: HarnessAccount | null
  billingMode: BillingMode
  models: { id: string; isDefault: boolean }[]
  /** True when a guarded schema job completed with valid output. */
  inferenceProfile: boolean
  rateLimits: RateLimitSnapshot | null
  error: string | null
  probedAt: string
}

export interface HarnessRunner {
  readonly harness: string
  run(spec: RunSpec, signal: AbortSignal, hooks?: RunHooks): Promise<RunOutcome>
  probe(): Promise<ProbeResult>
  /** Cheap usage-window read without running a model turn. */
  readRateLimits?(): Promise<RateLimitSnapshot | null>
  /** Stop any warm processes. */
  close?(): Promise<void>
}

// ---------------------------------------------------------------------------
// Isolation flags
// ---------------------------------------------------------------------------

/**
 * Features that give a Codex turn a tool or a connection to the outside. Only
 * those the installed CLI reports as enabled are disabled — `--disable` with
 * a name the CLI does not know makes it exit. New tool features that are not
 * listed here are caught by the runtime guard instead.
 */
export const TOOL_FEATURES = [
  'shell_tool', 'unified_exec', 'apps', 'browser_use', 'browser_use_external', 'computer_use',
  'image_generation', 'plugins', 'remote_plugin', 'multi_agent', 'view_image', 'in_app_browser',
  'hooks', 'skill_search', 'skill_mcp_dependency_install', 'tool_suggest', 'goals', 'sleep_tool',
  'memories', 'code_mode_host', 'web_search_request', 'web_search_cached', 'standalone_web_search',
  'realtime_conversation', 'in_app_local_automation', 'workspace_dependencies', 'worktrees',
  'tool_call_mcp_elicitation', 'apply_patch_freeform',
]

/** Parse `codex features list` output ("name  stage  true|false" per line) → enabled names. */
export function parseEnabledFeatures(output: string): Set<string> {
  const enabled = new Set<string>()
  for (const line of output.split('\n')) {
    const m = /^(\S+)\s+.*\s(true|false)\s*$/.exec(line.trim())
    if (m && m[2] === 'true') enabled.add(m[1])
  }
  return enabled
}

/** MCP server names declared in a Codex config.toml (`[mcp_servers.<name>]` tables). */
export function parseMcpServerNames(toml: string): string[] {
  const names = new Set<string>()
  const re = /^\s*\[\s*mcp_servers\s*\.\s*(?:"((?:[^"\\]|\\.)+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[\].]/gm
  let m: RegExpExecArray | null
  while ((m = re.exec(toml)) !== null) {
    const name = (m[1] as string | undefined) ?? (m[2] as string | undefined) ?? m[3]
    names.add(name)
  }
  return [...names]
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
}

/** Billing mode from the account and the latest rate-limit snapshot. */
export function billingModeFor(account: HarnessAccount | null, rl: RateLimitSnapshot | null): BillingMode {
  if (!account) return 'unknown'
  if (account.type === 'apiKey') return 'metered'
  if (account.type !== 'chatgpt' || !account.planType) return 'unknown'
  if (/usage_based|credits/i.test(account.planType)) return 'metered'
  // Purchasable credits could be spent past the plan's own limit.
  if (!rl || rl.hasCredits === null) return 'unknown'
  return rl.hasCredits ? 'metered' : 'subscription'
}

// ---------------------------------------------------------------------------
// JSON-RPC connection to one app-server process
// ---------------------------------------------------------------------------

interface RpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

class AppServerConnection {
  private nextId = 1
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>()
  private exited = false
  readonly exitPromise: Promise<void>
  onNotification: (method: string, params: Record<string, unknown>) => void = () => {}
  onServerRequest: (method: string) => void = () => {}

  constructor(private proc: ChildProcess) {
    this.exitPromise = new Promise((resolve) => {
      proc.on('close', () => {
        this.exited = true
        for (const p of this.pending.values()) p.reject(new Error('app-server exited'))
        this.pending.clear()
        resolve()
      })
    })
    proc.stdin?.on('error', () => { /* EPIPE after exit — surfaced via close */ })
    if (!proc.stdout) throw new Error('app-server has no stdout')
    const rl = createInterface({ input: proc.stdout })
    rl.on('line', (line) => {
      let msg: RpcMessage
      try { msg = JSON.parse(line) as RpcMessage } catch { return }
      if (msg.id !== undefined && msg.method) {
        // Server-initiated request: never granted for execution jobs.
        this.write({ id: msg.id, error: { code: -32601, message: 'Not available in execution jobs' } })
        this.onServerRequest(msg.method)
        return
      }
      if (msg.id !== undefined) {
        const p = this.pending.get(Number(msg.id))
        if (!p) return
        this.pending.delete(Number(msg.id))
        if (msg.error) p.reject(new Error(msg.error.message || `JSON-RPC error ${msg.error.code}`))
        else p.resolve(msg.result)
        return
      }
      if (msg.method) this.onNotification(msg.method, msg.params ?? {})
    })
  }

  get alive(): boolean { return !this.exited }

  private write(msg: Record<string, unknown>): void {
    if (this.exited) return
    try { this.proc.stdin?.write(JSON.stringify(msg) + '\n') } catch { /* surfaced via close */ }
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (this.exited) return Promise.reject(new Error('app-server exited'))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.write({ id, method, params })
    })
  }

  notify(method: string): void {
    this.write({ method })
  }

  /** SIGTERM, then SIGKILL after a grace period; resolves once the process has exited. */
  async terminate(graceMs = 2000): Promise<void> {
    if (this.exited) return
    try { this.proc.kill('SIGTERM') } catch { /* already gone */ }
    const timer = setTimeout(() => { try { this.proc.kill('SIGKILL') } catch { /* gone */ } }, graceMs)
    await this.exitPromise
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Codex runner
// ---------------------------------------------------------------------------

export interface CodexRunnerOptions {
  /** Executable; defaults to $CODEX_BINARY or `codex`. */
  binary?: string
  /** Arguments placed before Codex's own (tests run a fake app-server via node). */
  binaryArgs?: string[]
  /** Dedicated Codex home for jobs (its own config and login). */
  codexHome?: string | null
  /** Timeout for the probe job. */
  probeTimeoutMs?: number
  /** Reuse a warm app-server for this long after it started; 0 = a new process per job. */
  warmMaxAgeMs?: number
}

/** A warm app-server process between jobs. */
interface WarmProcess {
  conn: AppServerConnection
  /** Arguments it was started with; a change (CLI features, MCP servers) retires it. */
  argsKey: string
  /** The process's own (empty) working directory. */
  dir: string
  startedAt: number
  jobs: number
  idleTimer: ReturnType<typeof setTimeout> | null
}

/** Account and plan are re-read at most this often; usage arrives with every turn. */
const ACCOUNT_TTL_MS = 60_000
const INIT_TIMEOUT_MS = 20_000

const ALLOWED_ITEM_TYPES = new Set(['userMessage', 'reasoning', 'agentMessage'])
const STRIPPED_FOR_JOBS = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'AUTH_TOKEN', 'AUTH_TOKEN_FILE']

function err(code: JobErrorCode, message: string, retryable = false, retryAfter: string | null = null): JobError {
  return { code, message, retryable, retryAfter }
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

export function parseRateLimits(params: Record<string, unknown>): RateLimitSnapshot | null {
  const raw = (params.rateLimits ?? params) as unknown
  if (!raw || typeof raw !== 'object') return null
  const rl = raw as Record<string, unknown>
  const primary = (rl.primary ?? null) as Record<string, unknown> | null
  const credits = (rl.credits ?? null) as Record<string, unknown> | null
  const resets = primary ? num(primary.resetsAt) : null
  return {
    usedPercent: primary ? num(primary.usedPercent) : null,
    windowDurationMins: primary ? num(primary.windowDurationMins) : null,
    resetsAt: resets === null ? null : new Date(resets * 1000).toISOString(),
    planType: str(rl.planType),
    hasCredits: credits && typeof credits.hasCredits === 'boolean' ? credits.hasCredits : null,
    limitReached: str(rl.rateLimitReachedType),
    at: new Date().toISOString(),
  }
}

/** Map a failed turn's codexErrorInfo to a job error. */
export function mapTurnError(turnError: Record<string, unknown> | null, rl: RateLimitSnapshot | null): JobError {
  const message = str(turnError?.message) ?? 'Codex turn failed'
  const info = turnError?.codexErrorInfo
  const kind = typeof info === 'string' ? info : info && typeof info === 'object' ? Object.keys(info)[0] : 'other'
  switch (kind) {
    case 'usageLimitExceeded':
    case 'sessionBudgetExceeded':
      return err('QUOTA_EXHAUSTED', message, true, rl?.resetsAt ?? null)
    case 'rateLimitExceeded':
      return err('QUOTA_EXHAUSTED', message, true, rl?.resetsAt ?? null)
    case 'unauthorized':
      return err('AUTH_REQUIRED', message)
    case 'serverOverloaded':
    case 'internalServerError':
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseStreamDisconnected':
    case 'responseTooManyFailedAttempts':
      return err('RUNTIME_UNAVAILABLE', message, true)
    case 'contextWindowExceeded':
    case 'badRequest':
      return err('UNSUPPORTED_CAPABILITY', message)
    case 'cyberPolicy':
    case 'misalignmentPolicyViolation':
      return err('UNSUPPORTED_CAPABILITY', `Refused by the provider's policy: ${message}`)
    default:
      return err('EXECUTION_INTERRUPTED', message, true)
  }
}

export class CodexRunner implements HarnessRunner {
  readonly harness = 'codex'
  private binary: string
  private binaryArgs: string[]
  private codexHome: string | null
  private probeTimeoutMs: number
  /** Disable flags derived from the installed CLI; refreshed by probe(). */
  private featureFlags: string[] | null = null
  private lastRateLimits: RateLimitSnapshot | null = null
  private warmMaxAgeMs: number
  private idle: WarmProcess[] = []
  private closed = false
  private accountCache: { account: HarnessAccount; at: number } | null = null
  /** Processes started so far (observability and tests). */
  spawnCount = 0

  constructor(opts: CodexRunnerOptions = {}) {
    this.binary = opts.binary ?? process.env.CODEX_BINARY ?? 'codex'
    this.binaryArgs = opts.binaryArgs ?? []
    this.codexHome = opts.codexHome ?? null
    this.probeTimeoutMs = opts.probeTimeoutMs ?? 60_000
    this.warmMaxAgeMs = Math.max(0, opts.warmMaxAgeMs ?? 60 * 60 * 1000)
  }

  /** Number of warm processes waiting for a job. */
  get warmCount(): number {
    return this.idle.length
  }

  private async dispose(w: WarmProcess): Promise<void> {
    this.idle = this.idle.filter(x => x !== w)
    if (w.idleTimer) clearTimeout(w.idleTimer)
    await w.conn.terminate()
    rmSync(w.dir, { recursive: true, force: true })
  }

  /** A warm process started with these arguments, or a new one after the handshake. */
  private async acquire(args: string[]): Promise<WarmProcess> {
    const key = args.join('\u0000')
    while (this.idle.length > 0) {
      const w = this.idle.pop() as WarmProcess
      if (w.idleTimer) clearTimeout(w.idleTimer)
      w.idleTimer = null
      if (w.conn.alive && w.argsKey === key && Date.now() - w.startedAt < this.warmMaxAgeMs) return w
      void this.dispose(w)
    }
    const dir = mkdtempSync(join(tmpdir(), 'codekin-exec-'))
    let proc: ChildProcess
    try {
      proc = spawn(this.binary, args, { cwd: dir, env: this.env(), stdio: ['pipe', 'pipe', 'ignore'] })
    } catch (e) {
      rmSync(dir, { recursive: true, force: true })
      throw e
    }
    this.spawnCount++
    const spawnError = new Promise<never>((_resolve, reject) => { proc.on('error', reject) })
    const conn = new AppServerConnection(proc)
    const w: WarmProcess = { conn, argsKey: key, dir, startedAt: Date.now(), jobs: 0, idleTimer: null }
    const init = { timer: null as ReturnType<typeof setTimeout> | null }
    try {
      await Promise.race([
        conn.request('initialize', { clientInfo: { name: 'codekin-execution', title: 'Codekin execution', version: '1' }, capabilities: null }),
        spawnError,
        new Promise<never>((_resolve, reject) => { init.timer = setTimeout(() => { reject(new Error('app-server did not start in time')) }, INIT_TIMEOUT_MS) }),
      ])
    } catch (e) {
      await this.dispose(w)
      throw e
    } finally {
      if (init.timer) clearTimeout(init.timer)
    }
    conn.notify('initialized')
    return w
  }

  /** Back to the pool after a clean job, else stopped (and awaited, so nothing outlives the job). */
  private async release(w: WarmProcess, reusable: boolean): Promise<void> {
    w.conn.onNotification = () => {}
    w.conn.onServerRequest = () => { void this.dispose(w) }
    const left = this.warmMaxAgeMs - (Date.now() - w.startedAt)
    if (!reusable || this.closed || !w.conn.alive || left <= 0) {
      await this.dispose(w)
      return
    }
    w.idleTimer = setTimeout(() => { void this.dispose(w) }, left)
    w.idleTimer.unref()
    this.idle.push(w)
  }

  async close(): Promise<void> {
    this.closed = true
    await Promise.all(this.idle.map(w => this.dispose(w)))
  }

  /** Account and plan, from cache when fresh. */
  private async account(conn: AppServerConnection): Promise<HarnessAccount | null> {
    if (this.accountCache && Date.now() - this.accountCache.at < ACCOUNT_TTL_MS) return this.accountCache.account
    const acct = await conn.request('account/read', { refreshToken: false }) as { account?: Record<string, unknown> | null } | null
    const account = acct?.account ? { type: str(acct.account.type) ?? 'unknown', planType: str(acct.account.planType) } : null
    this.accountCache = account ? { account, at: Date.now() } : null
    return account
  }

  private env(): Record<string, string> {
    const env = buildHarnessEnv(this.codexHome ? { CODEX_HOME: this.codexHome } : {})
    return Object.fromEntries(Object.entries(env).filter(([key]) => !STRIPPED_FOR_JOBS.includes(key)))
  }

  private configPath(): string {
    return join(this.codexHome ?? join(homedir(), '.codex'), 'config.toml')
  }

  private exec(args: string[], timeoutMs = 15_000): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.binary, [...this.binaryArgs, ...args], { env: this.env(), timeout: timeoutMs }, (e, stdout) => {
        if (e) reject(new Error(e.message))
        else resolve(stdout)
      })
    })
  }

  private async ensureFeatureFlags(): Promise<string[]> {
    if (this.featureFlags) return this.featureFlags
    const enabled = parseEnabledFeatures(await this.exec(['features', 'list']))
    this.featureFlags = TOOL_FEATURES.filter(f => enabled.has(f)).flatMap(f => ['--disable', f])
    return this.featureFlags
  }

  /** Arguments for one job's app-server: tool features off, every configured MCP server off, no web search. */
  async appServerArgs(): Promise<string[]> {
    const flags = await this.ensureFeatureFlags()
    let servers: string[] = []
    const cfg = this.configPath()
    if (existsSync(cfg)) servers = parseMcpServerNames(readFileSync(cfg, 'utf-8'))
    return [
      ...this.binaryArgs, 'app-server', ...flags,
      '-c', 'web_search="disabled"',
      ...servers.flatMap(n => ['-c', `mcp_servers.${tomlKey(n)}.enabled=false`]),
    ]
  }

  async run(spec: RunSpec, signal: AbortSignal, hooks: RunHooks = {}): Promise<RunOutcome> {
    if (signal.aborted) return { ok: false, canceled: true, error: err('EXECUTION_INTERRUPTED', 'Canceled before start') }
    let args: string[]
    try {
      args = await this.appServerArgs()
    } catch (e) {
      return { ok: false, error: err('RUNTIME_UNAVAILABLE', `Codex CLI unavailable: ${(e as Error).message}`, true) }
    }
    if (this.closed) return { ok: false, error: err('RUNTIME_UNAVAILABLE', 'Codex runner is shutting down', true) }
    let w: WarmProcess
    try {
      w = await this.acquire(args)
    } catch (e) {
      return { ok: false, error: err('RUNTIME_UNAVAILABLE', `Could not start Codex: ${(e as Error).message}`, true) }
    }
    w.jobs++
    const conn = w.conn
    // Each job gets its own empty working directory, whatever process it runs in.
    const cwd = mkdtempSync(join(tmpdir(), 'codekin-exec-job-'))
    // Set from notification callbacks, so kept in an object (not narrowed away).
    const job = { threadId: null as string | null, turnCompleted: false, guardTripped: false }
    /** Notifications for another (earlier) thread are ignored. */
    const mine = (params: Record<string, unknown>) => typeof params.threadId !== 'string' || params.threadId === job.threadId

    let settle!: (o: RunOutcome) => void
    const outcome = new Promise<RunOutcome>((resolve) => { settle = resolve })
    let settled = false
    let billingMode: BillingMode = 'unknown'
    const finish = (o: RunOutcome) => {
      if (settled) return
      settled = true
      settle(o.ok ? o : { ...o, billingMode })
    }

    let usage: JobUsage | null = null
    let finalText: string | null = null
    let lastText: string | null = null
    let model: string | null = spec.model

    const guard = (message: string) => {
      job.guardTripped = true
      finish({ ok: false, error: err('UNSUPPORTED_CAPABILITY', `Execution guard: ${message}`) })
    }
    conn.onServerRequest = (method) => { guard(`the harness asked the client for "${method}"`) }
    conn.onNotification = (method, params) => {
      if (method.startsWith('mcpServer/')) {
        guard('an MCP server started inside the job')
        return
      }
      if (method === 'account/rateLimits/updated') {
        const rl = parseRateLimits(params)
        if (rl) { this.lastRateLimits = rl; hooks.onRateLimits?.(rl) }
        return
      }
      // The guard applies to every thread in the process; results only to this job's.
      if ((method === 'item/started' || method === 'item/completed')
        && !ALLOWED_ITEM_TYPES.has(str(((params.item ?? {}) as Record<string, unknown>).type) ?? 'unknown')) {
        guard(`the harness produced a "${str(((params.item ?? {}) as Record<string, unknown>).type) ?? 'unknown'}" item`)
        return
      }
      if (!mine(params)) return
      if (method === 'thread/tokenUsage/updated') {
        const tu = (params.tokenUsage ?? {}) as Record<string, unknown>
        const b = (tu.last ?? tu.total ?? {}) as Record<string, unknown>
        usage = { inputTokens: num(b.inputTokens), outputTokens: num(b.outputTokens) }
        return
      }
      if (method === 'item/started' || method === 'item/completed') {
        const item = (params.item ?? {}) as Record<string, unknown>
        const type = str(item.type) ?? 'unknown'
        if (!ALLOWED_ITEM_TYPES.has(type)) {
          guard(`the harness produced a "${type}" item`)
          return
        }
        if (method === 'item/completed' && type === 'agentMessage' && typeof item.text === 'string') {
          lastText = item.text
          if (item.phase === 'final_answer') finalText = item.text
        }
        return
      }
      if (method === 'turn/completed') {
        const turn = (params.turn ?? {}) as Record<string, unknown>
        const status = str(turn.status)
        job.turnCompleted = status === 'completed' || status === 'failed'
        if (status === 'completed') {
          const text = finalText ?? lastText
          if (text === null) finish({ ok: false, error: err('INVALID_OUTPUT', 'The turn completed without an answer', true) })
          else finish({ ok: true, text, model, usage, billingMode })
        } else if (status === 'interrupted') {
          finish({ ok: false, error: err('EXECUTION_INTERRUPTED', 'The turn was interrupted', true) })
        } else {
          finish({ ok: false, error: mapTurnError((turn.error ?? null) as Record<string, unknown> | null, this.lastRateLimits) })
        }
      }
    }

    const remaining = spec.deadlineAt - Date.now()
    const deadlineTimer = setTimeout(() => {
      finish({ ok: false, error: err('DEADLINE_EXCEEDED', 'The job deadline passed while it was running') })
    }, Math.max(0, remaining))
    const onAbort = () => { finish({ ok: false, canceled: true, error: err('EXECUTION_INTERRUPTED', 'Canceled') }) }
    signal.addEventListener('abort', onAbort, { once: true })
    void conn.exitPromise.then(() => { finish({ ok: false, error: err('EXECUTION_INTERRUPTED', 'Codex exited before the turn completed', true) }) })

    const drive = async () => {
      const account = await this.account(conn)
      if (!account) {
        finish({ ok: false, error: err('AUTH_REQUIRED', 'Codex is not logged in for execution jobs') })
        return
      }
      // Usage arrives with every turn; read it only when none is recent.
      const rlAge = this.lastRateLimits ? Date.now() - Date.parse(this.lastRateLimits.at) : Infinity
      if (rlAge >= ACCOUNT_TTL_MS) {
        try {
          const rl = parseRateLimits(((await conn.request('account/rateLimits/read', null)) ?? {}) as Record<string, unknown>)
          if (rl) this.lastRateLimits = rl
        } catch { /* not every account type reports limits */ }
      }
      if (this.lastRateLimits) hooks.onRateLimits?.(this.lastRateLimits)
      billingMode = billingModeFor(account, this.lastRateLimits)
      if (billingMode !== 'subscription') {
        this.accountCache = null
        finish({ ok: false, error: err('UNSUPPORTED_CAPABILITY', `Billing mode is ${billingMode}, and the job allows subscription only`) })
        return
      }
      if (this.lastRateLimits?.limitReached) {
        finish({ ok: false, error: err('QUOTA_EXHAUSTED', `Subscription limit reached (${this.lastRateLimits.limitReached})`, true, this.lastRateLimits.resetsAt) })
        return
      }
      const thread = await conn.request('thread/start', {
        cwd,
        ephemeral: true,
        approvalPolicy: 'never',
        sandbox: 'read-only',
        baseInstructions: spec.instructions,
        ...(spec.model ? { model: spec.model } : {}),
        ...(spec.effort ? { config: { model_reasoning_effort: spec.effort } } : {}),
      }) as { thread?: { id?: string }; model?: string } | null
      if (!spec.model && typeof thread?.model === 'string') model = thread.model
      job.threadId = thread?.thread?.id ?? null
      if (!job.threadId) throw new Error('thread/start returned no thread id')
      await conn.request('turn/start', {
        threadId: job.threadId,
        input: [{ type: 'text', text: spec.input, text_elements: [] }],
        ...(spec.output.type === 'json' ? { outputSchema: spec.output.schema } : {}),
      })
    }
    drive().catch((e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e)
      if (/unauthori[sz]ed|not.*logged.*in|login/i.test(msg)) {
        this.accountCache = null
        finish({ ok: false, error: err('AUTH_REQUIRED', msg) })
      }
      else finish({ ok: false, error: err('RUNTIME_UNAVAILABLE', `Codex app-server: ${msg}`, true) })
    })

    const result = await outcome
    clearTimeout(deadlineTimer)
    signal.removeEventListener('abort', onAbort)
    if (!result.ok && result.error.code === 'AUTH_REQUIRED') this.accountCache = null
    // Reuse only a process whose turn ran to completion without a guard trip.
    // Otherwise it is stopped before the job is reported (or canceled), so it
    // can never act after its job has ended.
    const canceled = !result.ok && result.canceled === true
    const reusable = job.turnCompleted && !job.guardTripped && !canceled && conn.alive
    if (reusable && job.threadId) {
      const threadId = job.threadId
      // Unload the finished thread so the next job's process holds no history.
      await Promise.race([
        conn.request('thread/unsubscribe', { threadId }).catch(() => {}),
        new Promise((resolve) => { setTimeout(resolve, 2000).unref() }),
      ])
    }
    await this.release(w, reusable)
    rmSync(cwd, { recursive: true, force: true })
    return result
  }

  /** Start an isolated app-server, run `fn` against it after the handshake, and tear it down. */
  private async withAppServer<T>(fn: (conn: AppServerConnection) => Promise<T>, timeoutMs = 20_000): Promise<T> {
    const args = await this.appServerArgs()
    const cwd = mkdtempSync(join(tmpdir(), 'codekin-exec-probe-'))
    const proc = spawn(this.binary, args, { cwd, env: this.env(), stdio: ['pipe', 'pipe', 'ignore'] })
    proc.on('error', () => { /* surfaced via close */ })
    const conn = new AppServerConnection(proc)
    const timer = setTimeout(() => { void conn.terminate() }, timeoutMs)
    try {
      await conn.request('initialize', { clientInfo: { name: 'codekin-execution', title: 'Codekin execution', version: '1' }, capabilities: null })
      conn.notify('initialized')
      return await fn(conn)
    } finally {
      clearTimeout(timer)
      await conn.terminate()
      rmSync(cwd, { recursive: true, force: true })
    }
  }

  async readRateLimits(): Promise<RateLimitSnapshot | null> {
    const rl = await this.withAppServer(async (conn) =>
      parseRateLimits(((await conn.request('account/rateLimits/read', null)) ?? {}) as Record<string, unknown>))
    if (rl) this.lastRateLimits = rl
    return rl
  }

  async probe(): Promise<ProbeResult> {
    const probedAt = new Date().toISOString()
    const base: ProbeResult = {
      available: false, version: null, account: null, billingMode: 'unknown', models: [],
      inferenceProfile: false, rateLimits: null, error: null, probedAt,
    }
    try {
      base.version = (await this.exec(['--version'])).trim().replace(/^codex-cli\s+/, '') || null
    } catch (e) {
      return { ...base, error: `Codex CLI unavailable: ${(e as Error).message}` }
    }
    base.available = true

    // Account and models from a short-lived, equally isolated app-server.
    this.featureFlags = null // the CLI may have changed; re-derive the disable list
    try {
      await this.withAppServer(async (conn) => {
        const acct = await conn.request('account/read', { refreshToken: false }) as { account?: Record<string, unknown> | null } | null
        base.account = acct?.account ? { type: str(acct.account.type) ?? 'unknown', planType: str(acct.account.planType) } : null
        try {
          base.rateLimits = parseRateLimits(((await conn.request('account/rateLimits/read', null)) ?? {}) as Record<string, unknown>)
          if (base.rateLimits) this.lastRateLimits = base.rateLimits
        } catch { /* optional */ }
        const list = await conn.request('model/list', { includeHidden: false }) as { data?: { id?: unknown; isDefault?: unknown }[] } | null
        base.models = (list?.data ?? []).filter(m => typeof m.id === 'string').map(m => ({ id: m.id as string, isDefault: m.isDefault === true }))
      })
    } catch (e) {
      base.error = `Codex app-server: ${(e as Error).message}`
    }
    base.billingMode = billingModeFor(base.account, base.rateLimits)
    if (!base.account) return { ...base, error: base.error ?? 'Codex is not logged in for execution jobs' }
    if (base.billingMode !== 'subscription') return base

    // The profile is advertised only after a guarded schema job succeeds.
    const ac = new AbortController()
    const res = await this.run({
      instructions: 'You are a test function. Answer only with JSON matching the schema.',
      input: 'Return ok set to true.',
      output: { type: 'json', schemaName: 'probe', schema: { type: 'object', additionalProperties: false, required: ['ok'], properties: { ok: { type: 'boolean' } } } },
      model: null, effort: null, deadlineAt: Date.now() + this.probeTimeoutMs,
    }, ac.signal)
    if (res.ok) {
      try {
        base.inferenceProfile = (JSON.parse(res.text) as { ok?: unknown }).ok === true
      } catch { /* invalid output → profile stays off */ }
      if (!base.inferenceProfile) base.error = 'Probe job returned invalid output'
    } else {
      base.error = `Probe job failed: ${res.error.code}: ${res.error.message}`
    }
    return base
  }
}
