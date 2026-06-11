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
import { readFileSync, existsSync, statSync } from 'fs'
import { extname } from 'path'
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
// Codekin context + permission mapping
// ---------------------------------------------------------------------------

/**
 * Codekin environment context appended to OpenCode's agent system prompt via
 * the `system` field on each prompt request. OpenCode APPENDS this to its
 * tuned per-model prompt (verified against OpenCode 1.15) — unlike
 * `agent.*.prompt` config which would REPLACE it. Mirrors the
 * `--append-system-prompt` text used for the Claude path (claude-process.ts).
 */
export const OPENCODE_SYSTEM_CONTEXT = [
  'You are running inside a web-based terminal (Codekin).',
  'Tool permissions are managed by the system through an approval UI.',
  'Do not tell the user to click approve or grant permission. Just proceed with your work.',
  'If a tool call fails, read the error message carefully. Common causes: wrong file path, missing dependency, syntax error, or network issue.',
].join(' ')

/** One rule in OpenCode's permission ruleset (last match wins, wildcards on both fields). */
interface OpenCodePermissionRule {
  permission: string
  pattern: string
  action: 'allow' | 'deny' | 'ask'
}

/**
 * Map Codekin's PermissionMode to an OpenCode permission ruleset, applied at
 * session creation (and via PATCH on resume). Without this, bypass-mode
 * sessions still hit server-side `ask` states (external_directory, doom_loop)
 * that must round-trip through the UI even though the user opted out.
 * Returns undefined for modes where OpenCode's defaults are appropriate.
 */
export function permissionRulesetFor(mode?: PermissionMode): OpenCodePermissionRule[] | undefined {
  switch (mode) {
    case 'bypassPermissions':
    case 'dangerouslySkipPermissions':
      return [{ permission: '*', pattern: '*', action: 'allow' }]
    case 'acceptEdits':
      return [{ permission: 'edit', pattern: '*', action: 'allow' }]
    default:
      // 'default' and 'plan' use OpenCode's defaults; plan-mode safety comes
      // from selecting the read-only `plan` agent on each prompt.
      return undefined
  }
}

/** An OpenCode command (slash command / skill / MCP prompt) from GET /command. */
export interface OpenCodeCommandInfo {
  name: string
  description?: string
  agent?: string
  model?: string
  source?: 'command' | 'mcp' | 'skill'
  template?: string
  hints?: string[]
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

  // Strip API keys and GIT_* vars (except GIT_EDITOR) — same filtering as
  // claude-process.ts.  GIT_INDEX_FILE=.git/index breaks worktrees where
  // .git is a file, and stale API keys override OpenCode's own auth.
  const API_KEY_VARS = new Set(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_API_KEY', 'AUTH_TOKEN', 'AUTH_TOKEN_FILE'])
  const env: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] != null &&
          !API_KEY_VARS.has(entry[0]) &&
          (!entry[0].startsWith('GIT_') || entry[0] === 'GIT_EDITOR')
      )
    ),
    OPENCODE_SERVER_PASSWORD: serverState.password,
  }

  const proc = spawn('opencode', ['serve', '--port', String(serverState.port)], {
    cwd: workingDir,
    stdio: 'ignore', // prevents buffer deadlock — pipes were never drained
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
        // One-shot version check — warns when the server is older than the
        // version this integration was built against. Non-fatal.
        void checkServerVersion(baseUrl)
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

/** Minimum OpenCode version this integration is tested against. */
export const MIN_TESTED_OPENCODE_VERSION = '1.15.0'

/** Returns true when version `a` is older than version `b` (semver-ish numeric compare). */
export function isVersionOlder(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (Number.isNaN(x) || Number.isNaN(y)) return false
    if (x !== y) return x < y
  }
  return false
}

/**
 * Query the server's version (GET /global/health) and warn when it's older
 * than the version this integration was built against. Older servers may
 * lack endpoints we rely on (summarize, abort, permission replies).
 */
async function checkServerVersion(baseUrl: string): Promise<void> {
  try {
    const res = await fetch(`${baseUrl}/global/health`, {
      headers: authHeaders(),
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return
    const data = await res.json() as { version?: string }
    if (typeof data.version !== 'string') return
    if (isVersionOlder(data.version, MIN_TESTED_OPENCODE_VERSION)) {
      console.warn(
        `[opencode-server] Server version ${data.version} is older than the tested version ${MIN_TESTED_OPENCODE_VERSION} — ` +
        'some features (compact, abort, native permissions) may not work. Consider upgrading OpenCode.'
      )
    } else {
      console.log(`[opencode-server] Version ${data.version}`)
    }
  } catch {
    // Older servers may not expose /global/health — nothing to report.
  }
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

/**
 * Fetch the list of commands (slash commands, skills, MCP prompts) from the
 * running OpenCode server. Returns an empty array if the server is not running.
 */
export async function fetchOpenCodeCommands(workingDir: string): Promise<OpenCodeCommandInfo[]> {
  try {
    const baseUrl = await ensureOpenCodeServer(workingDir)
    const res = await fetch(`${baseUrl}/command`, {
      headers: {
        ...authHeaders(),
        'x-opencode-directory': workingDir,
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) return []
    const data = await res.json() as OpenCodeCommandInfo[]
    return Array.isArray(data) ? data : []
  } catch {
    return []
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
  /**
   * Recent assistant output already shown to the user (concatenated text from
   * the session's output history). Used on resume to avoid re-emitting an
   * assistant message that was already displayed when hydrating missed history.
   */
  recentOutputText?: string
}

// ---------------------------------------------------------------------------
// OpenCodeProcess
// ---------------------------------------------------------------------------

/** How often the turn watchdog checks for a stalled turn. */
const TURN_WATCHDOG_INTERVAL_MS = 30_000
/** How long without any session SSE event before we poll the server to resync. */
const TURN_STALL_THRESHOLD_MS = 60_000

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
  /** OpenCode commands available on the server, keyed by name (for /name routing). */
  private commands = new Map<string, OpenCodeCommandInfo>()
  private tasks = new Map<string, TaskItem>()
  private turnComplete = false
  /** True while a prompt/command turn is running server-side (set on send, cleared on completion). */
  private turnInFlight = false
  /** OpenCode child sessions spawned by this session's subagents (task tool). */
  private childSessionIds = new Set<string>()
  /** Latest token/cost usage per assistant message ID (message.updated fires repeatedly). */
  private usageByMessage = new Map<string, { input: number; output: number; cost: number }>()
  /** Last emitted usage totals, serialized — suppresses duplicate usage events. */
  private lastEmittedUsage = ''
  /** Messages received while a turn was in flight — sent when the turn completes. */
  private pendingMessages: string[] = []
  /** Recent already-displayed assistant text (from output history) for resume hydration dedup. */
  private recentOutputText = ''
  private taskSeq = 0
  /**
   * Watchdog that detects turns stalled by a missed completion event.
   * The turn-completion latch (turnComplete) is only released by SSE events
   * (session.idle / message.completed / session.status). If the SSE stream
   * drops and the completion event is lost, the turn would hang forever —
   * the watchdog polls the server's message history to recover.
   */
  private turnWatchdog: ReturnType<typeof setInterval> | null = null
  /** Timestamp of the last SSE event explicitly scoped to this session. */
  private lastSessionEventTime = 0
  /** Whether we've received streaming delta events this turn (to avoid double-emitting text). */
  private receivedDeltas = false
  /** Whether we've already emitted text via message.part.updated (to avoid re-emitting from message.updated). */
  private emittedPartText = false
  /** Last user input text — used to detect and strip user echo from assistant deltas. */
  private lastUserInput = ''
  /** Buffer for initial text deltas — held until we can check for user echo prefix. */
  private deltaBuffer = ''
  /** Whether the delta buffer has been flushed (user echo check complete). */
  private deltaBufferFlushed = false
  /** Accumulated reasoning delta text for emitting thinking summaries during streaming. */
  private reasoningBuffer = ''
  /** Whether we've already emitted a thinking summary from reasoning deltas. */
  private emittedReasoningSummary = false
  /**
   * Whether text deltas currently belong to a reasoning part rather than the
   * actual response. Some providers (e.g. Kimi via OpenCode) send reasoning
   * content as `field=text` deltas, with `part.updated type=reasoning` events
   * marking the boundaries. When true, text deltas are routed to the reasoning
   * buffer instead of being emitted as visible text.
   */
  private inReasoningPhase = false

  constructor(workingDir: string, opts?: Partial<OpenCodeProcessOptions>) {
    super()
    this.workingDir = workingDir
    this.sessionId = opts?.sessionId || randomUUID()
    this.opencodeSessionId = opts?.opencodeSessionId || null
    this.model = opts?.model
    this.permissionMode = opts?.permissionMode
    this.recentOutputText = opts?.recentOutputText ?? ''
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
    const permission = permissionRulesetFor(this.permissionMode)
    if (this.opencodeSessionId) {
      // Resume existing session — reconnect to SSE, but push the current
      // permission ruleset since the mode may have changed since creation
      // (mode changes restart the process with resume).
      if (permission) {
        try {
          const patchRes = await fetch(`${baseUrl}/session/${this.opencodeSessionId}`, {
            method: 'PATCH',
            headers: {
              ...authHeaders(),
              'Content-Type': 'application/json',
              'x-opencode-directory': this.workingDir,
            },
            body: JSON.stringify({ permission }),
            signal: AbortSignal.timeout(10_000),
          })
          if (!patchRes.ok) {
            console.warn(`[opencode] Failed to update session permissions: HTTP ${patchRes.status}`)
          }
        } catch (err) {
          console.warn('[opencode] Failed to update session permissions:', err)
        }
      }
      // Hydrate any assistant response that completed while we were detached
      // (backend crash/restart mid-turn) — non-fatal on failure.
      void this.hydrateMissedTail(baseUrl)
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
          ...(permission ? { permission } : {}),
        }),
      })

      if (!createRes.ok) {
        throw new Error(`Failed to create OpenCode session: ${createRes.status} ${await createRes.text()}`)
      }

      const data = await createRes.json() as { id: string }
      this.opencodeSessionId = data.id
    }

    // Load available commands (slash commands / skills / MCP prompts) so
    // sendMessage can route `/name args` input to the command endpoint.
    // Non-fatal — command routing simply stays disabled on failure.
    void this.loadCommands(baseUrl)

    // Subscribe to SSE events AFTER opencodeSessionId is set so session
    // filtering is active from the first event received.
    this.subscribeToEvents(baseUrl)

    // Clear startup timer and emit init
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }

    // Model is stored as "providerID/modelID" — show everything after the first slash.
    // Only emit system_init when we have an explicit model. If model is undefined,
    // the frontend's model validation effect will call setModel shortly, which
    // triggers a restart with the correct model — no point showing a placeholder.
    if (this.model) {
      const modelName = this.model.includes('/') ? this.model.slice(this.model.indexOf('/') + 1) : this.model
      this.emit('system_init', modelName)
    }

    // Surface plan mode in the UI — OpenCode plan mode is implemented by
    // selecting the read-only `plan` agent on every prompt this session.
    if (this.permissionMode === 'plan') {
      this.emit('planning_mode', true)
    }
  }

  /** Fetch the command list from the server (used for slash-command routing). */
  private async loadCommands(baseUrl: string): Promise<void> {
    try {
      const res = await fetch(`${baseUrl}/command`, {
        headers: {
          ...authHeaders(),
          'x-opencode-directory': this.workingDir,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return
      const data = await res.json() as OpenCodeCommandInfo[]
      if (Array.isArray(data)) {
        this.commands = new Map(data.map(c => [c.name, c]))
      }
    } catch (err) {
      console.warn('[opencode] Failed to load command list:', err)
    }
  }

  /** Subscribe to the OpenCode SSE event stream and map events to CodingProcess events. */
  private subscribeToEvents(initialBaseUrl: string): void {
    this.abortController = new AbortController()
    let reconnectDelay = 1000
    const MAX_RECONNECT_DELAY = 30_000
    const MAX_RECONNECT_ATTEMPTS = 20

    let reconnectAttempts = 0
    let firstConnect = true

    /** Count a failed attempt and schedule a retry. Returns false when retries are exhausted. */
    const scheduleReconnect = (reason: string): boolean => {
      reconnectAttempts++
      if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
        this.emit('error', `SSE reconnect failed after ${MAX_RECONNECT_ATTEMPTS} attempts (${reason})`)
        this.stop()
        return false
      }
      console.warn(`[opencode-sse] ${reason}, reconnecting in ${reconnectDelay / 1000}s (attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})...`)
      setTimeout(() => { void connectSSE() }, reconnectDelay)
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_DELAY)
      return true
    }

    const connectSSE = async () => {
      if (!this.alive) return

      // Re-resolve the base URL on every attempt: if the shared OpenCode
      // server died, it respawns on a NEW random port — reconnecting to the
      // old URL would never succeed. ensureOpenCodeServer respawns the server
      // if needed and returns the current URL. The first connect reuses the
      // URL from initialize() to avoid a redundant health check.
      let baseUrl = initialBaseUrl
      if (!firstConnect) {
        try {
          baseUrl = await ensureOpenCodeServer(this.workingDir)
        } catch (err) {
          if (this.alive) {
            scheduleReconnect(`Server unavailable (${err instanceof Error ? err.message : String(err)})`)
          }
          return
        }
        if (!this.alive) return
      }
      firstConnect = false

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
            scheduleReconnect(`Non-2xx ${res.status}`)
          }
          return
        }

        // Reset backoff on successful connection
        reconnectDelay = 1000
        reconnectAttempts = 0

        // If a turn was in flight across the reconnect, the completion event
        // may have been lost while disconnected — resync immediately.
        if (!this.turnComplete && this.turnWatchdog) {
          void this.checkTurnLiveness(true)
        }

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
          scheduleReconnect('Stream closed cleanly')
        }
      }).catch((err: unknown) => {
        if (err instanceof Error && err.name === 'AbortError') return
        if (this.alive) {
          scheduleReconnect(`Connection lost (${err instanceof Error ? err.message : String(err)})`)
        }
      })
    }

    void connectSSE()
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

  /** Flush any buffered text deltas that haven't been emitted yet (e.g. turn ended before buffer threshold). */
  private flushDeltaBuffer(): void {
    if (!this.deltaBufferFlushed && this.deltaBuffer) {
      this.deltaBufferFlushed = true
      if (this.lastUserInput && this.deltaBuffer.startsWith(this.lastUserInput)) {
        const remainder = this.deltaBuffer.slice(this.lastUserInput.length)
        if (remainder) this.emit('text', remainder)
      } else {
        this.emit('text', this.deltaBuffer)
      }
      this.deltaBuffer = ''
    }
  }

  /**
   * Mark the current turn as complete: release the latch, flush any buffered
   * text, stop the stall watchdog, and emit the result event. Idempotent.
   */
  private completeTurn(): void {
    if (this.turnComplete) return
    this.turnComplete = true
    this.turnInFlight = false
    this.clearTurnWatchdog()
    this.flushDeltaBuffer()
    this.emit('result', '', false)
    // Send the next queued message (received mid-turn) after result handlers run.
    const next = this.pendingMessages.shift()
    if (next !== undefined && this.alive) {
      setImmediate(() => { this.sendMessage(next) })
    }
  }

  /** Map an OpenCode SSE event to CodingProcess events. */
  private handleSSEEvent(event: OpenCodeSSEEvent): void {
    const { type, properties } = event

    // Track liveness of this session's event flow for the turn watchdog.
    // Only count events explicitly scoped to our session (or a subagent child
    // session) — server-level events (heartbeats etc.) say nothing about our
    // turn's progress.
    const evtSessionID = properties.sessionID as string | undefined
    if (evtSessionID && (evtSessionID === this.opencodeSessionId || this.childSessionIds.has(evtSessionID))) {
      this.lastSessionEventTime = Date.now()
    }

    switch (type) {
      // Delta events carry the actual streaming text content
      case 'message.part.delta': {
        if (!this.isOwnSession(properties)) break
        const field = properties.field as string | undefined
        const delta = properties.delta as string | undefined
        if (process.env.CODEKIN_DEBUG_SSE) {
          console.log(`[opencode-sse] delta field=${field} len=${delta?.length ?? 0} text=${delta?.slice(0, 80)}`)
        }
        if (field === 'text' && delta) {
          this.receivedDeltas = true

          // Some providers (e.g. Kimi via OpenCode) send reasoning content as
          // field=text deltas. When inReasoningPhase is set (by a preceding
          // part.updated type=reasoning event), route to reasoning buffer.
          if (this.inReasoningPhase) {
            this.reasoningBuffer += delta
            if (this.reasoningBuffer.length > 20 && !this.emittedReasoningSummary) {
              this.emittedReasoningSummary = true
              const match = this.reasoningBuffer.match(/^(.+?[.!?\n])/)
              const summary = match && match[1].length <= 120
                ? match[1].replace(/\n/g, ' ').trim()
                : this.reasoningBuffer.slice(0, 80).trim()
              this.emit('thinking', summary)
            }
            break
          }

          // Buffer initial deltas to detect and strip user echo prefix.
          // Some providers echo the user message at the start of the assistant
          // response, which causes duplicate display.
          if (!this.deltaBufferFlushed && this.lastUserInput) {
            this.deltaBuffer += delta
            if (this.deltaBuffer.length >= this.lastUserInput.length) {
              this.deltaBufferFlushed = true
              if (this.deltaBuffer.startsWith(this.lastUserInput)) {
                const remainder = this.deltaBuffer.slice(this.lastUserInput.length)
                if (remainder) this.emit('text', remainder)
              } else {
                this.emit('text', this.deltaBuffer)
              }
              this.deltaBuffer = ''
            }
            // Still buffering — don't emit yet
          } else {
            this.emit('text', delta)
          }
        } else if (field === 'reasoning' && delta) {
          // Accumulate reasoning deltas and emit a thinking summary once we
          // have enough content, so the UI shows a thinking indicator during
          // streaming (not only when message.part.updated arrives later).
          this.reasoningBuffer += delta
          if (this.reasoningBuffer.length > 20 && !this.emittedReasoningSummary) {
            this.emittedReasoningSummary = true
            const match = this.reasoningBuffer.match(/^(.+?[.!?\n])/)
            const summary = match && match[1].length <= 120
              ? match[1].replace(/\n/g, ' ').trim()
              : this.reasoningBuffer.slice(0, 80).trim()
            this.emit('thinking', summary)
          }
        }
        break
      }

      case 'message.part.updated': {
        const part = properties.part as OpenCodeMessagePart | undefined
        if (!part) break

        // Only process events for our session. Subagent child sessions get
        // their tool activity surfaced (text/reasoning is internal to the
        // subagent and would pollute the main transcript).
        if (!this.isOwnSession(properties)) {
          if (evtSessionID && this.childSessionIds.has(evtSessionID) && part.type === 'tool') {
            this.handleChildToolPart(part)
          }
          break
        }

        if (process.env.CODEKIN_DEBUG_SSE) {
          console.log(`[opencode-sse] part.updated type=${part.type} len=${part.text?.length ?? 0} text=${part.text?.slice(0, 80)} receivedDeltas=${this.receivedDeltas} emittedPartText=${this.emittedPartText}`)
        }

        switch (part.type) {
          case 'text': {
            // A text part.updated signals that text deltas are now actual
            // response text, not reasoning. Clear the reasoning phase flag.
            if (this.inReasoningPhase) {
              this.inReasoningPhase = false
            }
            // Text may arrive via message.part.delta (streaming) or as full
            // content here (OpenCode >=1.4 message.updated). Only emit if we
            // haven't already streamed it via delta events or emitted it from
            // an earlier message.part.updated event.
            if (part.text && !this.receivedDeltas && !this.emittedPartText) {
              this.emittedPartText = true
              // Strip user echo prefix if the full text starts with the last input
              let text = part.text
              if (this.lastUserInput && text.startsWith(this.lastUserInput)) {
                text = text.slice(this.lastUserInput.length)
              }
              if (text) this.emit('text', text)
            }
            break
          }

          case 'reasoning': {
            // A reasoning part.updated signals that subsequent text deltas
            // are reasoning content, not visible text. Set the phase flag so
            // the delta handler routes them to the reasoning buffer.
            this.inReasoningPhase = true
            // OpenCode uses 'text' field, not 'content'. Reasoning may be
            // empty or encrypted (e.g. OpenAI models). Only emit if present.
            const content = part.text || ''
            if (content.length > 20 && !this.emittedReasoningSummary) {
              this.emittedReasoningSummary = true
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

          case 'step-finish': {
            // Agentic iteration boundary — any buffered text below the echo
            // threshold belongs to the finished step; flush it now instead of
            // holding it until turn end.
            this.flushDeltaBuffer()
            break
          }

          // step-start is an agentic iteration boundary — no mapping needed
        }
        break
      }

      case 'session.status': {
        if (!this.isOwnSession(properties)) break
        // Status may be a string ('idle') or object ({ type: 'idle' }) depending on OpenCode version
        const status = properties.status
        const statusType = typeof status === 'string' ? status : (status as { type?: string } | undefined)?.type
        if (statusType === 'idle') {
          this.completeTurn()
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
        this.completeTurn()
        break
      }

      // session.updated may carry idle status in some OpenCode versions.
      // session.created/session.updated also announce subagent child sessions
      // (parentID = our session) which we track to surface their tool activity.
      case 'session.created':
      case 'session.updated': {
        const session = (properties.info ?? properties.session) as Record<string, unknown> | undefined
        const sessId = session?.id as string | undefined
        const parentID = session?.parentID as string | undefined
        if (sessId && parentID && parentID === this.opencodeSessionId && !this.childSessionIds.has(sessId)) {
          this.childSessionIds.add(sessId)
          const title = typeof session?.title === 'string' && session.title ? session.title : 'subagent'
          this.emit('tool_active', 'Task', title)
        }
        if (!this.isOwnSession(properties)) break
        // Guard: a session object for a different session (e.g. a child) must
        // not complete our turn even if it reports idle.
        if (sessId && sessId !== this.opencodeSessionId) break
        const sessionStatus = session?.status
        const sType = typeof sessionStatus === 'string' ? sessionStatus : (sessionStatus as { type?: string } | undefined)?.type
        if (sType === 'idle') {
          this.completeTurn()
        }
        break
      }

      // OpenCode >=1.4 sends session.idle as a standalone event (not nested in session.status)
      case 'session.idle': {
        if (!this.isOwnSession(properties)) break
        this.completeTurn()
        break
      }

      // OpenCode >=1.4 sends message.updated with full message info including parts.
      // Extract parts and process them like message.part.updated events.
      case 'message.updated': {
        if (!this.isOwnSession(properties)) break
        const info = properties.info as {
          id?: string
          role?: string
          parts?: OpenCodeMessagePart[]
          cost?: number
          tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } }
        } | undefined
        if (!info || info.role !== 'assistant') break
        this.trackUsage(info)
        if (!info.parts) break
        if (process.env.CODEKIN_DEBUG_SSE) {
          console.log(`[opencode-sse] message.updated parts=${info.parts.length} types=${info.parts.map(p => p.type).join(',')}`)
          for (const p of info.parts) {
            console.log(`[opencode-sse]   part type=${p.type} text=${p.text?.slice(0, 120)}`)
          }
        }
        for (const part of info.parts) {
          this.handleSSEEvent({ type: 'message.part.updated', properties: { ...properties, part } })
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

  /**
   * Accumulate token/cost usage from assistant message.updated info and emit
   * cumulative session totals. message.updated fires repeatedly per message,
   * so usage is keyed by message ID (latest wins) and duplicate totals are
   * suppressed.
   */
  private trackUsage(info: { id?: string; cost?: number; tokens?: { input?: number; output?: number; reasoning?: number; cache?: { read?: number; write?: number } } }): void {
    const t = info.tokens
    if (!t || !info.id) return
    const input = (t.input ?? 0) + (t.cache?.read ?? 0) + (t.cache?.write ?? 0)
    const output = (t.output ?? 0) + (t.reasoning ?? 0)
    if (input === 0 && output === 0) return
    this.usageByMessage.set(info.id, { input, output, cost: info.cost ?? 0 })
    let inputTokens = 0
    let outputTokens = 0
    let costUsd = 0
    for (const u of this.usageByMessage.values()) {
      inputTokens += u.input
      outputTokens += u.output
      costUsd += u.cost
    }
    const key = `${inputTokens}/${outputTokens}/${costUsd}`
    if (key === this.lastEmittedUsage) return
    this.lastEmittedUsage = key
    this.emit('usage', { inputTokens, outputTokens, costUsd })
  }

  /** Surface a subagent (child session) tool part as tool activity in the main session. */
  private handleChildToolPart(part: OpenCodeMessagePart): void {
    const toolName = part.tool || 'unknown'
    const status = part.state?.status
    if (status === 'running') {
      const inputStr = part.state?.input ? summarizeToolInput(toolName, part.state.input) : undefined
      this.emit('tool_active', toolName, inputStr)
    } else if (status === 'completed') {
      const output = part.state?.output
      this.emit('tool_done', toolName, output ? output.slice(0, 200) : undefined)
    } else if (status === 'error') {
      this.emit('tool_done', toolName, `Error: ${part.state?.error || 'unknown'}`)
    }
  }

  /** Start (or restart) the stalled-turn watchdog for an in-flight turn. */
  private startTurnWatchdog(): void {
    this.clearTurnWatchdog()
    this.lastSessionEventTime = Date.now()
    this.turnWatchdog = setInterval(() => {
      void this.checkTurnLiveness()
    }, TURN_WATCHDOG_INTERVAL_MS)
  }

  private clearTurnWatchdog(): void {
    if (this.turnWatchdog) {
      clearInterval(this.turnWatchdog)
      this.turnWatchdog = null
    }
  }

  /**
   * Detect a turn stalled by a missed SSE completion event and recover.
   * If no session-scoped event has arrived recently, poll the server's
   * message history: when the last assistant message is marked completed,
   * the turn finished server-side and we only missed the event — force
   * completion so the session doesn't hang forever.
   *
   * A long-running tool with no event flow is NOT force-completed: the poll
   * only completes the turn when the server itself says the message is done.
   */
  private async checkTurnLiveness(force = false): Promise<void> {
    if (!this.alive || this.turnComplete) {
      this.clearTurnWatchdog()
      return
    }
    if (!force && Date.now() - this.lastSessionEventTime < TURN_STALL_THRESHOLD_MS) return
    if (!this.opencodeSessionId) return

    try {
      const baseUrl = `http://localhost:${serverState.port}`
      const res = await fetch(`${baseUrl}/session/${this.opencodeSessionId}/message`, {
        headers: {
          ...authHeaders(),
          'x-opencode-directory': this.workingDir,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return
      const messages = await res.json() as Array<Record<string, unknown>>
      if (!Array.isArray(messages) || messages.length === 0) return
      // Entries may be flat message objects or { info, parts } wrappers
      // depending on OpenCode version.
      const last = messages[messages.length - 1]
      const info = (last.info ?? last) as { role?: string; time?: { completed?: number } }
      if (info.role === 'assistant' && info.time?.completed) {
        console.warn(`[opencode] Missed turn-completion event for session ${this.opencodeSessionId} — recovered via message poll`)
        this.recoverMissedText(last)
        this.completeTurn()
      }
    } catch (err) {
      console.warn(`[opencode] Turn liveness poll failed for ${this.opencodeSessionId}:`, err)
    }
  }

  /**
   * When a turn completed server-side but its SSE events were lost (stream
   * drop), the assistant's response text was never emitted. Recover it from
   * the polled message-history entry so the user isn't left with a silent turn.
   */
  private recoverMissedText(entry: Record<string, unknown>): void {
    if (this.receivedDeltas || this.emittedPartText || this.deltaBuffer) return
    const parts = (entry.parts ?? (entry.info as Record<string, unknown> | undefined)?.parts) as OpenCodeMessagePart[] | undefined
    if (!Array.isArray(parts)) return
    const text = parts
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('\n')
    if (!text) return
    let out = text
    if (this.lastUserInput && out.startsWith(this.lastUserInput)) {
      out = out.slice(this.lastUserInput.length)
    }
    if (out) {
      this.emittedPartText = true
      console.warn(`[opencode] Recovered ${out.length} chars of missed assistant text for session ${this.opencodeSessionId}`)
      this.emit('text', out)
    }
  }

  /**
   * On resume, recover the tail of the conversation that may have been lost
   * while Codekin was detached (backend crash/restart mid-turn). Fetches the
   * session's message history from OpenCode and re-emits the last assistant
   * message's text — unless it was already displayed (present in the
   * persisted output history passed via recentOutputText).
   */
  private async hydrateMissedTail(baseUrl: string): Promise<void> {
    if (!this.opencodeSessionId) return
    try {
      const res = await fetch(`${baseUrl}/session/${this.opencodeSessionId}/message`, {
        headers: {
          ...authHeaders(),
          'x-opencode-directory': this.workingDir,
        },
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) return
      const messages = await res.json() as Array<Record<string, unknown>>
      if (!Array.isArray(messages) || messages.length === 0) return
      const last = messages[messages.length - 1]
      const info = (last.info ?? last) as { role?: string; time?: { completed?: number }; parts?: OpenCodeMessagePart[] }
      // Only hydrate a *completed* assistant message that is the latest entry —
      // an in-flight turn is handled by the watchdog, and a trailing user
      // message means there's nothing of ours to recover.
      if (info.role !== 'assistant' || !info.time?.completed) return
      const parts = (last.parts ?? info.parts) as OpenCodeMessagePart[] | undefined
      if (!Array.isArray(parts)) return
      const text = parts
        .filter((p) => p.type === 'text' && p.text)
        .map((p) => p.text)
        .join('\n')
      if (!text) return
      // Already shown before the restart — nothing was lost.
      if (this.recentOutputText.includes(text)) return
      console.warn(`[opencode] Hydrating ${text.length} chars of missed assistant text on resume for ${this.opencodeSessionId}`)
      this.emit('text', text)
    } catch (err) {
      console.warn(`[opencode] Resume hydration failed for ${this.opencodeSessionId}:`, err)
    }
  }

  /**
   * Reply to an OpenCode permission request via HTTP, with retries.
   * A dropped reply leaves OpenCode blocked on the permission forever, so
   * failures are retried and ultimately surfaced as a session error instead
   * of being silently swallowed.
   */
  /** Base backoff delay between permission reply retries (overridable in tests). */
  private permissionRetryDelayMs = 1000

  private async replyToPermission(requestId: string, type: 'once' | 'always' | 'reject'): Promise<void> {
    const MAX_ATTEMPTS = 3
    const baseUrl = `http://localhost:${serverState.port}`
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(`${baseUrl}/permission/${requestId}/reply`, {
          method: 'POST',
          headers: {
            ...authHeaders(),
            'Content-Type': 'application/json',
            'x-opencode-directory': this.workingDir,
          },
          body: JSON.stringify({ type }),
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) return
        console.error(`[opencode] Permission reply failed: HTTP ${res.status} for ${requestId} (attempt ${attempt}/${MAX_ATTEMPTS})`)
      } catch (err) {
        console.error(`[opencode] Failed to reply to permission ${requestId} (attempt ${attempt}/${MAX_ATTEMPTS}):`, err)
      }
      if (attempt < MAX_ATTEMPTS) {
        await new Promise(r => setTimeout(r, this.permissionRetryDelayMs * attempt))
      }
    }
    this.emit('error', `Failed to deliver permission response (${type}) — OpenCode may still be waiting for approval`)
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

    // A turn is already running server-side — queue locally and send when it
    // completes. Sending prompt_async mid-turn would reset our turn latches,
    // letting the FIRST turn's idle event instantly "complete" the second
    // turn and confuse the watchdog. (Claude's CLI queues stdin natively.)
    if (this.turnInFlight && !this.turnComplete) {
      this.pendingMessages.push(content)
      return
    }

    this.turnComplete = false // reset completion latch for new turn
    this.turnInFlight = true
    this.receivedDeltas = false
    this.emittedPartText = false
    this.deltaBuffer = ''
    this.deltaBufferFlushed = false
    this.reasoningBuffer = ''
    this.emittedReasoningSummary = false
    this.inReasoningPhase = false
    this.startTurnWatchdog()

    const baseUrl = `http://localhost:${serverState.port}`
    // Parse [Attached files: ...] prefix and convert image paths to proper parts.
    // The frontend uploads images to the screenshots dir and wraps them as:
    //   [Attached files: /path/to/img1, /path/to/img2]\nuser text
    const parts: Array<Record<string, unknown>> = []
    let textContent = content
    const attachMatch = content.match(/^\[Attached files: ([^\]]+)\]\n?/)
    if (attachMatch) {
      textContent = content.slice(attachMatch[0].length)
      const filePaths = attachMatch[1].split(',').map(p => p.trim())
      // Binary formats sent as data-URL file parts (provider handles decoding).
      const fileMimeMap: Record<string, string> = {
        '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
        '.gif': 'image/gif', '.webp': 'image/webp',
        '.pdf': 'application/pdf',
      }
      for (const filePath of filePaths) {
        if (!existsSync(filePath)) {
          console.warn(`[opencode] Attached file not found: ${filePath}`)
          continue
        }
        const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024 // 10 MB
        const fileSize = statSync(filePath).size
        if (fileSize > MAX_ATTACHMENT_BYTES) {
          console.warn(`[opencode] Attachment too large (${(fileSize / 1024 / 1024).toFixed(1)} MB, max 10 MB): ${filePath}`)
          parts.push({ type: 'text', text: `[Attachment rejected: ${filePath.split('/').pop()} is ${(fileSize / 1024 / 1024).toFixed(1)} MB, exceeding the 10 MB limit]` })
          continue
        }
        const ext = extname(filePath).toLowerCase()
        const fileMime = fileMimeMap[ext]
        const fileName = filePath.split('/').pop() || filePath
        if (fileMime) {
          const base64 = readFileSync(filePath).toString('base64')
          parts.push({ type: 'file', mime: fileMime, filename: fileName, url: `data:${fileMime};base64,${base64}` })
        } else {
          // Everything else: inline as text when the content looks like text
          // (no NUL byte in the first 8 KB) — covers source code, configs,
          // logs, etc. without maintaining an extension allowlist.
          const buf = readFileSync(filePath)
          const probe = buf.subarray(0, 8192)
          if (probe.includes(0)) {
            console.warn(`[opencode] Unsupported binary attachment: ${ext || '(no extension)'} (${filePath})`)
            parts.push({ type: 'text', text: `[Attachment skipped: ${fileName} is an unsupported binary format]` })
          } else {
            parts.push({ type: 'text', text: `--- ${fileName} ---\n${buf.toString('utf-8')}` })
          }
        }
      }
    }
    this.lastUserInput = textContent.trim()

    // /compact and /summarize map to OpenCode's native summarize endpoint,
    // which condenses the conversation server-side. The summarization runs as
    // a turn — SSE events stream in and the idle event completes the latch.
    const trimmedText = textContent.trim()
    if (!attachMatch && (trimmedText === '/compact' || trimmedText === '/summarize')) {
      const summarizeBody: Record<string, unknown> = {}
      if (this.model && this.model.includes('/')) {
        const slashIdx = this.model.indexOf('/')
        summarizeBody.providerID = this.model.slice(0, slashIdx)
        summarizeBody.modelID = this.model.slice(slashIdx + 1)
      }
      void fetch(`${baseUrl}/session/${this.opencodeSessionId}/summarize`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
          'x-opencode-directory': this.workingDir,
        },
        body: JSON.stringify(summarizeBody),
      }).then((res) => {
        if (!res.ok) {
          this.emit('error', `Failed to compact conversation: HTTP ${res.status}`)
        }
      }).catch((err) => {
        this.emit('error', `Failed to compact conversation: ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    }

    // Route known slash commands (`/name args`) to OpenCode's command
    // endpoint so its commands/skills/MCP prompts work from Codekin.
    // Only when there are no attached files — commands take text args.
    const cmdMatch = !attachMatch ? textContent.trim().match(/^\/([a-zA-Z0-9_:-]+)(?:\s+([\s\S]*))?$/) : null
    const command = cmdMatch ? this.commands.get(cmdMatch[1]) : undefined
    if (cmdMatch && command) {
      const cmdBody: Record<string, unknown> = {
        command: command.name,
        ...(cmdMatch[2] ? { arguments: cmdMatch[2] } : {}),
        ...(this.model ? { model: this.model } : {}),
        agent: this.permissionMode === 'plan' ? 'plan' : 'build',
      }
      void fetch(`${baseUrl}/session/${this.opencodeSessionId}/command`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'Content-Type': 'application/json',
          'x-opencode-directory': this.workingDir,
        },
        body: JSON.stringify(cmdBody),
      }).then((res) => {
        if (!res.ok) {
          this.emit('error', `Failed to run command /${command.name}: HTTP ${res.status}`)
        }
      }).catch((err) => {
        this.emit('error', `Failed to run command /${command.name}: ${err instanceof Error ? err.message : String(err)}`)
      })
      return
    }

    if (textContent.trim()) {
      parts.push({ type: 'text', text: textContent })
    }
    // Build request body with optional model override
    const body: Record<string, unknown> = { parts }
    // Model is stored as "providerID/modelID" — split only at first slash so
    // OpenRouter-style IDs like "openrouter/meta-llama/llama-3.1-8b" stay intact.
    if (this.model && this.model.includes('/')) {
      const slashIdx = this.model.indexOf('/')
      const providerID = this.model.slice(0, slashIdx)
      const modelID = this.model.slice(slashIdx + 1)
      body.model = { providerID, modelID }
    }
    // Select the agent per turn: plan mode uses OpenCode's read-only `plan`
    // agent (real plan mode); everything else uses the default `build` agent.
    body.agent = this.permissionMode === 'plan' ? 'plan' : 'build'
    // Append Codekin environment context to the agent's system prompt
    // (OpenCode appends `system` — it does not replace the tuned prompt).
    body.system = OPENCODE_SYSTEM_CONTEXT
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
   * Maps Codekin's allow/deny/allow_always to OpenCode's once/reject/always.
   * 'always' makes OpenCode remember the grant server-side, so the same
   * permission won't round-trip through the approval UI again this session.
   */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny' | 'allow_always'): void {
    const type = behavior === 'deny' ? 'reject' : behavior === 'allow_always' ? 'always' : 'once'
    void this.replyToPermission(requestId, type)
  }

  /**
   * Stop the OpenCode session and disconnect the SSE stream. If a turn is
   * still running server-side, abort it — otherwise OpenCode keeps generating
   * (and editing files) with nobody attached.
   */
  stop(): void {
    if (!this.alive) return
    this.alive = false
    this.pendingMessages = []
    if (this.turnInFlight && this.opencodeSessionId) {
      this.turnInFlight = false
      void fetch(`http://localhost:${serverState.port}/session/${this.opencodeSessionId}/abort`, {
        method: 'POST',
        headers: {
          ...authHeaders(),
          'x-opencode-directory': this.workingDir,
        },
        signal: AbortSignal.timeout(5000),
      }).catch((err) => {
        console.warn(`[opencode] Failed to abort in-flight turn for ${this.opencodeSessionId}:`, err)
      })
    }
    this.clearTurnWatchdog()
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