/**
 * Manages an OpenCode server session via HTTP REST + SSE.
 *
 * OpenCode (github.com/anomalyco/opencode) uses a client/server architecture:
 * - `opencode serve` runs a long-lived HTTP server
 * - Sessions are created/managed via REST API
 * - Real-time events stream via SSE (Server-Sent Events)
 *
 * This class wraps that model behind the same CodingProcess interface that
 * ClaudeProcess implements, so SessionManager works identically for both.
 *
 * Key differences from ClaudeProcess:
 * - No child process per session — one shared OpenCode server
 * - Messages sent via HTTP POST, not stdin
 * - Events received via SSE, not stdout NDJSON
 * - Permissions handled via POST /permission/:id/reply, not control_response on stdin
 */

import { EventEmitter } from 'events'
import { spawn, type ChildProcess } from 'child_process'
import { randomUUID } from 'crypto'
import type { ClaudeProcessEvents } from './claude-process.js'
import { OPENCODE_CAPABILITIES, type CodingProcess, type CodingProvider, type ProviderCapabilities } from './coding-process.js'
import type { PermissionMode, TaskItem } from './types.js'
import { summarizeToolInput } from './tool-labels.js'

// ---------------------------------------------------------------------------
// OpenCode SSE event types (subset — only what we need to map)
// ---------------------------------------------------------------------------

/** A part within an OpenCode message (text, reasoning, tool, step markers). */
interface OpenCodeMessagePart {
  type: 'text' | 'reasoning' | 'tool' | 'step-start' | 'step-finish'
  /** Text/reasoning content (field name is 'text', not 'content'). */
  text?: string
  /** Tool name (only for type='tool'). */
  tool?: string
  /** Tool state — an object, not a string. Contains status, input, output, time, etc. */
  state?: {
    status: 'pending' | 'running' | 'completed' | 'error'
    input?: Record<string, unknown>
    output?: string
    error?: string
    time?: { start?: number; end?: number }
    metadata?: Record<string, unknown>
    title?: string
  }
  time?: { start?: number; end?: number }
  metadata?: Record<string, unknown>
}

/** Shape of an SSE event from OpenCode's GET /event endpoint. */
interface OpenCodeSSEEvent {
  type: string
  properties: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// OpenCode server manager (singleton — one server for all sessions)
// ---------------------------------------------------------------------------

interface OpenCodeServerState {
  process: ChildProcess | null
  port: number
  password: string
  ready: boolean
  startPromise: Promise<void> | null
}

const serverState: OpenCodeServerState = {
  process: null,
  port: 0,
  password: '',
  ready: false,
  startPromise: null,
}

/**
 * Ensure the OpenCode server is running. Starts it if not already running.
 * Returns the base URL for API calls.
 */
async function ensureOpenCodeServer(workingDir: string): Promise<string> {
  if (serverState.ready && serverState.process && !serverState.process.killed) {
    return `http://localhost:${serverState.port}`
  }

  if (serverState.startPromise) {
    await serverState.startPromise
    return `http://localhost:${serverState.port}`
  }

  serverState.startPromise = startOpenCodeServer(workingDir)
  try {
    await serverState.startPromise
  } finally {
    serverState.startPromise = null
  }
  return `http://localhost:${serverState.port}`
}

async function startOpenCodeServer(workingDir: string): Promise<void> {
  // Pick a port in the ephemeral range
  serverState.port = 14096 + Math.floor(Math.random() * 1000)
  serverState.password = randomUUID()

  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] => entry[1] != null
      )
    ),
    OPENCODE_SERVER_PASSWORD: serverState.password,
  }

  const proc = spawn('opencode', ['serve', '--port', String(serverState.port)], {
    cwd: workingDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
  })
  serverState.process = proc

  proc.on('close', () => {
    serverState.ready = false
    serverState.process = null
  })

  // Wait for server to become ready (poll health endpoint)
  const baseUrl = `http://localhost:${serverState.port}`
  const maxAttempts = 30
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise(r => setTimeout(r, 1000))
    try {
      const res = await fetch(`${baseUrl}/health`, {
        headers: authHeaders(),
        signal: AbortSignal.timeout(2000),
      })
      if (res.ok) {
        serverState.ready = true
        console.log(`[opencode-server] Ready on port ${serverState.port}`)
        return
      }
    } catch {
      // Server not ready yet
    }
  }

  // Kill orphaned process that never became healthy
  if (serverState.process) {
    serverState.process.kill('SIGTERM')
    serverState.process = null
  }
  throw new Error(`OpenCode server failed to start within ${maxAttempts}s`)
}

/** Build auth headers for OpenCode API calls. */
function authHeaders(): Record<string, string> {
  if (!serverState.password) return {}
  const encoded = Buffer.from(`opencode:${serverState.password}`).toString('base64')
  return { Authorization: `Basic ${encoded}` }
}

/** OpenCode model info returned from /config/providers. */
export interface OpenCodeModelInfo {
  id: string
  name: string
  providerID: string
  providerName: string
}

/**
 * Fetch the list of configured models from the running OpenCode server.
 * Returns an empty array if the server is not running.
 */
export async function fetchOpenCodeModels(workingDir: string): Promise<{
  models: OpenCodeModelInfo[]
  defaults: Record<string, string>
}> {
  try {
    const baseUrl = await ensureOpenCodeServer(workingDir)
    const res = await fetch(`${baseUrl}/config/providers`, {
      headers: {
        ...authHeaders(),
        'x-opencode-directory': workingDir,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return { models: [], defaults: {} }
    const data = await res.json() as {
      providers: Array<{
        id: string
        name: string
        models: Record<string, { id: string; name: string }>
      }>
      default?: Record<string, string>
    }
    const models: OpenCodeModelInfo[] = []
    for (const p of data.providers) {
      for (const m of Object.values(p.models)) {
        models.push({ id: m.id, name: m.name, providerID: p.id, providerName: p.name })
      }
    }
    return { models, defaults: data.default ?? {} }
  } catch {
    return { models: [], defaults: {} }
  }
}

/** Stop the shared OpenCode server. */
export function stopOpenCodeServer(): void {
  if (serverState.process) {
    serverState.process.kill('SIGTERM')
    serverState.process = null
    serverState.ready = false
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface OpenCodeProcessOptions {
  /** Absolute path to the project directory. */
  workingDir: string
  /** Codekin session ID (used for internal tracking). */
  sessionId?: string
  /** OpenCode's own session ID (used for resume — returned by getSessionId()). */
  opencodeSessionId?: string
  /** Model in provider/model format (e.g. 'anthropic/claude-sonnet-4'). */
  model?: string
  /** Additional environment variables (CODEKIN_SESSION_ID, etc.). */
  extraEnv?: Record<string, string>
  /** Permission mode — mapped to OpenCode's permission config. */
  permissionMode?: PermissionMode
}

// ---------------------------------------------------------------------------
// OpenCodeProcess
// ---------------------------------------------------------------------------

export class OpenCodeProcess extends EventEmitter<ClaudeProcessEvents> implements CodingProcess {
  readonly provider: CodingProvider = 'opencode'
  readonly capabilities: ProviderCapabilities = OPENCODE_CAPABILITIES

  private sessionId: string
  private opencodeSessionId: string | null = null
  private workingDir: string
  private model?: string
  private alive = false
  private abortController: AbortController | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private permissionMode?: PermissionMode
  private tasks = new Map<string, TaskItem>()
  private turnComplete = false
  private taskSeq = 0

  constructor(workingDir: string, opts?: Partial<OpenCodeProcessOptions>) {
    super()
    this.workingDir = workingDir
    this.sessionId = opts?.sessionId || randomUUID()
    this.opencodeSessionId = opts?.opencodeSessionId || null
    this.model = opts?.model
    this.permissionMode = opts?.permissionMode
  }

  /** Connect to the OpenCode server, create a session, and subscribe to SSE events. */
  start(): void {
    if (this.alive) return

    this.alive = true

    // Startup timeout
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.alive) {
        this.emit('error', 'OpenCode process failed to initialize within 60 seconds')
        this.stop()
      }
    }, 60_000)

    void this.initialize().catch((err) => {
      this.emit('error', `OpenCode initialization failed: ${err instanceof Error ? err.message : String(err)}`)
      this.stop()
    })
  }

  private async initialize(): Promise<void> {
    const baseUrl = await ensureOpenCodeServer(this.workingDir)

    // Create or resume a session — must happen BEFORE SSE subscription
    // so that this.opencodeSessionId is set and the session ID filter
    // guards in handleSSEEvent() are active (prevents cross-session leakage).
    if (this.opencodeSessionId) {
      // Resume existing session — just reconnect to SSE
    } else {
      const createRes = await fetch(`${baseUrl}/session`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
          'x-opencode-directory': this.workingDir,
        },
        body: JSON.stringify({
          title: `Codekin session ${this.sessionId.slice(0, 8)}`,
        }),
      })

      if (!createRes.ok) {
        throw new Error(`Failed to create OpenCode session: ${createRes.status} ${await createRes.text()}`)
      }

      const data = await createRes.json() as { id: string }
      this.opencodeSessionId = data.id
    }

    // Subscribe to SSE events AFTER opencodeSessionId is set so session
    // filtering is active from the first event received.
    this.subscribeToEvents(baseUrl)

    // Clear startup timer and emit init
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }

    // Model is stored as "providerID/modelID" — show everything after the first slash
    const modelName = this.model?.includes('/') ? this.model.slice(this.model.indexOf('/') + 1) : (this.model || 'opencode (default)')
    this.emit('system_init', modelName)
  }

  /** Subscribe to the OpenCode SSE event stream and map events to CodingProcess events. */
  private subscribeToEvents(baseUrl: string): void {
    this.abortController = new AbortController()
    let reconnectDelay = 1000
    const MAX_RECONNECT_DELAY = 30_000
    const MAX_RECONNECT_ATTEMPTS = 20

    let reconnectAttempts = 0

    const connectSSE = () => {
      if (!this.alive) return

      void fetch(`${baseUrl}/event`, {
        headers: {
          ...authHeaders(),
          Accept: 'text/event-stream',
          'x-opencode-directory': this.workingDir,
        },
        signal: this.abortController!.signal,
      }).then(async (res) => {
        if (!res.ok || !res.body) {
          if (this.alive) {
            reconnectAttempts++
            if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
              this.emit('error', `SSE reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts (last status: ${res.status})`)
              return
            }
            console.warn(`[opencode-sse] Non-2xx ${res.status}, reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
            setTimeout(connectSSE, reconnectDelay)
            reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
          }
          return
        }

        // Reset backoff on successful connection
        reconnectDelay = 1000
        reconnectAttempts = 0

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (this.alive) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          let currentData = ''
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              currentData += line.slice(6)
            } else if (line === '' && currentData) {
              try {
                const event = JSON.parse(currentData) as OpenCodeSSEEvent
                this.handleSSEEvent(event)
              } catch {
                // Ignore unparseable SSE data
              }
              currentData = ''
            }
          }
        }

        // Clean EOF — reconnect if still alive (server restart, proxy timeout, etc.)
        if (this.alive) {
          reconnectAttempts++
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            this.emit('error', `SSE reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`)
            return
          }
          console.warn(`[opencode-sse] Stream closed cleanly, reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
          setTimeout(connectSSE, reconnectDelay)
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
        }
      }).catch((err) => {
        if (err instanceof Error && err.name === 'AbortError') return
        if (this.alive) {
          reconnectAttempts++
          if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
            this.emit('error', `SSE reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts`)
            return
          }
          console.warn(`[opencode-sse] Connection lost, reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`, err)
          setTimeout(connectSSE, reconnectDelay)
          reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
        }
      })
    }

    connectSSE()
  }

  /**
   * Check whether an SSE event belongs to this process's OpenCode session.
   * Returns true if the event should be processed, false if it should be skipped.
   * Rejects events when opencodeSessionId is not yet set (init window) to prevent
   * cross-session leakage on the shared SSE stream.
   */
  private isOwnSession(properties: Record<string, unknown>): boolean {
    const sessionID = properties.sessionID as string | undefined
    // If we don't have our session ID yet, reject everything to prevent
    // cross-session leakage during the initialization window.
    if (!this.opencodeSessionId) return false
    // If event has no session ID, accept (server-level event)
    if (!sessionID) return true
    return sessionID === this.opencodeSessionId
  }

  /** Map an OpenCode SSE event to CodingProcess events. */
  private handleSSEEvent(event: OpenCodeSSEEvent): void {
    const { type, properties } = event

    switch (type) {
      // Delta events carry the actual streaming text content
      case 'message.part.delta': {
        if (!this.isOwnSession(properties)) break
        const field = properties.field as string | undefined
        const delta = properties.delta as string | undefined
        if (field === 'text' && delta) {
          this.emit('text', delta)
        }
        break
      }

      case 'message.part.updated': {
        const part = properties.part as OpenCodeMessagePart | undefined
        if (!part) break

        // Only process events for our session
        if (!this.isOwnSession(properties)) break

        switch (part.type) {
          case 'text': {
            // Text content arrives via message.part.delta events, not here.
            break
          }

          case 'reasoning': {
            // OpenCode uses 'text' field, not 'content'. Reasoning may be
            // empty or encrypted (e.g. OpenAI models). Only emit if present.
            const content = part.text || ''
            if (content.length > 20) {
              const match = content.match(/^(.+?[.!?\n])/)
              const summary = match && match[1].length <= 120
                ? match[1].replace(/\n/g, ' ').trim()
                : content.slice(0, 80).trim()
              this.emit('thinking', summary)
            }
            break
          }

          case 'tool': {
            // Tool state is an object {status, input, output, time, ...}, not a string
            const toolName = part.tool || 'unknown'
            const status = part.state?.status
            if (status === 'running') {
              const inputStr = part.state?.input ? summarizeToolInput(toolName, part.state.input) : undefined
              this.emit('tool_active', toolName, inputStr)
              // Detect task/todo tool calls and emit todo_update
              if (part.state?.input && this.handleTaskTool(toolName, part.state.input)) {
                this.emit('todo_update', Array.from(this.tasks.values()))
              }
            } else if (status === 'completed') {
              // Also check for task tools at completion (some providers only
              // populate input at this stage, not during 'running')
              if (part.state?.input && this.handleTaskTool(toolName, part.state.input)) {
                this.emit('todo_update', Array.from(this.tasks.values()))
              }
              const output = part.state?.output
              const summary = output ? output.slice(0, 200) : undefined
              this.emit('tool_done', toolName, summary)
              if (output) {
                const truncated = output.length > 2000
                  ? output.slice(0, 2000) + `\n… (truncated, ${output.length} chars total)`
                  : output
                this.emit('tool_output', truncated, false)
              }
            } else if (status === 'error') {
              const errMsg = part.state?.error || 'unknown'
              this.emit('tool_done', toolName, `Error: ${errMsg}`)
              this.emit('tool_output', errMsg, true)
            }
            // 'pending' status — tool call parsed but not yet executing; no action needed
            break
          }

          // step-start / step-finish are agentic iteration boundaries — no mapping needed
        }
        break
      }

      case 'session.status': {
        if (!this.isOwnSession(properties)) break
        // Status may be a string ('idle') or object ({ type: 'idle' }) depending on OpenCode version
        const status = properties.status
        const statusType = typeof status === 'string' ? status : (status as { type?: string } | undefined)?.type
        if (statusType === 'idle') {
          if (this.turnComplete) break
          this.turnComplete = true
          this.emit('result', '', false)
        }
        break
      }

      case 'session.error': {
        if (!this.isOwnSession(properties)) break
        const error = properties.error as { message?: string } | undefined
        this.emit('error', error?.message || 'Unknown OpenCode error')
        break
      }

      case 'permission.asked': {
        if (!this.isOwnSession(properties)) break

        const requestId = properties.id as string | undefined
        if (!requestId) {
          console.error('[opencode] permission.asked event missing required id field')
          break
        }
        // Real format: properties.permission is the type (e.g. "external_directory"),
        // properties.metadata has details (filepath, parentDir), properties.patterns
        // has the glob patterns being requested. No direct tool name — use permission type.
        const permissionType = properties.permission as string || 'unknown'
        const metadata = properties.metadata as Record<string, unknown> || {}
        const patterns = properties.patterns as string[] || []
        const input: Record<string, unknown> = {
          permission: permissionType,
          ...metadata,
          patterns,
        }

        // Auto-approve for headless sessions (webhook/workflow)
        if (this.permissionMode === 'bypassPermissions' || this.permissionMode === 'dangerouslySkipPermissions') {
          void this.replyToPermission(requestId, 'always')
          return
        }

        // Emit as control_request for SessionManager to handle
        this.emit('control_request', requestId, permissionType, input)
        break
      }

      // message.completed signals that the model has finished its response
      case 'message.completed': {
        if (!this.isOwnSession(properties)) break
        if (this.turnComplete) break
        this.turnComplete = true
        this.emit('result', '', false)
        break
      }

      // session.updated may carry idle status in some OpenCode versions
      case 'session.updated': {
        if (!this.isOwnSession(properties)) break
        const session = properties.session as Record<string, unknown> | undefined
        const sessionStatus = session?.status
        const sType = typeof sessionStatus === 'string' ? sessionStatus : (sessionStatus as { type?: string } | undefined)?.type
        if (sType === 'idle') {
          if (this.turnComplete) break
          this.turnComplete = true
          this.emit('result', '', false)
        }
        break
      }

      default:
        // Log unhandled session-scoped events for debugging (skip noisy ones)
        if (type !== 'heartbeat' && type !== 'server.connected' && type !== 'message.part.added') {
          if (this.isOwnSession(properties)) {
            console.log(`[opencode-sse] Unhandled event: ${type}`, JSON.stringify(properties).slice(0, 200))
          }
        }
        break
    }
  }

  /** Reply to an OpenCode permission request via HTTP. */
  private async replyToPermission(requestId: string, type: 'once' | 'always' | 'reject'): Promise<void> {
    try {
      const baseUrl = `http://localhost:${serverState.port}`
      const res = await fetch(`${baseUrl}/permission/${requestId}/reply`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
          'x-opencode-directory': this.workingDir,
        },
        body: JSON.stringify({ type }),
      })
      if (!res.ok) {
        console.error(`[opencode] Permission reply failed: HTTP ${res.status} for ${requestId}`)
      }
    } catch (err) {
      console.error(`[opencode] Failed to reply to permission ${requestId}:`, err)
    }
  }

  /**
   * Detect TodoWrite/TaskCreate/TaskUpdate tool calls and emit todo_update events.
   * Mirrors the task-tracking logic in ClaudeProcess.handleTaskTool().
   */
  private handleTaskTool(toolName: string, input: Record<string, unknown>): boolean {
    // Normalize tool name — OpenCode may report as 'todowrite', 'TodoWrite', 'todo_write', etc.
    const normalized = toolName.toLowerCase().replace(/_/g, '')
    if (normalized === 'todowrite') {
      const todos = input.todos as Array<Record<string, unknown>> | undefined
      if (!Array.isArray(todos)) return false
      this.tasks.clear()
      this.taskSeq = 0
      for (const item of todos) {
        const id = String(item.id || ++this.taskSeq)
        const status = item.status as string
        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
        this.tasks.set(id, {
          id,
          subject: String(item.content || item.subject || ''),
          status,
          activeForm: item.activeForm ? String(item.activeForm) : undefined,
        })
      }
      return true
    }
    if (normalized === 'taskcreate') {
      const id = String(++this.taskSeq)
      this.tasks.set(id, {
        id,
        subject: String(input.subject || ''),
        status: 'pending',
        activeForm: input.activeForm ? String(input.activeForm) : undefined,
      })
      return true
    }
    if (normalized === 'taskupdate') {
      const id = String(input.taskId || '')
      const task = this.tasks.get(id)
      if (!task) return false
      const status = input.status as string | undefined
      if (status === 'deleted') {
        this.tasks.delete(id)
        return true
      }
      if (status === 'pending' || status === 'in_progress' || status === 'completed') {
        task.status = status
      }
      if (input.subject) task.subject = String(input.subject)
      if (input.activeForm !== undefined) task.activeForm = input.activeForm ? String(input.activeForm) : undefined
      return true
    }
    return false
  }

  /** Send a user message to the OpenCode session. */
  sendMessage(content: string): void {
    if (!this.alive || !this.opencodeSessionId) {
      this.emit('error', 'OpenCode process is not connected')
      return
    }

    this.turnComplete = false // reset completion latch for new turn

    const baseUrl = `http://localhost:${serverState.port}`
    // Build request body with optional model override
    const body: Record<string, unknown> = {
      parts: [{ type: 'text', text: content }],
    }
    // Model is stored as "providerID/modelID" — split only at first slash so
    // OpenRouter-style IDs like "openrouter/meta-llama/llama-3.1-8b" stay intact.
    if (this.model && this.model.includes('/')) {
      const slashIdx = this.model.indexOf('/')
      const providerID = this.model.slice(0, slashIdx)
      const modelID = this.model.slice(slashIdx + 1)
      body.model = { providerID, modelID }
    }
    // Use prompt_async for fire-and-forget (events come via SSE)
    void fetch(`${baseUrl}/session/${this.opencodeSessionId}/prompt_async`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        'x-opencode-directory': this.workingDir,
      },
      body: JSON.stringify(body),
    }).then((res) => {
      if (!res.ok) {
        this.emit('error', `Failed to send message: HTTP ${res.status}`)
      }
    }).catch((err) => {
      this.emit('error', `Failed to send message: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** No-op for OpenCode — raw protocol data is Claude-specific. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  sendRaw(_: string): void {
    // OpenCode uses HTTP endpoints, not raw stdin
  }

  /**
   * Respond to a permission/control request.
   * Maps Codekin's allow/deny to OpenCode's once/always/reject.
   */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny'): void {
    const type = behavior === 'deny' ? 'reject' : 'once'
    void this.replyToPermission(requestId, type)
  }

  /** Stop the OpenCode session and disconnect the SSE stream. */
  stop(): void {
    if (!this.alive) return
    this.alive = false
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }
    if (this.abortController) {
      this.abortController.abort()
      this.abortController = null
    }
    // Emit exit event to match ClaudeProcess behavior
    this.emit('exit', 0, null)
  }

  isAlive(): boolean {
    return this.alive
  }

  isReady(): boolean {
    return this.alive && this.opencodeSessionId !== null && serverState.port > 0
  }

  getSessionId(): string {
    return this.opencodeSessionId ?? this.sessionId
  }

  waitForExit(timeoutMs = 10000): Promise<void> {
    if (!this.alive) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs)
      this.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
}