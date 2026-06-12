/**
 * Manages an OpenAI Codex CLI session via `codex app-server` (JSON-RPC 2.0
 * over stdio, newline-delimited JSON).
 *
 * Codex's app-server is OpenAI's documented integration surface for building
 * UIs on top of Codex (it powers their own IDE extensions). The lifecycle is:
 *   initialize → initialized → thread/start (or thread/resume) → turn/start
 * with streamed item/* notifications per turn and server-initiated JSON-RPC
 * requests for command/file-change approvals.
 *
 * This class wraps that protocol behind the same CodingProcess interface
 * implemented by ClaudeProcess and OpenCodeProcess, so SessionManager works
 * identically for all three providers.
 *
 * Wire schema verified against codex-cli 0.139.0 (`codex app-server generate-ts`):
 * - approvalPolicy: 'untrusted' | 'on-failure' | 'on-request' | 'never'
 * - sandbox: 'read-only' | 'workspace-write' | 'danger-full-access'
 * - approval decisions: 'accept' | 'acceptForSession' | 'decline' | 'cancel'
 * - text input parts require snake_case `text_elements`
 *
 * Auth: the host must be pre-authenticated via `codex login` (writes
 * ~/.codex/auth.json, reused by app-server with automatic token refresh).
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { existsSync } from 'fs'
import { extname } from 'path'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { ClaudeProcessEvents } from './claude-process.js'
import { CODEX_CAPABILITIES, type CodingProcess, type CodingProvider, type ProviderCapabilities } from './coding-process.js'
import type { PermissionMode, TaskItem } from './types.js'
import { summarizeToolInput } from './tool-labels.js'

// ---------------------------------------------------------------------------
// Codex app-server protocol types (subset — only what we consume)
// ---------------------------------------------------------------------------

/** A thread item within a Codex turn (agent message, command execution, etc.). */
interface CodexThreadItem {
  type: string
  id: string
  /** agentMessage / plan */
  text?: string
  /** commandExecution */
  command?: string
  cwd?: string
  status?: string
  aggregatedOutput?: string | null
  exitCode?: number | null
  /** reasoning */
  summary?: string[]
  /** fileChange */
  changes?: Array<{ path: string; kind: string; diff: string }>
  /** mcpToolCall */
  server?: string
  tool?: string
  /** webSearch */
  query?: string
}

/** A parsed JSON-RPC message from the app-server's stdout. */
interface CodexRpcMessage {
  id?: number | string
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: { code?: number; message?: string }
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  method: string
  timer: ReturnType<typeof setTimeout> | null
}

/** Default timeout for client→server JSON-RPC requests. */
const RPC_TIMEOUT_MS = 30_000

/** Prefix for synthesized approval request IDs surfaced via control_request. */
const APPROVAL_ID_PREFIX = 'codex-approval-'

const CODEX_BINARY = process.env.CODEX_BINARY || 'codex'

/** Env vars stripped from the child process env (same filtering as opencode-process). */
const API_KEY_VARS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_API_KEY', 'AUTH_TOKEN', 'AUTH_TOKEN_FILE'])

function buildEnv(extraEnv: Record<string, string>): Record<string, string> {
  return {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] != null &&
          !API_KEY_VARS.has(entry[0]) &&
          (!entry[0].startsWith('GIT_') || entry[0] === 'GIT_EDITOR')
      )
    ),
    ...extraEnv,
  }
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

/** Codex model info returned from the app-server's model/list method. */
export interface CodexModelInfo {
  id: string
  name: string
  description: string
  isDefault: boolean
}

let modelCache: { models: CodexModelInfo[]; fetchedAt: number } | null = null
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Fetch the available Codex models by spawning a short-lived app-server and
 * calling model/list. Results reflect what the host's auth allows. Returns an
 * empty array when the binary is missing or not authenticated. Cached for
 * 10 minutes (the list only changes on CLI upgrade or auth change).
 */
export async function fetchCodexModels(): Promise<{ models: CodexModelInfo[] }> {
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return { models: modelCache.models }
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (models: CodexModelInfo[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
      if (models.length > 0) modelCache = { models, fetchedAt: Date.now() }
      resolve({ models })
    }
    const timer = setTimeout(() => { done([]) }, 15_000)

    let proc: ChildProcess
    try {
      proc = spawn(CODEX_BINARY, ['app-server'], { env: buildEnv({}), stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      clearTimeout(timer)
      resolve({ models: [] })
      return
    }
    proc.on('error', () => { done([]) })
    proc.on('close', () => { done([]) })

    const rl = createInterface({ input: proc.stdout! })
    const write = (msg: Record<string, unknown>) => {
      try { proc.stdin!.write(JSON.stringify(msg) + '\n') } catch { done([]) }
    }
    rl.on('line', (line) => {
      let msg: CodexRpcMessage
      try { msg = JSON.parse(line) as CodexRpcMessage } catch { return }
      if (msg.id === 1 && msg.result !== undefined) {
        write({ method: 'initialized' })
        write({ id: 2, method: 'model/list', params: { includeHidden: false } })
      } else if (msg.id === 2) {
        const data = (msg.result as { data?: Array<{ id: string; displayName: string; description: string; isDefault: boolean }> } | undefined)?.data ?? []
        done(data.map(m => ({ id: m.id, name: m.displayName, description: m.description, isDefault: m.isDefault })))
      }
    })
    write({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'codekin', title: 'Codekin', version: '1.0.0' }, capabilities: null },
    })
  })
}

/** Reset the model cache (test helper). */
export function clearCodexModelCache(): void {
  modelCache = null
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CodexProcessOptions {
  /** Absolute path to the project directory. */
  workingDir: string
  /** Codekin session ID (used for internal tracking). */
  sessionId?: string
  /** Codex's own thread ID (used for resume — returned by getSessionId()). */
  codexThreadId?: string
  /** Codex model ID (e.g. 'gpt-5.5'). Omit to use the CLI default. */
  model?: string
  /** Additional environment variables (CODEKIN_SESSION_ID, etc.). */
  extraEnv?: Record<string, string>
  /** Permission mode — mapped to Codex's approvalPolicy + sandbox. */
  permissionMode?: PermissionMode
}

/** Map Codekin's permission mode to Codex approvalPolicy + sandbox values. */
function policyForMode(mode: PermissionMode | undefined): { approvalPolicy: string; sandbox: string } {
  switch (mode) {
    case 'bypassPermissions':
    case 'dangerouslySkipPermissions':
      return { approvalPolicy: 'never', sandbox: 'danger-full-access' }
    case 'plan':
      return { approvalPolicy: 'on-request', sandbox: 'read-only' }
    default:
      return { approvalPolicy: 'on-request', sandbox: 'workspace-write' }
  }
}

// ---------------------------------------------------------------------------
// CodexProcess
// ---------------------------------------------------------------------------

export class CodexProcess extends EventEmitter<ClaudeProcessEvents> implements CodingProcess {
  readonly provider: CodingProvider = 'codex'
  readonly capabilities: ProviderCapabilities = CODEX_CAPABILITIES

  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private alive = false
  private ready = false
  private sessionId: string
  private threadId: string | null = null
  private workingDir: string
  private model?: string
  private extraEnv: Record<string, string>
  private permissionMode?: PermissionMode

  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private stderrTail = ''

  /** Set when spawn() itself fails (ENOENT etc.) — restart should preserve thread id. */
  private _spawnFailed = false
  /** Set when Codex reports an auth failure — restarts will not help until `codex login`. */
  private _authFailed = false
  /** Set once the process emits at least one valid JSON message on stdout. */
  private _receivedOutput = false

  // JSON-RPC state
  private nextRpcId = 1
  private pending = new Map<number, PendingRequest>()
  /** Maps synthesized approval requestIds → the originating JSON-RPC request id + method. */
  private serverApprovals = new Map<string, { rpcId: number | string; method: string }>()

  // Per-turn streaming state
  private turnActive = false
  private currentTurnId: string | null = null
  private receivedDeltas = false
  private reasoningBuffer = ''
  private emittedReasoningSummary = false
  private lastReasoningItemId: string | null = null
  private queuedMessages: string[] = []

  constructor(workingDir: string, opts?: Partial<CodexProcessOptions>) {
    super()
    this.workingDir = workingDir
    this.sessionId = opts?.sessionId || randomUUID()
    this.threadId = opts?.codexThreadId || null
    this.model = opts?.model
    this.extraEnv = opts?.extraEnv || {}
    this.permissionMode = opts?.permissionMode
  }

  /** Spawn `codex app-server` and run the initialize → thread/start handshake. */
  start(): void {
    if (this.proc) return

    if (!existsSync(this.workingDir)) {
      this.emit('error', `Working directory does not exist: ${this.workingDir}`)
      this.emit('exit', 1, null)
      return
    }

    this.alive = true
    this.proc = spawn(CODEX_BINARY, ['app-server'], {
      cwd: this.workingDir,
      env: buildEnv(this.extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      this._spawnFailed = true
      this.alive = false
      const hint = err.code === 'ENOENT'
        ? 'Codex CLI not found — install it with: npm install -g @openai/codex'
        : `Failed to start Codex CLI: ${err.message}`
      this.emit('error', hint)
      this.cleanupTimers()
      this.emit('exit', 1, null)
    })

    this.proc.stderr?.on('data', (chunk: Buffer) => {
      this.stderrTail = (this.stderrTail + chunk.toString()).slice(-2000)
    })

    this.rl = createInterface({ input: this.proc.stdout! })
    this.rl.on('line', (line) => { this.handleLine(line) })

    this.proc.on('close', (code, signal) => {
      const wasAlive = this.alive
      this.alive = false
      this.ready = false
      this.cleanupTimers()
      // Settle outstanding RPC promises so initialize()/sendMessage() don't hang
      for (const [, req] of this.pending) {
        if (req.timer) clearTimeout(req.timer)
        req.reject(new Error(`Codex app-server exited before responding to ${req.method}`))
      }
      this.pending.clear()
      if (wasAlive && this.turnActive) {
        this.turnActive = false
        this.emit('result', 'Codex exited unexpectedly mid-turn', true)
      }
      this.emit('exit', code, signal as string | null)
    })

    // Startup timeout — if the handshake never completes, surface an error.
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.alive && !this.ready) {
        this.emit('error', `Codex process failed to initialize within 60 seconds${this.stderrTail ? ` — stderr: ${this.stderrTail.slice(-300)}` : ''}`)
        this.stop()
      }
    }, 60_000)

    void this.initialize().catch((err: Error) => {
      if (!this.alive) return
      const msg = err.message || String(err)
      if (/unauthorized|not.*logged.*in|auth/i.test(msg)) {
        this._authFailed = true
        this.emit('error', 'Codex is not authenticated. Run `codex login` (or `codex login --device-auth`) on the host.')
      } else {
        this.emit('error', `Codex initialization failed: ${msg}`)
      }
      this.stop()
    })
  }

  private async initialize(): Promise<void> {
    await this.request('initialize', {
      clientInfo: { name: 'codekin', title: 'Codekin', version: '1.0.0' },
      capabilities: null,
    })
    this.notify('initialized')

    const { approvalPolicy, sandbox } = policyForMode(this.permissionMode)
    const params: Record<string, unknown> = {
      cwd: this.workingDir,
      approvalPolicy,
      sandbox,
      ...(this.model ? { model: this.model } : {}),
    }
    const res = this.threadId
      ? await this.request('thread/resume', { threadId: this.threadId, ...params })
      : await this.request('thread/start', params)

    const data = res as { thread?: { id?: string }; model?: string }
    if (data.thread?.id) this.threadId = data.thread.id

    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.ready = true
    this.emit('system_init', this.model || data.model || 'codex')

    // Flush any messages queued while the handshake was in flight
    const queued = this.queuedMessages
    this.queuedMessages = []
    for (const content of queued) this.dispatchTurn(content)
  }

  // -------------------------------------------------------------------------
  // JSON-RPC plumbing
  // -------------------------------------------------------------------------

  private write(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return
    try {
      this.proc.stdin.write(JSON.stringify(msg) + '\n')
    } catch (err) {
      this.emit('error', `Failed to write to Codex: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Send a client→server request. timeoutMs=0 disables the timeout (long-running turns). */
  private request(method: string, params?: Record<string, unknown>, timeoutMs: number = RPC_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextRpcId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`Codex request ${method} timed out after ${timeoutMs / 1000}s`))
          }, timeoutMs)
        : null
      this.pending.set(id, { resolve, reject, method, timer })
      this.write({ id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  private notify(method: string, params?: Record<string, unknown>): void {
    this.write({ method, ...(params !== undefined ? { params } : {}) })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: CodexRpcMessage
    try {
      msg = JSON.parse(trimmed) as CodexRpcMessage
    } catch {
      // Codex may print non-JSON banners on stdout — skip them.
      return
    }
    this._receivedOutput = true

    if (msg.id !== undefined && msg.method) {
      // Server-initiated request (approval ask)
      this.handleServerRequest(msg.id, msg.method, msg.params ?? {})
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const req = this.pending.get(msg.id as number)
      if (!req) return
      this.pending.delete(msg.id as number)
      if (req.timer) clearTimeout(req.timer)
      if (msg.error) req.reject(new Error(msg.error.message || `Codex ${req.method} failed`))
      else req.resolve(msg.result)
      return
    }
    if (msg.method) {
      this.handleNotification(msg.method, msg.params ?? {})
    }
  }

  // -------------------------------------------------------------------------
  // Server-initiated approval requests
  // -------------------------------------------------------------------------

  private handleServerRequest(rpcId: number | string, method: string, params: Record<string, unknown>): void {
    const autoApprove = this.permissionMode === 'bypassPermissions' || this.permissionMode === 'dangerouslySkipPermissions'

    switch (method) {
      case 'item/commandExecution/requestApproval': {
        if (autoApprove) {
          this.write({ id: rpcId, result: { decision: 'accept' } })
          return
        }
        const requestId = `${APPROVAL_ID_PREFIX}${rpcId}`
        this.serverApprovals.set(requestId, { rpcId, method })
        const input: Record<string, unknown> = {
          command: params.command,
          ...(params.cwd ? { cwd: params.cwd } : {}),
          ...(params.reason ? { reason: params.reason } : {}),
        }
        this.emit('control_request', requestId, 'Bash', input)
        return
      }

      case 'item/fileChange/requestApproval': {
        if (autoApprove || this.permissionMode === 'acceptEdits') {
          this.write({ id: rpcId, result: { decision: 'accept' } })
          return
        }
        const requestId = `${APPROVAL_ID_PREFIX}${rpcId}`
        this.serverApprovals.set(requestId, { rpcId, method })
        const input: Record<string, unknown> = {
          ...(params.reason ? { reason: params.reason } : {}),
          ...(params.grantRoot ? { grantRoot: params.grantRoot } : {}),
        }
        this.emit('control_request', requestId, 'Edit', input)
        return
      }

      default:
        // Unsupported server request (permissions profiles, tool user input,
        // MCP elicitation, …). Respond with a JSON-RPC error so the turn does
        // not hang waiting for an answer we cannot provide.
        console.warn(`[codex] Unsupported server request: ${method} — declining`)
        this.write({ id: rpcId, error: { code: -32601, message: `Codekin does not support ${method}` } })
    }
  }

  // -------------------------------------------------------------------------
  // Notification → ClaudeProcessEvents mapping
  // -------------------------------------------------------------------------

  private handleNotification(method: string, params: Record<string, unknown>): void {
    switch (method) {
      case 'thread/started': {
        const thread = params.thread as { id?: string } | undefined
        if (thread?.id) this.threadId = thread.id
        break
      }

      case 'turn/started': {
        const turn = params.turn as { id?: string } | undefined
        this.currentTurnId = turn?.id ?? null
        this.turnActive = true
        break
      }

      case 'item/agentMessage/delta': {
        const delta = params.delta as string | undefined
        if (delta) {
          this.receivedDeltas = true
          this.emit('text', delta)
        }
        break
      }

      case 'item/reasoning/summaryTextDelta': {
        const delta = params.delta as string | undefined
        const itemId = params.itemId as string | undefined
        if (!delta) break
        // New reasoning item → allow a fresh thinking summary
        if (itemId && itemId !== this.lastReasoningItemId) {
          this.lastReasoningItemId = itemId
          this.reasoningBuffer = ''
          this.emittedReasoningSummary = false
        }
        this.reasoningBuffer += delta
        if (this.reasoningBuffer.length > 20 && !this.emittedReasoningSummary) {
          this.emittedReasoningSummary = true
          this.emit('thinking', this.summarizeReasoning(this.reasoningBuffer))
        }
        break
      }

      case 'item/started': {
        const item = params.item as CodexThreadItem | undefined
        if (item) this.handleItemStarted(item)
        break
      }

      case 'item/completed': {
        const item = params.item as CodexThreadItem | undefined
        if (item) this.handleItemCompleted(item)
        break
      }

      case 'turn/plan/updated': {
        const plan = params.plan as Array<{ step: string; status: string }> | undefined
        if (!Array.isArray(plan)) break
        const tasks: TaskItem[] = plan.map((p, i) => ({
          id: String(i + 1),
          subject: p.step,
          status: p.status === 'inProgress' ? 'in_progress' : p.status === 'completed' ? 'completed' : 'pending',
        }))
        this.emit('todo_update', tasks)
        break
      }

      case 'turn/completed': {
        const turn = params.turn as { status?: string; error?: { message?: string } | null } | undefined
        this.turnActive = false
        this.currentTurnId = null
        if (turn?.status === 'failed') {
          this.emit('result', turn.error?.message || 'Codex turn failed', true)
        } else {
          this.emit('result', '', false)
        }
        // Start the next queued turn, if any
        const next = this.queuedMessages.shift()
        if (next !== undefined) this.dispatchTurn(next)
        break
      }

      case 'error': {
        const error = params.error as { message?: string; codexErrorInfo?: unknown } | undefined
        const willRetry = params.willRetry === true
        const message = error?.message || 'Unknown Codex error'
        if (error?.codexErrorInfo === 'usageLimitExceeded') {
          this.emit('rate_limit', { ...params })
          this.emit('error', message)
        } else if (error?.codexErrorInfo === 'unauthorized') {
          this._authFailed = true
          this.emit('error', 'Codex is not authenticated. Run `codex login` on the host.')
        } else if (!willRetry) {
          this.emit('error', message)
        } else {
          console.warn(`[codex] Transient error (will retry): ${message}`)
        }
        break
      }

      case 'account/rateLimits/updated': {
        this.emit('rate_limit', { ...params })
        break
      }

      default:
        // Many notifications (token usage, diffs, raw items, …) need no mapping.
        break
    }
  }

  private handleItemStarted(item: CodexThreadItem): void {
    switch (item.type) {
      case 'commandExecution':
        this.emit('tool_active', 'Bash', item.command ? summarizeToolInput('Bash', { command: item.command }) : undefined)
        break
      case 'fileChange': {
        const paths = (item.changes ?? []).map(c => c.path).join(', ')
        this.emit('tool_active', 'Edit', paths || undefined)
        break
      }
      case 'mcpToolCall':
        this.emit('tool_active', item.tool || 'MCP', item.server)
        break
      case 'webSearch':
        this.emit('tool_active', 'WebSearch', item.query)
        break
    }
  }

  private handleItemCompleted(item: CodexThreadItem): void {
    switch (item.type) {
      case 'agentMessage':
        // Text normally arrives via deltas; emit the full text only when no
        // deltas were received this turn (e.g. non-streaming model/config).
        if (item.text && !this.receivedDeltas) {
          this.emit('text', item.text)
        }
        break

      case 'reasoning': {
        // Fallback: emit a thinking summary when no summary deltas streamed.
        const summary = (item.summary ?? []).join(' ').trim()
        if (summary && !this.emittedReasoningSummary) {
          this.emittedReasoningSummary = true
          this.emit('thinking', this.summarizeReasoning(summary))
        }
        break
      }

      case 'commandExecution': {
        const failed = item.status === 'failed' || (item.exitCode != null && item.exitCode !== 0)
        const declined = item.status === 'declined'
        const output = item.aggregatedOutput || ''
        const summary = declined ? 'Declined' : output ? output.slice(0, 200) : undefined
        this.emit('tool_done', 'Bash', summary)
        if (output) {
          const truncated = output.length > 2000
            ? output.slice(0, 2000) + `\n… (truncated, ${output.length} chars total)`
            : output
          this.emit('tool_output', truncated, failed)
        }
        break
      }

      case 'fileChange': {
        const declined = item.status === 'declined'
        const failed = item.status === 'failed'
        const paths = (item.changes ?? []).map(c => c.path).join(', ')
        const summary = declined ? 'Declined' : failed ? `Failed: ${paths}` : paths || undefined
        this.emit('tool_done', 'Edit', summary)
        break
      }

      case 'mcpToolCall':
        this.emit('tool_done', item.tool || 'MCP', item.status === 'failed' ? 'Error' : undefined)
        break

      case 'webSearch':
        this.emit('tool_done', 'WebSearch', item.query)
        break
    }
  }

  /** Extract a short first-sentence summary from reasoning text (mirrors OpenCodeProcess). */
  private summarizeReasoning(text: string): string {
    const match = text.match(/^(.+?[.!?\n])/)
    return match && match[1].length <= 120
      ? match[1].replace(/\n/g, ' ').trim()
      : text.slice(0, 80).trim()
  }

  // -------------------------------------------------------------------------
  // CodingProcess interface
  // -------------------------------------------------------------------------

  /** Send a user message — starts a new turn (or queues it if one is active). */
  sendMessage(content: string): void {
    if (!this.alive) {
      this.emit('error', 'Codex process is not running')
      return
    }
    if (!this.ready || this.turnActive) {
      this.queuedMessages.push(content)
      return
    }
    this.dispatchTurn(content)
  }

  private dispatchTurn(content: string): void {
    if (!this.threadId) {
      this.queuedMessages.unshift(content)
      return
    }
    // Reset per-turn streaming state
    this.turnActive = true
    this.receivedDeltas = false
    this.reasoningBuffer = ''
    this.emittedReasoningSummary = false
    this.lastReasoningItemId = null

    const input = this.buildInput(content)
    // No timeout: turn/start's response arrives when the turn is created, but
    // be safe against servers that respond late in long turns.
    this.request('turn/start', { threadId: this.threadId, input }, 0).catch((err: Error) => {
      if (!this.alive) return
      this.turnActive = false
      this.emit('error', `Failed to start Codex turn: ${err.message}`)
      this.emit('result', err.message, true)
    })
  }

  /**
   * Build the turn input parts. Parses the frontend's
   * `[Attached files: …]` prefix and converts images to localImage parts
   * (Codex reads them from disk — no base64 upload needed).
   */
  private buildInput(content: string): Array<Record<string, unknown>> {
    const parts: Array<Record<string, unknown>> = []
    let textContent = content
    const attachMatch = content.match(/^\[Attached files: ([^\]]+)\]\n?/)
    if (attachMatch) {
      textContent = content.slice(attachMatch[0].length)
      const imageExts = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
      for (const filePath of attachMatch[1].split(',').map(p => p.trim())) {
        if (!existsSync(filePath)) {
          console.warn(`[codex] Attached file not found: ${filePath}`)
          continue
        }
        if (imageExts.has(extname(filePath).toLowerCase())) {
          parts.push({ type: 'localImage', path: filePath })
        } else {
          // Codex has no generic file part — reference the path in text so the
          // agent can read it with its own tools.
          textContent = `[Attached file: ${filePath}]\n${textContent}`
        }
      }
    }
    if (textContent.trim()) {
      parts.push({ type: 'text', text: textContent, text_elements: [] })
    }
    return parts
  }

  /** No-op for Codex — raw protocol data is Claude-specific. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendRaw(_: string): void {
    // Codex uses JSON-RPC requests, not raw stdin passthrough
  }

  /**
   * Respond to an approval request. Maps Codekin's allow/deny to Codex's
   * accept/decline decision on the original server-initiated JSON-RPC request.
   */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny'): void {
    const approval = this.serverApprovals.get(requestId)
    if (!approval) {
      console.warn(`[codex] No pending approval for request ${requestId}`)
      return
    }
    this.serverApprovals.delete(requestId)
    this.write({ id: approval.rpcId, result: { decision: behavior === 'allow' ? 'accept' : 'decline' } })
  }

  /** Interrupt any active turn, then terminate the app-server child. */
  stop(): void {
    if (!this.alive && !this.proc) return
    this.alive = false
    this.ready = false
    this.cleanupTimers()

    if (this.turnActive && this.threadId && this.currentTurnId && this.proc?.stdin?.writable) {
      // Best-effort interrupt — don't wait for the response.
      this.write({ id: this.nextRpcId++, method: 'turn/interrupt', params: { threadId: this.threadId, turnId: this.currentTurnId } })
    }

    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      this.proc.kill('SIGTERM')
      this.killTimer = setTimeout(() => {
        this.killTimer = null
        // killed=true only means SIGTERM was sent — check exitCode to see if
        // the process actually terminated before escalating to SIGKILL.
        if (this.proc && this.proc.exitCode === null) this.proc.kill('SIGKILL')
      }, 5_000)
    }
  }

  private cleanupTimers(): void {
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
  }

  /**
   * No-op: Codex emits the full plan on every turn/plan/updated notification,
   * so there is no incremental task state to seed after a restart.
   */
  seedTasks(): void {}

  isAlive(): boolean {
    return this.alive
  }

  isReady(): boolean {
    return this.alive && this.ready && this.threadId !== null
  }

  getSessionId(): string {
    return this.threadId ?? this.sessionId
  }

  waitForExit(timeoutMs = 10000): Promise<void> {
    if (!this.alive && !this.proc) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  // -------------------------------------------------------------------------
  // Restart-scheduler diagnostics (duck-typed by session-lifecycle.ts)
  // -------------------------------------------------------------------------

  /**
   * True when the exit is non-retryable without operator action. For Codex
   * that means an auth failure — restarting cannot help until `codex login`
   * is run on the host. (Named for parity with ClaudeProcess's duck-typed
   * diagnostic; the restart scheduler treats it as "do not auto-restart".)
   */
  hasSessionConflict(): boolean {
    return this._authFailed
  }

  /** True if the process produced at least one valid JSON message before exiting. */
  hadOutput(): boolean {
    return this._receivedOutput
  }

  /** True if spawn() itself failed (ENOENT, EACCES) — process never started. */
  hasSpawnFailed(): boolean {
    return this._spawnFailed
  }
}
