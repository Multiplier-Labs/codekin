/**
 * Manages a single Claude CLI child process using stream-json protocol.
 *
 * Spawns `claude` with --output-format stream-json --input-format stream-json,
 * parses the NDJSON stdout line by line, and emits typed events for:
 * - Streaming text deltas (batched from content_block_delta events)
 * - Tool lifecycle (active → done with input summary)
 * - Extended thinking (first-sentence summary extraction)
 * - Permission prompts and control requests
 * - Task/todo tracking (TodoWrite, TaskCreate, TaskUpdate)
 * - Turn results and process exit
 */

import { spawn, execFileSync, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { existsSync } from 'fs'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import type { ClaudeEvent, ClaudeSystemInit, ClaudeControlRequest, ClaudeResultEvent, ClaudeStreamEvent, TaskItem, PromptQuestion, PermissionMode } from './types.js'
import { SCREENSHOTS_DIR, CLAUDE_BINARY } from './config.js'
import { summarizeToolInput } from './tool-labels.js'
import { redactSecrets } from './crypto-utils.js'
import { CLAUDE_CAPABILITIES, type CodingProcess, type CodingProvider, type ProviderCapabilities } from './coding-process.js'

/** Options for constructing a ClaudeProcess. Replaces positional constructor parameters. */
export interface ClaudeProcessOptions {
  /** Absolute path to the git repo where the Claude CLI runs. */
  workingDir: string
  /** Claude session UUID. Defaults to a random UUID (new conversation). Pass an existing ID to resume. */
  sessionId?: string
  /** Additional environment variables merged into the child process env. */
  extraEnv?: Record<string, string>
  /** Claude model ID override (e.g. 'claude-opus-4-6'). Omit to use the CLI default. */
  model?: string
  /** Permission mode for the Claude CLI process. */
  permissionMode?: PermissionMode
  /** When true and sessionId is provided, use `--resume` instead of `--session-id`. */
  resume?: boolean
  /** Additional tools to pre-approve via --allowedTools. */
  allowedTools?: string[]
  /** Extra directories to grant Claude access to via --add-dir. */
  addDirs?: string[]
}

/** Accumulated state for an in-progress extended thinking block. */
interface ThinkingState {
  active: boolean
  text: string
  summaryEmitted: boolean
}

/** Accumulated state for an in-progress tool_use content block. */
interface ToolState {
  name: string | null
  input: string
}

/** Typed event map for ClaudeProcess. Each key maps to the listener argument tuple. */
export interface ClaudeProcessEvents {
  event: [ClaudeEvent]
  text: [string]
  tool_output: [content: string, isError: boolean]
  system_init: [model: string]
  thinking: [summary: string]
  tool_active: [toolName: string, toolInput: string | undefined]
  tool_done: [toolName: string, summary: string | undefined]
  prompt: [promptType: 'permission' | 'question', question: string, options: Array<{label: string; value: string; description?: string}>, multiSelect: boolean | undefined, toolName: string | undefined, toolInput: Record<string, unknown> | undefined, requestId: string | undefined, questions: PromptQuestion[] | undefined]
  control_request: [requestId: string, toolName: string, toolInput: Record<string, unknown>]
  planning_mode: [active: boolean]
  todo_update: [tasks: TaskItem[]]
  image: [base64: string, mediaType: string]
  result: [text: string, isError: boolean]
  error: [message: string]
  exit: [code: number | null, signal: string | null]
}

/** Whether to log tool I/O details (tool names, input params, result content). Disabled in production. */
const TOOL_DEBUG = process.env.NODE_ENV !== 'production'

/**
 * Wraps a Claude CLI child process. Parses stream-json NDJSON output from
 * stdout and emits structured events consumed by SessionManager.
 */
export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> implements CodingProcess {
  readonly provider: CodingProvider = 'claude'
  readonly capabilities: ProviderCapabilities = CLAUDE_CAPABILITIES

  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private sessionId: string
  private alive = false

  private killTimer: ReturnType<typeof setTimeout> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null

  /**
   * Set when stderr reports "Session ID ... is already in use". Auto-restart
   * will always fail for the same session ID, so the restart scheduler should
   * skip retries when this flag is true.
   */
  private _sessionConflict = false

  /**
   * Set to true when spawn() itself fails (ENOENT, EACCES, etc.).
   * Distinguished from "process started but produced no output" — the latter
   * implies a broken resume, while a spawn failure is transient and the
   * session's claudeSessionId should be preserved for retry.
   */
  private _spawnFailed = false

  /**
   * Set to true once the process emits at least one valid JSON event on stdout.
   * When the process exits without ever producing output, --resume likely hung
   * on a broken session — the caller should clear claudeSessionId and retry fresh.
   */
  private _receivedOutput = false


  // Grouped streaming state — reset per content block
  private thinking: ThinkingState = { active: false, text: '', summaryEmitted: false }
  private tool: ToolState = { name: null, input: '' }

  // Task/todo state: mirrors Claude's internal todo list for the UI
  private tasks = new Map<string, TaskItem>()
  private taskSeq = 0

  /** Additional env vars passed to the child process (session ID, port, token). */
  private extraEnv: Record<string, string>

  /** When true, use `--resume` instead of `--session-id` to resume an existing session. */
  private resume: boolean

  private workingDir: string
  private model?: string
  private permissionMode?: PermissionMode
  private allowedTools?: string[]
  private addDirs?: string[]

  constructor(workingDir: string, opts?: Partial<ClaudeProcessOptions>) {
    super()
    this.workingDir = workingDir
    const o = opts ?? {}
    this.sessionId = o.sessionId || randomUUID()
    this.extraEnv = o.extraEnv || {}
    this.model = o.model
    this.permissionMode = o.permissionMode
    this.resume = !!(o.resume && o.sessionId)
    this.allowedTools = o.allowedTools
    this.addDirs = o.addDirs
  }

  /** Spawn the Claude CLI process with stream-json I/O and acceptEdits mode. */
  start(): void {
    if (this.proc) return

    // Safety net: verify the working directory exists before spawning.
    // spawn() with a nonexistent cwd emits an ENOENT error event and exits
    // immediately, which wastes a restart attempt. Fail fast with a clear message.
    if (!existsSync(this.workingDir)) {
      this._spawnFailed = true
      this.emit('error', `Working directory does not exist: ${this.workingDir}`)
      // Emit exit asynchronously so the caller can wire up listeners first
      process.nextTick(() => this.emit('exit', 1, null))
      return
    }

    // Pass through the full parent environment so the Claude CLI inherits
    // XDG paths, TERM, SHELL, and any other vars it needs.
    // Exclude ANTHROPIC_API_KEY / CLAUDE_CODE_API_KEY from inheritance —
    // stale or incorrect keys override the CLI's subscription/OAuth auth
    // and cause "Invalid API key" errors. Let the CLI use its own auth.
    // Also strip GIT_* vars (except GIT_EDITOR) that the server may have
    // inherited from the shell that launched it. In particular,
    // GIT_INDEX_FILE=.git/index breaks worktrees where .git is a file,
    // not a directory, causing all index-dependent git commands to fail.
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
      ...this.extraEnv,
    }

    // Suppress Node.js deprecation warnings in child tools
    env.NODE_NO_WARNINGS = '1'

    const skipPermissions = this.permissionMode === 'dangerouslySkipPermissions'
    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      ...(skipPermissions
        ? ['--dangerously-skip-permissions']
        : ['--permission-mode', this.permissionMode || 'acceptEdits']),
      '--allowedTools', ['Bash(git:*)', ...(this.allowedTools || [])].join(','),
      '--add-dir', SCREENSHOTS_DIR,
      ...(this.addDirs || []).flatMap(d => ['--add-dir', d]),
      '--include-partial-messages',
      '--verbose',
      ...(this.resume ? ['--resume', this.sessionId] : ['--session-id', this.sessionId]),
      ...(this.model ? ['--model', this.model] : []),
      '--append-system-prompt', [
        'You are running inside a web-based terminal (Codekin).',
        'Tool permissions are managed by the system through an approval hook.',
        'File operations (Read, Write, Edit, Glob, Grep) are pre-approved and work without prompts.',
        'Bash commands may require user approval — the system handles this automatically via a UI prompt.',
        'Do not tell the user to click approve or grant permission. Just proceed with your work.',
        'If a tool call fails, read the error message carefully. Common causes: wrong file path, missing dependency, syntax error, or network issue.',
      ].join(' '),
    ]
    // Kill any orphaned Claude process still holding this session ID's lock.
    // This can happen when the server restarts and old children survive (SIGKILL'd
    // or reparented to init), or when startClaude() replaces a running process
    // without waiting for the old one to exit.  Without this, --resume fails
    // with "already in use".
    // Match both --resume and --session-id because the orphan may have been
    // started with either flag depending on whether it was a first start or
    // a resume.  Uses the full binary path + exact session UUID to avoid
    // matching unrelated processes.
    if (this.resume) {
      try {
        const pattern = `${CLAUDE_BINARY} .*(--resume|--session-id) ${this.sessionId}(\\s|$)`
        execFileSync('pkill', ['-f', pattern], { timeout: 2000, stdio: 'ignore' })
      } catch {
        // pkill exits 1 when no matching process is found — that's the happy path
      }
    }

    console.log(`[claude-spawn] cwd=${this.workingDir} args=${JSON.stringify(args)}`)
    this.proc = spawn(CLAUDE_BINARY, args, {
      cwd: this.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    this.alive = true

    // Startup timeout: kill the process if no stdout output is received within 60s.
    // Cleared as soon as any valid JSON line arrives (see handleLine).
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.alive) {
        this.emit('error', 'Claude process produced no output within 60 seconds')
        this.stop()
      }
    }, 60_000)

    this.rl = createInterface({ input: this.proc.stdout! })
    this.rl.on('line', (line) => this.handleLine(line))

    this.proc.stderr!.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      console.error('[claude stderr]', text)
      if (text) {
        if (/Session ID \S+ is already in use/.test(text)) {
          this._sessionConflict = true
        }
        this.emit('error', `[stderr] ${text.slice(0, 500)}`)
      }
    })

    this.proc.on('error', (err) => {
      const errno = (err as NodeJS.ErrnoException).code
      console.error(`[claude process error] session=${this.sessionId} cwd=${this.workingDir} errno=${errno} ${err.message}`)
      if (errno === 'ENOENT' || errno === 'EACCES') {
        this._spawnFailed = true
      }
      this.emit('error', err.message)
    })

    this.proc.on('close', (code, signal) => {
      this.alive = false
      if (this.startupTimer) {
        clearTimeout(this.startupTimer)
        this.startupTimer = null
      }
      if (this.killTimer) {
        clearTimeout(this.killTimer)
        this.killTimer = null
      }
      this.rl?.close()
      this.rl = null
      this.proc = null
      this.tasks.clear()
      this.emit('exit', code, signal)
    })
  }

  /** Parse a single NDJSON line from Claude's stdout and dispatch to the appropriate handler. */
  private handleLine(line: string): void {
    let event: ClaudeEvent
    try {
      event = JSON.parse(line)
    } catch {
      console.warn(`[claude stdout] unparseable line: ${line.slice(0, 200)}`)
      return
    }

    // Any valid JSON from stdout proves the process is alive and communicating.
    // Cancel the startup timer regardless of event type — system_init may arrive
    // after other events (e.g. rate_limit_event) and the old timer would kill a
    // perfectly healthy process that just hasn't sent init yet.
    this._receivedOutput = true
    if (this.startupTimer) {
      clearTimeout(this.startupTimer)
      this.startupTimer = null
    }

    this.emit('event', event)

    // Log non-streaming event types for diagnostics
    if (event.type !== 'stream_event') {
      const subtype = 'subtype' in event ? String((event as Record<string, unknown>).subtype) : '-'
      console.log(`[event] type=${event.type} subtype=${subtype || '-'}`)
    }
    // Log all event types we DON'T handle to catch unknown protocol messages
    if (!['system', 'stream_event', 'assistant', 'user', 'result', 'control_request'].includes(event.type)) {
      console.log(`[event-unhandled] type=${event.type} data=${JSON.stringify(event).slice(0, 300)}`)
    }

    switch (event.type) {
      case 'system':
        if (event.subtype === 'init') {
          this.sessionId = (event as ClaudeSystemInit).session_id || this.sessionId
          const model = ('model' in event ? (event as Record<string, unknown>).model : 'unknown') as string
          this.emit('system_init', model)
        }
        break

      case 'stream_event':
        this.handleStreamEvent(event as ClaudeStreamEvent)
        break

      case 'assistant':
        this.handleAssistantMessage()
        break

      case 'user':
        this.handleUserEvent(event)
        break

      case 'result': {
        const resultEvent = event as ClaudeResultEvent
        this.emit('result', resultEvent.result || '', resultEvent.is_error || false)
        break
      }

      case 'control_request': {
        const ctrlEvent = event as ClaudeControlRequest
        if (TOOL_DEBUG) console.log(`[control_request] requestId=${ctrlEvent.request_id} tool=${ctrlEvent.request?.tool_name}`)
        this.handleControlRequest(ctrlEvent)
        break
      }

    }
  }

  /**
   * Process incremental stream events (content_block_start/delta/stop).
   * Handles text deltas, tool input accumulation, thinking blocks, and
   * planning mode detection.
   */
  private handleStreamEvent(event: ClaudeStreamEvent): void {
    const inner = event.event
    if (!inner) return

    switch (inner.type) {
      case 'content_block_start':
        if (inner.content_block?.type === 'tool_use') {
          this.tool = { name: inner.content_block.name || null, input: '' }
          if (TOOL_DEBUG) console.log('[tool-debug] tool_start:', this.tool.name)
          // Detect planning mode tools — emit immediately, PlanManager handles gating
          if (this.tool.name === 'EnterPlanMode') {
            this.emit('planning_mode', true)
          } else if (this.tool.name === 'ExitPlanMode') {
            this.emit('planning_mode', false)
          } else {
            this.emit('tool_active', this.tool.name!, undefined)
          }
        } else if (inner.content_block?.type === 'thinking') {
          this.thinking = { active: true, text: '', summaryEmitted: false }
        }
        break

      case 'content_block_delta':
        if (inner.delta?.type === 'text_delta' && inner.delta.text) {
          this.emit('text', inner.delta.text)
        } else if (inner.delta?.type === 'input_json_delta' && inner.delta.partial_json) {
          this.tool.input += inner.delta.partial_json
        } else if (inner.delta?.type === 'thinking_delta' && (inner.delta as Record<string, unknown>).thinking && this.thinking.active) {
          this.thinking.text += (inner.delta as Record<string, unknown>).thinking as string
          if (!this.thinking.summaryEmitted) {
            const summary = this.extractThinkingSummary(this.thinking.text)
            if (summary) {
              this.thinking.summaryEmitted = true
              this.emit('thinking', summary)
            }
          }
        }
        break

      case 'content_block_stop':
        if (this.thinking.active) {
          this.handleThinkingBlockStop()
        } else if (this.tool.name) {
          this.handleToolBlockStop()
        }
        break
    }
  }

  /** Finalize a thinking block: emit summary if not already emitted, then reset state. */
  private handleThinkingBlockStop(): void {
    if (!this.thinking.summaryEmitted && this.thinking.text.length > 0) {
      const summary = this.extractThinkingSummary(this.thinking.text) || this.thinking.text.slice(0, 80).trim()
      this.emit('thinking', summary)
    }
    this.thinking = { active: false, text: '', summaryEmitted: false }
  }

  /** Finalize a tool block: parse input, handle task tools, emit tool_done, then reset state. */
  private handleToolBlockStop(): void {
    let summary: string | undefined
    try {
      const parsed = JSON.parse(this.tool.input)
      summary = summarizeToolInput(this.tool.name!, parsed) || undefined
      const isTask = this.tool.name === 'TaskCreate' || this.tool.name === 'TaskUpdate' || this.tool.name === 'TodoWrite' || this.tool.name === 'TodoRead'
      if (isTask && TOOL_DEBUG) console.log('[task-debug] tool:', this.tool.name, 'input:', JSON.stringify(parsed).slice(0, 200))
      if (this.handleTaskTool(this.tool.name!, parsed)) {
        if (TOOL_DEBUG) console.log('[task-debug] emitting todo_update, tasks:', this.tasks.size)
        this.emit('todo_update', Array.from(this.tasks.values()))
      }
    } catch (err) {
      console.warn(`[claude] Failed to parse tool input for ${this.tool.name}:`, err instanceof Error ? err.message : err)
    }
    this.emit('tool_done', this.tool.name!, summary)
    this.tool = { name: null, input: '' }
  }

  /**
   * No-op: assistant messages are handled via stream_event deltas instead.
   * Kept as an explicit method (rather than an empty `break`) so the switch
   * case self-documents that this message type is intentionally consumed.
   * Note: assistant events with --include-partial-messages contain tool_use blocks,
   * but tool_results come in separate 'user' events — see handleUserEvent.
   */
  private handleAssistantMessage(): void {}

  /** Extract tool_result blocks from 'user' events and emit as tool_output. */
  private handleUserEvent(event: ClaudeEvent): void {
    const msg = (event as unknown as { message?: { content?: unknown[] } }).message
    if (!msg?.content) return

    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const block of blocks as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type === 'tool_result') {
        const isError = block.is_error === true

        // When content is an array of content blocks, extract images and stringify the rest
        const contentBlocks = Array.isArray(block.content) ? block.content : null
        let content: string
        if (contentBlocks) {
          const textParts: string[] = []
          for (const cb of contentBlocks as Array<{ type: string; text?: string; source?: { type: string; data: string; media_type: string } }>) {
            if (cb.type === 'image' && cb.source?.type === 'base64') {
              if (TOOL_DEBUG) console.log(`[tool-result] id=${block.tool_use_id} image media_type=${cb.source.media_type} data_len=${cb.source.data.length}`)
              this.emit('image', cb.source.data, cb.source.media_type)
            } else {
              textParts.push(typeof cb.text === 'string' ? cb.text : JSON.stringify(cb))
            }
          }
          content = textParts.join('\n')
        } else {
          content = typeof block.content === 'string' ? block.content : ''
        }
        if (content) {
          if (TOOL_DEBUG) console.log(`[tool-result] id=${block.tool_use_id} error=${isError} content=${content.slice(0, 300)}`)
        }

        // Emit non-empty text tool results as dedicated tool_output events
        if (content.trim()) {
          const truncated = content.length > 2000
            ? content.slice(0, 2000) + `\n… (truncated, ${content.length} chars total)`
            : content
          this.emit('tool_output', truncated, isError)
        }
      }
    }
  }

  /**
   * Tools that are safe to auto-approve without user interaction.
   * These are file operations and planning tools that acceptEdits mode already allows,
   * plus harmless internal tools. Everything else is forwarded to the session manager
   * for UI-based approval (or auto-approval registry check).
   */
  private static readonly AUTO_APPROVE_TOOLS = new Set([
    'Read', 'Write', 'Edit', 'Glob', 'Grep', 'NotebookEdit',
    'EnterPlanMode', 'TodoWrite', 'TodoRead', 'Task', 'TaskCreate', 'TaskUpdate',
  ])

  /**
   * Handle a control_request from the CLI.
   * With acceptEdits mode + PermissionRequest hook, most permissions go through hooks.
   * This handler remains as fallback and for AskUserQuestion (which uses control_request
   * for user interaction, not permissions).
   */
  private handleControlRequest(event: ClaudeControlRequest): void {
    const { request_id, request } = event
    const toolName = request.tool_name
    const toolInput = request.input

    if (toolName === 'AskUserQuestion') {
      // Parse questions from input and emit as a single prompt with all questions bundled.
      // Each question has its own options and multiSelect flag; the frontend
      // walks the user through them one-by-one and returns all answers at once.
      const questions = toolInput?.questions as Array<{ question: string; options?: Array<{ label: string; description?: string }>; multiSelect?: boolean; header?: string }> | undefined
      if (!Array.isArray(questions) || questions.length === 0) {
        console.warn(`[control_request] AskUserQuestion with no/empty questions array, forwarding as generic control_request`)
        this.emit('control_request', request_id, toolName, toolInput)
        return
      }

      if (TOOL_DEBUG) console.log(`[control_request] AskUserQuestion received with ${questions.length} question(s), requestId=${request_id}`)
      const structuredQuestions = questions.map(q => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: (q.options || []).map((opt: { label: string; value?: string; description?: string }) => ({
          label: opt.label,
          value: opt.value ?? opt.label,
          description: opt.description,
        })),
      }))

      // Emit a single prompt with the first question's options for display,
      // plus the full questions array for the multi-question flow
      const first = structuredQuestions[0]
      this.emit('prompt', 'question', first.question, first.options, first.multiSelect, undefined, toolInput, request_id, structuredQuestions)
    } else if (ClaudeProcess.AUTO_APPROVE_TOOLS.has(toolName)) {
      // Known-safe tools: auto-approve without prompting
      if (TOOL_DEBUG) console.log(`[control_request] auto-approving safe tool: ${toolName}`)
      this.sendControlResponse(request_id, 'allow')
    } else {
      // All other tools (Bash, WebSearch, WebFetch, Agent, etc.)
      // Forward to session manager for registry check / UI prompt
      const logDetail = toolName === 'Bash'
        ? `: ${redactSecrets(String(toolInput.command || '').slice(0, 80))}`
        : ''
      if (TOOL_DEBUG) console.log(`[control_request] forwarding ${toolName} to session manager for approval${logDetail}`)
      this.emit('control_request', request_id, toolName, toolInput)
    }
  }

  /** Send a control_response back to the CLI to allow or deny a pending request. */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, message?: string): void {
    // The CLI expects a nested format: { type, response: { subtype, request_id, response: { behavior, ... } } }
    // Inner response schema:
    //   allow: { behavior: "allow", updatedInput: Record<string, unknown> }  (updatedInput required)
    //   deny:  { behavior: "deny", message: string }                        (message required)
    const response = behavior === 'deny'
      ? {
        type: 'control_response' as const,
        response: {
          subtype: 'error' as const,
          request_id: requestId,
          error: message || 'User denied permission',
        },
      }
      : {
        type: 'control_response' as const,
        response: {
          subtype: 'success' as const,
          request_id: requestId,
          response: {
            behavior: 'allow' as const,
            updatedInput: updatedInput ?? {},
          },
        },
      }
    this.sendRaw(JSON.stringify(response))
  }

  /**
   * Update internal task state from TodoWrite/TaskCreate/TaskUpdate tool calls.
   * Returns true if the task list changed (caller should emit todo_update).
   */
  private handleTaskTool(toolName: string, input: Record<string, unknown>): boolean {
    // TodoWrite sends the entire list at once
    if (toolName === 'TodoWrite') {
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
    // TaskCreate/TaskUpdate are the newer tool names
    if (toolName === 'TaskCreate') {
      const id = String(++this.taskSeq)
      this.tasks.set(id, {
        id,
        subject: String(input.subject || ''),
        status: 'pending',
        activeForm: input.activeForm ? String(input.activeForm) : undefined,
      })
      return true
    }
    if (toolName === 'TaskUpdate') {
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

  /**
   * Extract a short summary from extended thinking text.
   * Tries to grab the first sentence (up to 120 chars), or truncates at a
   * word boundary if no sentence ending is found after 60+ chars.
   */
  private extractThinkingSummary(text: string): string | null {
    if (text.length < 20) return null

    // Try to extract the first sentence (up to ~100 chars)
    const match = text.match(/^(.+?[.!?\n])/)
    if (match && match[1].length <= 120) {
      return match[1].replace(/\n/g, ' ').trim()
    }

    // If no sentence boundary yet but we have enough text, truncate to word boundary
    if (text.length >= 60) {
      const truncated = text.slice(0, 80)
      const lastSpace = truncated.lastIndexOf(' ')
      return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated).trim()
    }

    return null
  }

  /** Send a user message to the Claude CLI via stdin (stream-json format). */
  sendMessage(content: string): void {
    if (!this.proc?.stdin?.writable) {
      this.emit('error', 'Claude process stdin is not writable')
      return
    }

    const msg = JSON.stringify({
      type: 'user',
      message: {
        role: 'user',
        content,
      },
    })
    const ok = this.proc.stdin.write(msg + '\n')
    if (!ok) {
      this.proc.stdin.once('drain', () => { /* ready for more */ })
    }
  }

  /** Write raw data to stdin (used for control_response messages). */
  sendRaw(data: string): void {
    if (!this.proc?.stdin?.writable) return
    const ok = this.proc.stdin.write(data + '\n')
    if (!ok) {
      this.proc.stdin.once('drain', () => { /* ready for more */ })
    }
  }

  /** Gracefully stop the process (SIGTERM, then SIGKILL after 5s timeout). */
  stop(): void {
    // Clear any existing SIGKILL timer to prevent double-kill on restart
    if (this.killTimer) {
      clearTimeout(this.killTimer)
      this.killTimer = null
    }
    if (this.proc) {
      this.proc.kill('SIGTERM')
      // Force kill after 5 seconds
      this.killTimer = setTimeout(() => {
        this.killTimer = null
        if (this.proc) {
          this.proc.kill('SIGKILL')
        }
      }, 5000)
    }
  }

  /** Returns a promise that resolves when the process exits. Resolves immediately if already dead. */
  waitForExit(timeoutMs = 10000): Promise<void> {
    if (!this.alive) return Promise.resolve()
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve()
      }, timeoutMs)
      // Listen on the underlying ChildProcess 'close' event (survives removeAllListeners on the EventEmitter)
      const onClose = () => {
        clearTimeout(timer)
        resolve()
      }
      if (this.proc) {
        this.proc.once('close', onClose)
      } else {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  isAlive(): boolean {
    return this.alive
  }

  isReady(): boolean {
    // Claude CLI waits for the first input before emitting system_init.
    // We must return true as soon as it's alive to prevent deadlocks in sendInput.
    return this.alive
  }

  getSessionId(): string {
    return this.sessionId
  }

  /** True if the process exited because the session ID was locked by another process. */
  hasSessionConflict(): boolean {
    return this._sessionConflict
  }

  /** True if the process produced at least one valid JSON event before exiting. */
  hadOutput(): boolean {
    return this._receivedOutput
  }

  /** True if spawn() itself failed (ENOENT, EACCES) — process never started. */
  hasSpawnFailed(): boolean {
    return this._spawnFailed
  }

}
