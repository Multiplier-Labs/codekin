/**
 * Manages a Grok Build session via `grok agent stdio` — the Agent Client
 * Protocol (ACP): JSON-RPC 2.0 over stdin/stdout, newline-delimited.
 *
 * Lifecycle: initialize → session/new (or session/load) → session/prompt per
 * turn, with `session/update` notifications streaming the turn and
 * agent→client `session/request_permission` requests for tool approvals.
 * The `session/prompt` response ends the turn.
 *
 * Behaviour verified against grok 1.0.44 (docs/GROK-BUILD-INTEGRATION-SPEC.md
 * § Spike results). The ones that shape this adapter:
 * - Claude hooks from ~/.claude/settings.json run inside Grok by default, and
 *   Codekin's global PreToolUse hook pre-approves tools there — bypassing
 *   ACP approvals entirely. The child is always spawned with
 *   GROK_CLAUDE_HOOKS_ENABLED=false so approvals flow through ACP only.
 * - A rejected permission ends the turn (stopReason `cancelled`).
 * - `session/load` replays history as `session/update` notifications before
 *   its response; those are dropped (Codekin already holds the transcript).
 * - `session/set_mode` returns `{}` even for unknown ids; the
 *   `current_mode_update` notification is the real acknowledgement.
 *
 * Auth: the host must be signed in (`grok login`) or have XAI_API_KEY set.
 * Grok stores its own credentials; Codekin never reads them.
 */

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { ClaudeProcessEvents } from './claude-process.js'
import { GROK_CAPABILITIES, type CodingProcess, type CodingProvider, type ProviderCapabilities } from './coding-process.js'
import { buildHarnessEnv } from './harness-env.js'
import { resolveAttachmentPath } from './attachment-paths.js'
import { summarizeToolInput } from './tool-labels.js'
import type { PermissionMode } from './types.js'
import {
  type AcpMessage,
  type AcpPermissionOption,
  type AcpToolCall,
  type GrokModelInfo,
  grokModeIdFor,
  isYoloMode,
  modelsFromState,
  normalizeGrokTool,
  pickPermissionOption,
  planEntriesToTasks,
  resultForStopReason,
  sessionMetaForMode,
  summarizeThought,
  toolContentPaths,
  toolContentText,
  usageFromPromptResult,
} from './grok-acp.js'

export const GROK_BINARY = process.env.GROK_BINARY || 'grok'

/** ACP protocol version this adapter speaks. */
const ACP_PROTOCOL_VERSION = 1

/** Default timeout for client→agent requests other than session/prompt. */
const RPC_TIMEOUT_MS = 60_000

/** How long to wait for `current_mode_update` after `session/set_mode`. */
const MODE_ACK_TIMEOUT_MS = 5_000

/** Prefix for synthesized approval request IDs surfaced via control_request. */
const APPROVAL_ID_PREFIX = 'grok-approval-'

/** Max tool output forwarded to the transcript per tool call. */
const TOOL_OUTPUT_LIMIT = 2_000

/**
 * Environment for a Grok child: the shared harness env plus the settings the
 * integration depends on. Applied after extraEnv so a session can't undo them.
 */
export function grokChildEnv(extraEnv: Record<string, string> = {}): Record<string, string> {
  return buildHarnessEnv({ ...extraEnv, GROK_CLAUDE_HOOKS_ENABLED: 'false' })
}

// ---------------------------------------------------------------------------
// Model discovery
// ---------------------------------------------------------------------------

let modelCache: { models: GrokModelInfo[]; fetchedAt: number } | null = null
const MODEL_CACHE_TTL_MS = 10 * 60 * 1000

/**
 * List Grok models by spawning a short-lived `grok agent stdio` and reading
 * the model state from its `initialize` response. Reflects what the host's
 * login allows. Returns an empty list when the binary is missing or the
 * handshake fails. Cached for 10 minutes.
 */
export async function fetchGrokModels(): Promise<{ models: GrokModelInfo[] }> {
  if (modelCache && Date.now() - modelCache.fetchedAt < MODEL_CACHE_TTL_MS) {
    return { models: modelCache.models }
  }
  return new Promise((resolve) => {
    let settled = false
    const done = (models: GrokModelInfo[]) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { proc.kill('SIGTERM') } catch { /* already dead */ }
      if (models.length > 0) modelCache = { models, fetchedAt: Date.now() }
      resolve({ models })
    }
    const timer = setTimeout(() => { done([]) }, 20_000)

    let proc: ChildProcess
    try {
      proc = spawn(GROK_BINARY, ['agent', '--no-leader', 'stdio'], { env: grokChildEnv(), stdio: ['pipe', 'pipe', 'ignore'] })
    } catch {
      clearTimeout(timer)
      resolve({ models: [] })
      return
    }
    proc.on('error', () => { done([]) })
    proc.on('close', () => { done([]) })
    proc.stdin?.on('error', () => { done([]) })

    const rl = createInterface({ input: proc.stdout! })
    rl.on('line', (line) => {
      let msg: AcpMessage
      try { msg = JSON.parse(line) as AcpMessage } catch { return }
      if (msg.id !== 1) return
      const state = (msg.result as { _meta?: { modelState?: unknown } } | undefined)?._meta?.modelState
      done(modelsFromState(state))
    })
    try {
      proc.stdin!.write(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: ACP_PROTOCOL_VERSION, clientCapabilities: {} },
      }) + '\n')
    } catch {
      done([])
    }
  })
}

/** Reset the model cache (test helper). */
export function clearGrokModelCache(): void {
  modelCache = null
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GrokProcessOptions {
  /** Codekin session ID (internal tracking). */
  sessionId?: string
  /** Grok's native session ID (for session/load) — returned by getSessionId(). */
  grokSessionId?: string
  /** Grok model ID (e.g. 'grok-4.7'). Omit to use the CLI default. */
  model?: string
  /** Additional environment variables (CODEKIN_SESSION_ID, scoped tokens, …). */
  extraEnv?: Record<string, string>
  /** Codekin permission mode — see grok-acp.ts for the mapping. */
  permissionMode?: PermissionMode
}

interface PendingRequest {
  resolve: (result: unknown) => void
  reject: (err: Error) => void
  method: string
  timer: ReturnType<typeof setTimeout> | null
}

interface OpenTool {
  name: string
  input: Record<string, unknown>
  content?: unknown
}

// ---------------------------------------------------------------------------
// GrokProcess
// ---------------------------------------------------------------------------

export class GrokProcess extends EventEmitter<ClaudeProcessEvents> implements CodingProcess {
  readonly provider: CodingProvider = 'grok'
  readonly capabilities: ProviderCapabilities = GROK_CAPABILITIES

  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private alive = false
  private ready = false
  private readonly codekinSessionId: string
  private grokSessionId: string | null
  private readonly workingDir: string
  private model?: string
  private readonly extraEnv: Record<string, string>
  private permissionMode?: PermissionMode

  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private stderrTail = ''

  private _spawnFailed = false
  private _authFailed = false
  private _receivedOutput = false

  // JSON-RPC state
  private nextRpcId = 1
  private pending = new Map<number, PendingRequest>()
  /** Synthesized approval requestId → the agent's JSON-RPC request id and offered options. */
  private approvals = new Map<string, { rpcId: number | string; options: AcpPermissionOption[] }>()

  /** True between sending session/load and its response — replayed history is dropped. */
  private replaying = false
  /** Resolvers waiting for the next current_mode_update. */
  private modeWaiters: Array<(modeId: string) => void> = []

  // Per-turn state
  private turnActive = false
  private queuedMessages: string[] = []
  private openTools = new Map<string, OpenTool>()
  private thoughtBuffer = ''
  private emittedThought = false

  constructor(workingDir: string, opts?: GrokProcessOptions) {
    super()
    this.workingDir = workingDir
    this.codekinSessionId = opts?.sessionId || randomUUID()
    this.grokSessionId = opts?.grokSessionId || null
    this.model = opts?.model
    this.extraEnv = opts?.extraEnv || {}
    this.permissionMode = opts?.permissionMode
  }

  start(): void {
    if (this.proc) return

    if (!existsSync(this.workingDir)) {
      this.emit('error', `Working directory does not exist: ${this.workingDir}`)
      process.nextTick(() => this.emit('exit', 1, null))
      return
    }

    this.alive = true
    this.proc = spawn(GROK_BINARY, ['agent', '--no-leader', 'stdio'], {
      cwd: this.workingDir,
      env: grokChildEnv(this.extraEnv),
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    this.proc.on('error', (err: NodeJS.ErrnoException) => {
      this._spawnFailed = true
      this.alive = false
      const hint = err.code === 'ENOENT'
        ? 'Grok Build CLI not found — install it with: curl -fsSL https://x.ai/cli/install.sh | bash'
        : `Failed to start Grok Build CLI: ${err.message}`
      this.emit('error', hint)
      this.cleanupTimers()
      this.emit('exit', 1, null)
    })

    // EPIPE on a closed child arrives as a stream 'error' event; unlistened,
    // Node would re-raise it and take the server down.
    this.proc.stdin?.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EPIPE') return
      this.emit('error', `Failed to write to Grok: ${err.message}`)
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
      for (const [, req] of this.pending) {
        if (req.timer) clearTimeout(req.timer)
        req.reject(new Error(`Grok exited before responding to ${req.method}`))
      }
      this.pending.clear()
      this.approvals.clear()
      if (wasAlive && this.turnActive) {
        this.turnActive = false
        this.closeOpenTools('Interrupted')
        this.emit('result', 'Grok exited unexpectedly mid-turn', true)
      }
      this.emit('exit', code, signal as string | null)
    })

    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.alive && !this.ready) {
        this.emit('error', `Grok failed to initialize within 60 seconds${this.stderrTail ? ` — stderr: ${this.stderrTail.slice(-300)}` : ''}`)
        this.stop()
      }
    }, 60_000)

    void this.initialize().catch((err: Error) => {
      if (!this.alive) return
      const msg = err.message || String(err)
      if (/unauthori[sz]ed|not.*(logged|signed).*in|authenticat/i.test(msg)) {
        this._authFailed = true
        this.emit('error', 'Grok is not authenticated. Run `grok login` on the host (or set XAI_API_KEY).')
      } else {
        this.emit('error', `Grok initialization failed: ${msg}`)
      }
      this.stop()
    })
  }

  private async initialize(): Promise<void> {
    const init = await this.request('initialize', {
      protocolVersion: ACP_PROTOCOL_VERSION,
      // Advertise nothing we don't implement: without fs/terminal client
      // capabilities, Grok runs its own tools in-process.
      clientCapabilities: {},
    }) as { protocolVersion?: unknown }
    if (init?.protocolVersion !== ACP_PROTOCOL_VERSION) {
      throw new Error(`unsupported ACP protocol version ${JSON.stringify(init?.protocolVersion)} (Codekin speaks ${ACP_PROTOCOL_VERSION})`)
    }

    const meta = sessionMetaForMode(this.permissionMode)
    const base = { cwd: this.workingDir, mcpServers: [], ...(meta ? { _meta: meta } : {}) }
    let session: { sessionId?: string; models?: { currentModelId?: string } } | undefined
    if (this.grokSessionId) {
      session = await this.loadOrStartFresh(base)
    } else {
      session = await this.request('session/new', base) as typeof session
      if (typeof session?.sessionId === 'string') this.grokSessionId = session.sessionId
    }
    if (!this.grokSessionId) throw new Error('Grok did not return a session id')

    let currentModel = session?.models?.currentModelId
    if (this.model && this.model !== currentModel) {
      try {
        await this.request('session/set_config_option', { sessionId: this.grokSessionId, configId: 'model', value: this.model })
        currentModel = this.model
      } catch (err) {
        this.emit('error', `Grok rejected model "${this.model}" (${err instanceof Error ? err.message : String(err)}) — using ${currentModel ?? 'the default model'}.`)
      }
    }

    // Align Grok's session mode (plan state persists inside Grok across
    // restarts, so set it explicitly either way).
    const modeOk = await this.applyMode(this.permissionMode)
    if (!modeOk && this.permissionMode === 'plan') {
      this.emit('error', 'Grok did not confirm plan mode — edits will still be denied by Codekin.')
    }

    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    this.ready = true
    this.emit('system_init', currentModel || this.model || 'grok')

    const queued = this.queuedMessages
    this.queuedMessages = []
    for (const content of queued) this.sendMessage(content)
  }

  /**
   * Load the stored native session; fall back to a fresh one when Grok can't
   * load it (deleted, created under another cwd, …). Auth failures rethrow.
   */
  private async loadOrStartFresh(base: Record<string, unknown>): Promise<{ sessionId?: string; models?: { currentModelId?: string } } | undefined> {
    this.replaying = true
    try {
      const res = await this.request('session/load', { ...base, sessionId: this.grokSessionId }) as { models?: { currentModelId?: string } } | undefined
      return { sessionId: this.grokSessionId ?? undefined, ...res }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (!this.alive || /unauthori[sz]ed|authenticat/i.test(msg)) throw err
      this.emit('error', `Could not resume the previous Grok session (${msg}) — starting a fresh session.`)
      this.grokSessionId = null
      const res = await this.request('session/new', base) as { sessionId?: string; models?: { currentModelId?: string } } | undefined
      if (typeof res?.sessionId === 'string') this.grokSessionId = res.sessionId
      return res
    } finally {
      this.replaying = false
    }
  }

  /** Send session/set_mode and wait for Grok's current_mode_update acknowledgement. */
  private async applyMode(mode: PermissionMode | undefined): Promise<boolean> {
    if (!this.grokSessionId) return false
    const modeId = grokModeIdFor(mode)
    const ack = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.modeWaiters = this.modeWaiters.filter(w => w !== waiter)
        resolve(false)
      }, MODE_ACK_TIMEOUT_MS)
      const waiter = (current: string) => {
        if (current !== modeId) return
        clearTimeout(timer)
        this.modeWaiters = this.modeWaiters.filter(w => w !== waiter)
        resolve(true)
      }
      this.modeWaiters.push(waiter)
    })
    try {
      await this.request('session/set_mode', { sessionId: this.grokSessionId, modeId })
    } catch {
      return false
    }
    return ack
  }

  // -------------------------------------------------------------------------
  // JSON-RPC plumbing
  // -------------------------------------------------------------------------

  private write(msg: Record<string, unknown>): void {
    if (!this.proc?.stdin?.writable) return
    try {
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n')
    } catch (err) {
      this.emit('error', `Failed to write to Grok: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** Send a client→agent request. timeoutMs=0 disables the timeout (prompt turns). */
  private request(method: string, params?: Record<string, unknown>, timeoutMs: number = RPC_TIMEOUT_MS): Promise<unknown> {
    const id = this.nextRpcId++
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id)
            reject(new Error(`Grok request ${method} timed out after ${timeoutMs / 1000}s`))
          }, timeoutMs)
        : null
      this.pending.set(id, { resolve, reject, method, timer })
      this.write({ id, method, ...(params !== undefined ? { params } : {}) })
    })
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let msg: AcpMessage
    try {
      msg = JSON.parse(trimmed) as AcpMessage
    } catch {
      return // non-JSON banner lines
    }
    this._receivedOutput = true

    if (msg.id !== undefined && msg.method) {
      this.handleAgentRequest(msg.id, msg.method, msg.params ?? {})
      return
    }
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const req = this.pending.get(msg.id as number)
      if (!req) return
      this.pending.delete(msg.id as number)
      if (req.timer) clearTimeout(req.timer)
      if (msg.error) {
        const detail = typeof msg.error.data === 'string' ? `: ${msg.error.data}` : ''
        req.reject(new Error(`${msg.error.message || `Grok ${req.method} failed`}${detail}`))
      } else {
        req.resolve(msg.result)
      }
      return
    }
    if (msg.method === 'session/update') {
      if (this.replaying) return
      const update = (msg.params as { update?: Record<string, unknown> } | undefined)?.update
      if (update) this.handleSessionUpdate(update)
    }
    // `_x.ai/*` extension notifications (setup phases, MCP status, queue,
    // announcements, …) are not part of the contract Codekin relies on.
  }

  // -------------------------------------------------------------------------
  // Agent → client requests
  // -------------------------------------------------------------------------

  private handleAgentRequest(rpcId: number | string, method: string, params: Record<string, unknown>): void {
    if (method !== 'session/request_permission') {
      // No fs/terminal capabilities were advertised, so nothing else should
      // arrive — answer anyway so the agent never waits on us.
      this.write({ id: rpcId, error: { code: -32601, message: `Codekin does not support ${method}` } })
      return
    }
    const options = Array.isArray(params.options) ? params.options as AcpPermissionOption[] : []
    const toolCall = (params.toolCall ?? {}) as AcpToolCall
    const { name, input } = normalizeGrokTool(toolCall)

    if (isYoloMode(this.permissionMode)) {
      // Grok's yoloMode should not ask at all; if it does, answer as allowed.
      this.answerPermission(rpcId, options, 'allow')
      return
    }
    const requestId = `${APPROVAL_ID_PREFIX}${String(rpcId)}`.slice(0, 64)
    this.approvals.set(requestId, { rpcId, options })
    this.emit('control_request', requestId, name, input)
  }

  private answerPermission(rpcId: number | string, options: AcpPermissionOption[], behavior: 'allow' | 'deny' | 'allow_always'): void {
    const optionId = pickPermissionOption(options, behavior)
    this.write({
      id: rpcId,
      result: { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } },
    })
  }

  // -------------------------------------------------------------------------
  // session/update → ClaudeProcessEvents
  // -------------------------------------------------------------------------

  private handleSessionUpdate(update: Record<string, unknown>): void {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk': {
        const text = (update.content as { type?: string; text?: unknown } | undefined)?.text
        if (typeof text === 'string' && text) {
          this.resetThought()
          this.emit('text', text)
        }
        break
      }

      case 'agent_thought_chunk': {
        const text = (update.content as { text?: unknown } | undefined)?.text
        if (typeof text !== 'string' || !text) break
        this.thoughtBuffer += text
        if (!this.emittedThought && this.thoughtBuffer.length > 20) {
          this.emittedThought = true
          this.emit('thinking', summarizeThought(this.thoughtBuffer))
        }
        break
      }

      case 'tool_call': {
        const call = update as AcpToolCall
        if (!call.toolCallId) break
        this.resetThought()
        const tool = normalizeGrokTool(call)
        this.openTools.set(call.toolCallId, { name: tool.name, input: tool.input })
        this.emit('tool_active', tool.name, this.toolSummary(tool.name, tool.input))
        if (call.status === 'completed' || call.status === 'failed') this.finishTool(call)
        break
      }

      case 'tool_call_update': {
        const call = update as AcpToolCall
        if (!call.toolCallId) break
        const open = this.openTools.get(call.toolCallId)
        if (open && (call.rawInput || call.kind)) {
          // Later updates carry the classified kind and full input.
          const tool = normalizeGrokTool({ ...call, rawInput: call.rawInput ?? open.input })
          open.input = { ...open.input, ...tool.input }
        }
        if (open && call.content !== undefined) open.content = call.content
        if (call.status === 'completed' || call.status === 'failed') this.finishTool(call)
        break
      }

      case 'plan': {
        const tasks = planEntriesToTasks(update.entries)
        if (tasks) this.emit('todo_update', tasks)
        break
      }

      case 'current_mode_update': {
        const modeId = update.currentModeId
        if (typeof modeId === 'string') for (const w of [...this.modeWaiters]) w(modeId)
        break
      }

      default:
        // available_commands_update, session_info_update, config_option_update, …
        break
    }
  }

  private toolSummary(name: string, input: Record<string, unknown>): string | undefined {
    return Object.keys(input).length > 0 ? summarizeToolInput(name, input) : undefined
  }

  private finishTool(call: AcpToolCall): void {
    const id = call.toolCallId!
    const open = this.openTools.get(id)
    this.openTools.delete(id)
    const name = open?.name ?? normalizeGrokTool(call).name
    const failed = call.status === 'failed'
    const content = call.content ?? open?.content
    const text = toolContentText(content)
    const paths = toolContentPaths(content)

    let summary: string | undefined
    if (failed) summary = text ? text.slice(0, 200) : 'Failed'
    else if (paths.length > 0) summary = paths.join(', ')
    else if (text) summary = text.slice(0, 200)
    this.emit('tool_done', name, summary)

    if (text && name !== 'Read') {
      const truncated = text.length > TOOL_OUTPUT_LIMIT
        ? text.slice(0, TOOL_OUTPUT_LIMIT) + `\n… (truncated, ${text.length} chars total)`
        : text
      this.emit('tool_output', truncated, failed)
    }
  }

  private closeOpenTools(summary: string): void {
    for (const [, tool] of this.openTools) this.emit('tool_done', tool.name, summary)
    this.openTools.clear()
  }

  private resetThought(): void {
    this.thoughtBuffer = ''
    this.emittedThought = false
  }

  // -------------------------------------------------------------------------
  // CodingProcess interface
  // -------------------------------------------------------------------------

  /** Send a user message — starts a turn, or queues it behind the active one. */
  sendMessage(content: string): void {
    if (!this.alive) {
      this.emit('error', 'Grok process is not running')
      return
    }
    if (!this.ready || this.turnActive || !this.grokSessionId) {
      this.queuedMessages.push(content)
      return
    }
    this.turnActive = true
    this.resetThought()
    this.openTools.clear()

    this.request('session/prompt', { sessionId: this.grokSessionId, prompt: this.buildPrompt(content) }, 0)
      .then((res) => {
        const r = res as { stopReason?: unknown } | undefined
        this.endTurn()
        const usage = usageFromPromptResult(res)
        if (usage) this.emit('usage', usage)
        const { text, isError } = resultForStopReason(r?.stopReason)
        this.emit('result', text, isError)
      })
      .catch((err: Error) => {
        if (!this.alive) return
        this.endTurn()
        this.emit('error', `Grok turn failed: ${err.message}`)
        this.emit('result', err.message, true)
      })
      .finally(() => {
        const next = this.queuedMessages.shift()
        if (next !== undefined && this.alive) this.sendMessage(next)
      })
  }

  private endTurn(): void {
    this.turnActive = false
    this.closeOpenTools('Interrupted')
    // Grok resolves its own pending permission when a turn ends; answers to
    // prompts still open in the UI would target a finished request.
    this.approvals.clear()
  }

  /**
   * Build ACP prompt content blocks. Parses the frontend's
   * `[Attached files: …]` prefix; Grok advertises no image input, so every
   * attachment is referenced by path for Grok to read with its own tools.
   */
  private buildPrompt(content: string): Array<Record<string, unknown>> {
    let text = content
    const attachMatch = content.match(/^\[Attached files: ([^\]]+)\]\n?/)
    if (attachMatch) {
      text = content.slice(attachMatch[0].length)
      const refs: string[] = []
      for (const rawPath of attachMatch[1].split(',').map(p => p.trim())) {
        // Only files inside the upload directory may be referenced — a client
        // can forge this prefix with any path.
        const filePath = resolveAttachmentPath(rawPath)
        if (!filePath) {
          console.warn(`[grok] Rejected attachment outside the upload directory: ${rawPath}`)
          continue
        }
        refs.push(`[Attached file: ${filePath}]`)
      }
      if (refs.length > 0) text = `${refs.join('\n')}\n${text}`
    }
    return [{ type: 'text', text }]
  }

  /** No-op — Grok is driven by JSON-RPC requests, not raw stdin passthrough. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendRaw(_: string): void {}

  /** Answer a pending `session/request_permission` with the matching offered option. */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny' | 'allow_always'): void {
    const approval = this.approvals.get(requestId)
    if (!approval) {
      console.warn(`[grok] No pending approval for request ${requestId}`)
      return
    }
    this.approvals.delete(requestId)
    this.answerPermission(approval.rpcId, approval.options, behavior)
  }

  /**
   * Switch between ask and plan in place via `session/set_mode`. Changes that
   * cross always-approve (set only at session/new or /load) return false so
   * the caller restarts the process with the new `_meta`.
   */
  async setPermissionMode(mode: PermissionMode): Promise<boolean> {
    if (!this.alive || !this.ready) return false
    if (isYoloMode(mode) !== isYoloMode(this.permissionMode)) return false
    const ok = await this.applyMode(mode)
    if (ok) this.permissionMode = mode
    return ok
  }

  /** Cancel any active turn, then terminate the child. */
  stop(): void {
    if (!this.alive && !this.proc) return
    this.alive = false
    this.ready = false
    this.cleanupTimers()

    if (this.turnActive && this.grokSessionId && this.proc?.stdin?.writable) {
      this.write({ method: 'session/cancel', params: { sessionId: this.grokSessionId } })
    }
    this.approvals.clear()

    if (this.proc && this.proc.exitCode === null && !this.proc.killed) {
      this.proc.kill('SIGTERM')
      this.killTimer = setTimeout(() => {
        this.killTimer = null
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

  /** No-op: Grok re-sends its full plan on every `plan` update. */
  seedTasks(): void {}

  isAlive(): boolean {
    return this.alive
  }

  isReady(): boolean {
    return this.alive && this.ready && this.grokSessionId !== null
  }

  getSessionId(): string {
    return this.grokSessionId ?? this.codekinSessionId
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

  /** True when restarting cannot help until the operator signs in (`grok login`). */
  hasSessionConflict(): boolean {
    return this._authFailed
  }

  hadOutput(): boolean {
    return this._receivedOutput
  }

  hasSpawnFailed(): boolean {
    return this._spawnFailed
  }
}
