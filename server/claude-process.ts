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

import { spawn, type ChildProcess } from 'child_process'
import { createInterface, type Interface } from 'readline'
import { EventEmitter } from 'events'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import type { ClaudeEvent, ClaudeSystemInit, ClaudeControlRequest, ClaudeResultEvent, ClaudeStreamEvent, TaskItem, PromptQuestion } from './types.js'
import { SCREENSHOTS_DIR } from './config.js'
import { redactSecrets } from './crypto-utils.js'

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
  result: [text: string, isError: boolean]
  error: [message: string]
  exit: [code: number | null, signal: string | null]
}

/**
 * Wraps a Claude CLI child process. Parses stream-json NDJSON output from
 * stdout and emits structured events consumed by SessionManager.
 */
export class ClaudeProcess extends EventEmitter<ClaudeProcessEvents> {
  private proc: ChildProcess | null = null
  private rl: Interface | null = null
  private sessionId: string
  private alive = false

  // Tool tracking: accumulates partial_json input during streaming
  private currentToolName: string | null = null
  private currentToolInput = ''
  private textBuffer = ''

  // Extended thinking: extract a short summary from the thinking block
  private inThinkingBlock = false
  private thinkingText = ''
  private thinkingSummaryEmitted = false

  // Deferred ExitPlanMode: only emit planning_mode false after tool_result confirms success.
  // Stores the tool_use_id from content_block_start so we can match it in the tool_result.
  private pendingExitPlanModeId: string | null = null

  // Task/todo state: mirrors Claude's internal todo list for the UI
  private tasks = new Map<string, TaskItem>()
  private taskSeq = 0

  /** Additional env vars passed to the child process (session ID, port, token). */
  private extraEnv: Record<string, string>

  constructor(private workingDir: string, sessionId?: string, extraEnv?: Record<string, string>, private model?: string) {
    super()
    this.sessionId = sessionId || randomUUID()
    this.extraEnv = extraEnv || {}
  }

  /** Spawn the Claude CLI process with stream-json I/O and acceptEdits mode. */
  start(): void {
    if (this.proc) return

    const env: Record<string, string> = {
      PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin',
      HOME: process.env.HOME || homedir(),
      USER: process.env.USER || 'dev',
      LANG: process.env.LANG || 'en_US.UTF-8',
      ...this.extraEnv,
    }

    // Pass through third-party API keys for skills (validate-gemini, validate-gpt).
    // Do NOT pass ANTHROPIC_API_KEY / CLAUDE_CODE_API_KEY — let the CLI use the
    // user's authenticated Max plan instead of billing via API.
    for (const key of ['GEMINI_API_KEY', 'OPENAI_API_KEY', 'OPENAI_MODEL', 'GEMINI_MODEL']) {
      if (process.env[key]) env[key] = process.env[key]
    }

    // Suppress Node.js deprecation warnings in child tools
    env.NODE_NO_WARNINGS = '1'

    const args = [
      '--output-format', 'stream-json',
      '--input-format', 'stream-json',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash(git:*)',
      '--add-dir', SCREENSHOTS_DIR,
      '--include-partial-messages',
      '--verbose',
      '--session-id', this.sessionId,
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
    console.log(`[claude-spawn] cwd=${this.workingDir} args=${JSON.stringify(args)}`)
    this.proc = spawn('claude', args, {
      cwd: this.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    })

    this.alive = true

    this.rl = createInterface({ input: this.proc.stdout! })
    this.rl.on('line', (line) => this.handleLine(line))

    this.proc.stderr!.on('data', (data: Buffer) => {
      const text = data.toString().trim()
      console.error('[claude stderr]', text)
      if (text) this.emit('error', `[stderr] ${text.slice(0, 500)}`)
    })

    this.proc.on('error', (err) => {
      console.error('[claude process error]', err.message)
      this.emit('error', err.message)
    })

    this.proc.on('close', (code, signal) => {
      this.alive = false
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

    this.emit('event', event)

    // Log non-streaming event types for diagnostics
    if (event.type !== 'stream_event') {
      const subtype = 'subtype' in event ? (event as Record<string, unknown>).subtype : '-'
      console.log(`[event] type=${event.type} subtype=${subtype || '-'}`)
    }
    // Log all event types we DON'T handle to catch unknown protocol messages
    if (!['system', 'stream_event', 'assistant', 'user', 'result', 'control_request', 'rate_limit_event'].includes(event.type)) {
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
        // The result message signals end of turn, ready for next input
        break
      }

      case 'control_request': {
        const ctrlEvent = event as ClaudeControlRequest
        console.log(`[control_request] requestId=${ctrlEvent.request_id} tool=${ctrlEvent.request?.tool_name}`)
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
          this.currentToolName = inner.content_block.name || null
          this.currentToolInput = ''
          console.log('[tool-debug] tool_start:', this.currentToolName)
          // Detect planning mode tools
          if (this.currentToolName === 'EnterPlanMode') {
            this.emit('planning_mode', true)
          } else if (this.currentToolName === 'ExitPlanMode') {
            // Defer planning_mode false until tool_result confirms the tool was allowed.
            // The PreToolUse hook prompts the user for approval; if denied, we should
            // NOT show "Exited plan mode". Use tool_use id for matching; fall back to
            // a sentinel so the flag-based check in handleUserEvent still works.
            this.pendingExitPlanModeId = inner.content_block.id || '__pending__'
          } else {
            this.emit('tool_active', this.currentToolName!, undefined)
          }
        } else if (inner.content_block?.type === 'thinking') {
          this.inThinkingBlock = true
          this.thinkingText = ''
          this.thinkingSummaryEmitted = false
        }
        break

      case 'content_block_delta':
        if (inner.delta?.type === 'text_delta' && inner.delta.text) {
          this.emit('text', inner.delta.text)
        } else if (inner.delta?.type === 'input_json_delta' && inner.delta.partial_json) {
          this.currentToolInput += inner.delta.partial_json
        } else if (inner.delta?.type === 'thinking_delta' && (inner.delta as Record<string, unknown>).thinking && this.inThinkingBlock) {
          this.thinkingText += (inner.delta as Record<string, unknown>).thinking as string
          if (!this.thinkingSummaryEmitted) {
            const summary = this.extractThinkingSummary(this.thinkingText)
            if (summary) {
              this.thinkingSummaryEmitted = true
              this.emit('thinking', summary)
            }
          }
        }
        break

      case 'content_block_stop':
        if (this.inThinkingBlock) {
          // Emit summary if we didn't get enough text earlier
          if (!this.thinkingSummaryEmitted && this.thinkingText.length > 0) {
            const summary = this.extractThinkingSummary(this.thinkingText) || this.thinkingText.slice(0, 80).trim()
            this.emit('thinking', summary)
          }
          this.inThinkingBlock = false
          this.thinkingText = ''
          this.thinkingSummaryEmitted = false
          break
        }
        if (this.currentToolName) {
          // Parse tool input and emit structured tool_done with summary
          let summary: string | undefined
          try {
            const parsed = JSON.parse(this.currentToolInput)
            summary = this.summarizeToolInput(this.currentToolName, parsed) || undefined
            // Handle task tools
            const isTask = this.currentToolName === 'TaskCreate' || this.currentToolName === 'TaskUpdate' || this.currentToolName === 'TodoWrite' || this.currentToolName === 'TodoRead'
            if (isTask) console.log('[task-debug] tool:', this.currentToolName, 'input:', JSON.stringify(parsed).slice(0, 200))
            if (this.handleTaskTool(this.currentToolName, parsed)) {
              console.log('[task-debug] emitting todo_update, tasks:', this.tasks.size)
              this.emit('todo_update', Array.from(this.tasks.values()))
            }
          } catch { /* ignore parse errors */ }
          this.emit('tool_done', this.currentToolName, summary)
          this.currentToolName = null
          this.currentToolInput = ''
        }
        break
    }
  }

  /** No-op: assistant messages are handled via stream_event deltas instead. */
  private handleAssistantMessage(): void {
    // assistant events with --include-partial-messages contain tool_use blocks
    // but tool_results come in separate 'user' events — see handleUserEvent
  }

  /** Extract tool_result blocks from 'user' events and emit as tool_output. */
  private handleUserEvent(event: ClaudeEvent): void {
    const msg = (event as unknown as { message?: { content?: unknown[] } }).message
    if (!msg?.content) return

    const blocks = Array.isArray(msg.content) ? msg.content : []
    for (const block of blocks as Array<{ type: string; tool_use_id?: string; content?: unknown; is_error?: boolean }>) {
      if (block.type === 'tool_result') {
        const content = typeof block.content === 'string' ? block.content : JSON.stringify(block.content)
        const isError = block.is_error === true
        console.log(`[tool-result] id=${block.tool_use_id} error=${isError} content=${content.slice(0, 300)}`)

        // Deferred ExitPlanMode: emit planning_mode only after tool_result confirms success.
        // Match by tool_use_id, or use flag-based fallback when id wasn't available.
        if (this.pendingExitPlanModeId &&
            (block.tool_use_id === this.pendingExitPlanModeId || this.pendingExitPlanModeId === '__pending__')) {
          this.pendingExitPlanModeId = null
          if (!isError) {
            this.emit('planning_mode', false)
          }
        }

        // Emit non-empty tool results as dedicated tool_output events
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
      if (!Array.isArray(questions) || questions.length === 0) return

      const structuredQuestions = questions.map(q => ({
        question: q.question,
        header: q.header,
        multiSelect: q.multiSelect ?? false,
        options: (q.options || []).map((opt: { label: string; description?: string }) => ({
          label: opt.label,
          value: opt.label,
          description: opt.description,
        })),
      }))

      // Emit a single prompt with the first question's options for display,
      // plus the full questions array for the multi-question flow
      const first = structuredQuestions[0]
      this.emit('prompt', 'question', first.question, first.options, first.multiSelect, undefined, toolInput, request_id, structuredQuestions)
    } else if (toolName === 'ExitPlanMode') {
      // ExitPlanMode needs user confirmation — forward to UI as a prompt
      console.log(`[control_request] forwarding ExitPlanMode to session manager for user approval`)
      this.emit('control_request', request_id, toolName, toolInput)
    } else if (toolName === 'Bash') {
      // Bash runs arbitrary commands — forward to session manager for registry check / UI prompt
      console.log(`[control_request] forwarding Bash to session manager: ${redactSecrets(String(toolInput.command || '').slice(0, 80))}`)
      this.emit('control_request', request_id, toolName, toolInput)
    } else {
      // All other tools (Write, Edit, Read, Glob, Grep, Task, TodoWrite,
      // EnterPlanMode, etc.) are safe — auto-approve
      console.log(`[control_request] auto-approving: ${toolName}`)
      this.sendControlResponse(request_id, 'allow')
    }
  }

  /** Send a control_response back to the CLI to allow or deny a pending request. */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, message?: string): void {
    const response: Record<string, unknown> = {
      type: 'control_response',
      request_id: requestId,
      behavior,
    }
    if (updatedInput !== undefined) response.updatedInput = updatedInput
    if (message !== undefined) response.message = message
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

  /** Generate a short human-readable summary of a tool invocation for the UI chip. */
  private summarizeToolInput(toolName: string, input: Record<string, unknown>): string {
    switch (toolName) {
      case 'Bash': {
        const cmd = String(input.command || '')
        // Truncate long commands to first line
        const firstLine = cmd.split('\n')[0]
        return firstLine.length < cmd.length ? `$ ${firstLine}...` : `$ ${cmd}`
      }
      case 'Read':
        return String(input.file_path || '')
      case 'Write':
      case 'Edit':
        return String(input.file_path || '')
      case 'Glob':
        return String(input.pattern || '')
      case 'Grep':
        return String(input.pattern || '')
      case 'Task':
        return String(input.description || '')
      case 'EnterPlanMode':
        return 'Entering plan mode'
      case 'ExitPlanMode':
        return 'Exiting plan mode'
      case 'TaskCreate':
        return String(input.subject || '')
      case 'TaskUpdate':
        return `#${input.taskId || ''} → ${input.status || ''}`
      case 'TaskList':
        return 'Listing tasks'
      case 'TaskGet':
        return `#${input.taskId || ''}`
      case 'TodoWrite': {
        const todos = input.todos as Array<Record<string, unknown>> | undefined
        return todos ? `${todos.length} tasks` : ''
      }
      case 'TodoRead':
        return 'Reading tasks'
      default:
        return ''
    }
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
    if (this.proc) {
      this.proc.kill('SIGTERM')
      // Force kill after 5 seconds
      setTimeout(() => {
        if (this.proc) {
          this.proc.kill('SIGKILL')
        }
      }, 5000)
    }
  }

  isAlive(): boolean {
    return this.alive
  }

  getSessionId(): string {
    return this.sessionId
  }

}
