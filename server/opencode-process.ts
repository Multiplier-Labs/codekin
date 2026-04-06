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

// ---------------------------------------------------------------------------
// OpenCode SSE event types (subset — only what we need to map)
// ---------------------------------------------------------------------------

/** A part within an OpenCode message (text, reasoning, tool, step markers). */
interface OpenCodeMessagePart {
  type: 'text' | 'reasoning' | 'tool' | 'step-start' | 'step-finish'
  content?: string
  state?: 'pending' | 'running' | 'completed' | 'error'
  tool?: string
  input?: Record<string, unknown>
  output?: string
  error?: string
  time?: { start?: number; end?: number }
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
  private extraEnv: Record<string, string>
  private alive = false
  private abortController: AbortController | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private permissionMode?: PermissionMode

  // Track accumulated text for tool parts (to detect completion)
  private lastTextContent = ''

  constructor(workingDir: string, opts?: Partial<OpenCodeProcessOptions>) {
    super()
    this.workingDir = workingDir
    this.sessionId = opts?.sessionId || randomUUID()
    this.opencodeSessionId = opts?.opencodeSessionId || null
    this.model = opts?.model
    this.extraEnv = opts?.extraEnv || {}
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

    const modelName = this.model || 'opencode (default)'
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
          this.emit('error', `SSE connection failed: ${res.status}`)
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
    // If we don't have our session ID yet, reject all session-scoped events
    if (!this.opencodeSessionId) return !sessionID
    // If event has no session ID, accept (server-level event)
    if (!sessionID) return true
    return sessionID === this.opencodeSessionId
  }

  /** Map an OpenCode SSE event to CodingProcess events. */
  private handleSSEEvent(event: OpenCodeSSEEvent): void {
    const { type, properties } = event

    switch (type) {
      case 'message.part.updated': {
        const part = properties.part as OpenCodeMessagePart | undefined
        if (!part) break

        // Only process events for our session
        if (!this.isOwnSession(properties)) break

        switch (part.type) {
          case 'text': {
            const content = part.content || ''
            // Reset accumulator when a new text block starts (time.start
            // unambiguously marks a new block). This handles multi-turn
            // sessions where the previous turn's time.end may have been
            // missed (e.g. SSE reconnect).
            if (part.time?.start) {
              this.lastTextContent = ''
            }
            // Emit only the new delta (OpenCode sends accumulated content)
            if (content.length > this.lastTextContent.length) {
              const delta = content.slice(this.lastTextContent.length)
              this.lastTextContent = content
              this.emit('text', delta)
            }
            // If time.end is set, the text block is complete — reset accumulator
            if (part.time?.end) {
              this.lastTextContent = ''
            }
            break
          }

          case 'reasoning': {
            const content = part.content || ''
            if (content.length > 20) {
              // Extract first sentence as summary
              const match = content.match(/^(.+?[.!?\n])/)
              const summary = match && match[1].length <= 120
                ? match[1].replace(/\n/g, ' ').trim()
                : content.slice(0, 80).trim()
              this.emit('thinking', summary)
            }
            break
          }

          case 'tool': {
            const toolName = part.tool || 'unknown'
            if (part.state === 'running') {
              const inputStr = part.input ? this.summarizeToolInput(toolName, part.input) : undefined
              this.emit('tool_active', toolName, inputStr)
            } else if (part.state === 'completed') {
              const summary = part.output ? part.output.slice(0, 200) : undefined
              this.emit('tool_done', toolName, summary)
              // Emit tool output if present
              if (part.output) {
                const truncated = part.output.length > 2000
                  ? part.output.slice(0, 2000) + `\n… (truncated, ${part.output.length} chars total)`
                  : part.output
                this.emit('tool_output', truncated, false)
              }
            } else if (part.state === 'error') {
              this.emit('tool_done', toolName, `Error: ${part.error || 'unknown'}`)
              if (part.error) {
                this.emit('tool_output', part.error, true)
              }
            }
            break
          }

          // step-start / step-finish are agentic iteration boundaries — no mapping needed
        }
        break
      }

      case 'session.status': {
        if (!this.isOwnSession(properties)) break
        const status = properties.status as { type: string } | undefined
        if (status?.type === 'idle') {
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

        const requestId = properties.id as string || randomUUID()
        const toolName = properties.name as string || 'unknown'
        const input = properties.input as Record<string, unknown> || {}

        // Auto-approve for headless sessions (webhook/workflow)
        if (this.permissionMode === 'bypassPermissions' || this.permissionMode === 'dangerouslySkipPermissions') {
          void this.replyToPermission(requestId, 'once')
          return
        }

        // Emit as control_request for SessionManager to handle
        this.emit('control_request', requestId, toolName, input)
        break
      }

      // Ignore heartbeat, server.connected, and other internal events
    }
  }

  /** Reply to an OpenCode permission request via HTTP. */
  private async replyToPermission(requestId: string, type: 'once' | 'always' | 'reject'): Promise<void> {
    try {
      const baseUrl = `http://localhost:${serverState.port}`
      await fetch(`${baseUrl}/permission/${requestId}/reply`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ type }),
      })
    } catch (err) {
      console.error(`[opencode] Failed to reply to permission ${requestId}:`, err)
    }
  }

  /** Generate a short summary for tool input (mirrors ClaudeProcess.summarizeToolInput). */
  private summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'bash': return `$ ${String(input.command || '').split('\n')[0]}`
      case 'read':
      case 'view': return String(input.file_path || input.filePath || '')
      case 'write':
      case 'edit':
      case 'multiedit': return String(input.file_path || input.filePath || '')
      case 'glob': return String(input.pattern || '')
      case 'grep': return String(input.pattern || '')
      case 'task': return String(input.description || '')
      default: return ''
    }
  }

  /** Send a user message to the OpenCode session. */
  sendMessage(content: string): void {
    if (!this.alive || !this.opencodeSessionId) {
      this.emit('error', 'OpenCode process is not connected')
      return
    }

    const baseUrl = `http://localhost:${serverState.port}`
    // Use prompt_async for fire-and-forget (events come via SSE)
    void fetch(`${baseUrl}/session/${this.opencodeSessionId}/prompt_async`, {
      method: 'POST',
      headers: {
        ...authHeaders(),
        'Content-Type': 'application/json',
        'x-opencode-directory': this.workingDir,
      },
      body: JSON.stringify({
        parts: [{ type: 'text', text: content }],
      }),
    }).catch((err) => {
      this.emit('error', `Failed to send message: ${err instanceof Error ? err.message : String(err)}`)
    })
  }

  /** No-op for OpenCode — raw protocol data is Claude-specific. */
  sendRaw(_data: string): void {
    // OpenCode uses HTTP endpoints, not raw stdin
  }

  /**
   * Respond to a permission/control request.
   * Maps Codekin's allow/deny to OpenCode's once/always/reject.
   */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', _updatedInput?: Record<string, unknown>, _message?: string): void {
    const type = behavior === 'deny' ? 'reject' : 'once'
    void this.replyToPermission(requestId, type)
  }

  /** Stop the OpenCode session (disconnect SSE, optionally delete session). */
  stop(): void {
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
