/**
 * Server-side type definitions for Codekin.
 *
 * Covers the internal Session model (with process refs and client tracking),
 * Claude CLI stream-json protocol events, and the WebSocket protocol messages
 * exchanged between server and browser clients.
 */

import type { WebSocket } from 'ws'
import type { ClaudeProcess } from './claude-process.js'

/**
 * Permission modes supported by the Claude CLI `--permission-mode` flag.
 * Keep in sync with src/types.ts PermissionMode.
 */
export type PermissionMode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'

/** Allow-list for server-side validation of client-supplied permission modes. */
export const VALID_PERMISSION_MODES = new Set<PermissionMode>(['default', 'acceptEdits', 'plan', 'bypassPermissions'])

/** Allow-list for server-side validation of client-supplied model IDs. */
export const VALID_MODELS = new Set([
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
])

/**
 * Server-side session state. Holds the Claude child process, connected
 * WebSocket clients, output history for replay, and permission registries.
 */
export interface Session {
  id: string
  name: string
  workingDir: string
  /** Optional grouping key for the UI. When set, sessions are grouped by this
   *  instead of workingDir (e.g. webhook sessions group under the original repo). */
  groupDir?: string
  /** Absolute path to the git worktree directory, if this session uses one. */
  worktreePath?: string
  created: string
  source: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'
  /** The spawned Claude CLI process, or null if not running. */
  claudeProcess: ClaudeProcess | null
  /** All browser clients currently viewing this session. */
  clients: Set<WebSocket>
  /** Rolling buffer of messages for replay when a new client joins. */
  outputHistory: WsServerMessage[]
  /** Claude CLI's internal session ID, used for --session-id resume across restarts. */
  claudeSessionId: string | null
  /** Preferred model to pass via --model flag (e.g. 'claude-opus-4-6'). Defaults to Claude's default. */
  model?: string
  /** Permission mode passed to the Claude CLI via --permission-mode flag. */
  permissionMode?: PermissionMode
  /** Additional tools to pre-approve via --allowedTools (e.g. 'Bash(curl:*)', 'WebFetch'). */
  allowedTools?: string[]
  /** Number of auto-restarts since last cooldown reset. */
  restartCount: number
  lastRestartAt: number | null
  /** Set when the user explicitly stops Claude; prevents auto-restart. */
  _stoppedByUser: boolean
  /** Timer that fires a 'stall' warning after 5 min of no output. */
  _stallTimer: ReturnType<typeof setTimeout> | null
  /** True after a stall warning has been sent; prevents repeated warnings until new user input. */
  _stallFired: boolean
  /** Flag used during server restart to remember which sessions need auto-resume. */
  _wasActiveBeforeRestart: boolean
  /** In-flight control_request prompts awaiting user response, keyed by requestId. */
  pendingControlRequests: Map<string, { requestId: string; toolName: string; toolInput: Record<string, unknown>; promptMsg?: WsServerMessage }>
  /** Pending PreToolUse hook approvals, keyed by requestId. */
  pendingToolApprovals: Map<string, { resolve: (result: { allow: boolean; always: boolean; answer?: string }) => void; toolName: string; toolInput: Record<string, unknown>; requestId: string; promptMsg?: WsServerMessage }>
  /** True while Claude is actively processing a user request (between input and result). */
  isProcessing: boolean
  /** Number of completed user turns (for triggering session naming on first message). */
  _turnCount: number
  /** Timer for the delayed one-shot naming process. */
  _namingTimer?: ReturnType<typeof setTimeout>
  /** Number of naming attempts so far (for retry back-off). */
  _namingAttempts: number
  /** The model reported by the last system init event, used to suppress duplicate init messages. */
  _lastReportedModel?: string
  /** Last user input sent, stored for API error retry. */
  _lastUserInput?: string
  /** Number of consecutive API error retries for the current turn. */
  _apiRetryCount: number
  /** Timer handle for scheduled API error retry. */
  _apiRetryTimer?: ReturnType<typeof setTimeout>
  /** Grace period timer before auto-denying prompts after last client leaves. */
  _leaveGraceTimer?: ReturnType<typeof setTimeout> | null
}

/** Serializable session info returned by the REST API (no process refs or Sets). */
export interface SessionInfo {
  id: string
  name: string
  created: string
  active: boolean
  /** True while Claude is actively processing a user request (between input and result). */
  isProcessing: boolean
  workingDir: string
  groupDir?: string
  /** Absolute path to the git worktree directory, if this session uses one. */
  worktreePath?: string
  connectedClients: number
  lastActivity: string
  source: 'manual' | 'webhook' | 'workflow' | 'stepflow' | 'orchestrator' | 'agent'
}

// ---------------------------------------------------------------------------
// Claude CLI stream-json protocol events (read from stdout)
// ---------------------------------------------------------------------------

/** Emitted once when the CLI starts, contains model info and available tools. */
export interface ClaudeSystemInit {
  type: 'system'
  subtype: 'init'
  cwd: string
  session_id: string
  tools: string[]
  model: string
}

/** A complete assistant turn with all content blocks (text + tool_use). */
export interface ClaudeAssistantMessage {
  type: 'assistant'
  message: {
    model: string
    id: string
    role: 'assistant'
    content: ClaudeContentBlock[]
    stop_reason: string | null
    usage: Record<string, unknown>
  }
  session_id: string
  /** Non-null when this message is a sub-agent response inside a Tool call. */
  parent_tool_use_id: string | null
}

/**
 * Individual content blocks within an assistant message.
 *
 * Which block types appear in which events:
 * - `text`        → ClaudeAssistantMessage (final) and content_block_delta (streaming)
 * - `tool_use`    → ClaudeAssistantMessage (final) and content_block_start (streaming)
 * - `tool_result` → ClaudeToolResultEvent (sent by Claude after tool execution)
 *
 * Note: `thinking` blocks are not modelled here — they arrive as content_block_delta
 * events with type 'thinking' and are handled separately in ClaudeProcess.
 */
export type ClaudeContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string }

/**
 * Streaming SSE-style event wrapping Anthropic API deltas.
 * Includes content_block_start/delta/stop for incremental text and tool input.
 */
export interface ClaudeStreamEvent {
  type: 'stream_event'
  event: {
    type: string
    delta?: {
      type: string
      text?: string
      partial_json?: string
      stop_reason?: string
    }
    content_block?: {
      type: string
      text?: string
      name?: string
      id?: string
    }
    index?: number
  }
  session_id: string
  parent_tool_use_id: string | null
}

/** Emitted at the end of a turn with cost/duration info and success/error status. */
export interface ClaudeResultEvent {
  type: 'result'
  subtype: 'success' | 'error'
  is_error: boolean
  result: string
  session_id: string
  duration_ms: number
  total_cost_usd: number
}

/**
 * Permission/interaction request from Claude CLI.
 * Used as fallback for Bash approvals and for AskUserQuestion routing.
 * Server must respond with a control_response to allow or deny.
 */
export interface ClaudeControlRequest {
  type: 'control_request'
  request_id: string
  request: {
    type: string
    tool_name: string
    input: Record<string, unknown>
    description?: string
  }
  session_id: string
}

/**
 * Union of all event types emitted by the Claude CLI on stdout.
 * The final catch-all variant handles unknown/future event types gracefully.
 */
export type ClaudeEvent =
  | ClaudeSystemInit
  | ClaudeAssistantMessage
  | ClaudeStreamEvent
  | ClaudeResultEvent
  | ClaudeControlRequest
  | { type: string; [key: string]: unknown }

/** A tracked task item from Claude's TodoWrite tool. */
export interface TaskItem {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

// ---------------------------------------------------------------------------
// WebSocket protocol messages (server ↔ browser client)
// ---------------------------------------------------------------------------

/** Messages sent from the server to browser clients over WebSocket. */
export type WsServerMessage =
  | { type: 'connected'; connectionId: string; claudeAvailable: boolean; claudeVersion: string; apiKeySet: boolean }
  | { type: 'session_created'; sessionId: string; sessionName: string; workingDir: string }
  | { type: 'session_joined'; sessionId: string; sessionName: string; workingDir: string; active: boolean; outputBuffer: WsServerMessage[]; model?: string; permissionMode?: PermissionMode }
  | { type: 'session_left' }
  | { type: 'session_deleted'; message: string }
  | { type: 'claude_started'; sessionId: string }
  | { type: 'claude_stopped' }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number; signal: string | null }
  | { type: 'error'; message: string }
  | { type: 'info'; message: string }
  | { type: 'pong' }
  | { type: 'prompt'; promptType: 'permission' | 'question'; question: string; options: PromptOption[]; multiSelect?: boolean; toolName?: string; toolInput?: Record<string, unknown>; requestId?: string; sessionId?: string; sessionName?: string; questions?: PromptQuestion[]; approvePattern?: string }
  | { type: 'prompt_dismiss'; requestId?: string }
  | { type: 'thinking'; summary: string }
  | { type: 'tool_active'; toolName: string; toolInput?: string }
  | { type: 'tool_done'; toolName: string; summary?: string }
  | { type: 'tool_output'; content: string; isError?: boolean }
  | { type: 'image'; base64: string; mediaType: string }
  | { type: 'system_message'; subtype: 'init' | 'exit' | 'error' | 'restart' | 'stall' | 'notification'; text: string; model?: string }
  | { type: 'user_echo'; text: string }
  | { type: 'result' }
  | { type: 'planning_mode'; active: boolean }
  | { type: 'todo_update'; tasks: TaskItem[] }
  | { type: 'session_name_update'; sessionId: string; name: string }
  | { type: 'webhook_event'; event: string; repo: string; branch: string; workflow: string; conclusion: string; status: string; sessionId?: string }
  | { type: 'workflow_event'; eventType: string; runId: string; kind: string; stepKey?: string; status?: string; payload?: unknown }
  | { type: 'worktree_created'; worktreePath: string; workingDir: string }
  | { type: 'sessions_updated' }
  | { type: 'diff_result'; files: DiffFile[]; summary: DiffSummary; branch: string; scope: DiffScope }
  | { type: 'diff_error'; message: string }

/** Messages sent from browser clients to the server over WebSocket. */
export type WsClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'create_session'; name: string; workingDir: string; model?: string; useWorktree?: boolean; permissionMode?: PermissionMode; allowedTools?: string[] }
  | { type: 'join_session'; sessionId: string }
  | { type: 'leave_session' }
  | { type: 'start_claude'; options?: Record<string, unknown> }
  | { type: 'set_model'; model: string }
  | { type: 'set_permission_mode'; permissionMode: PermissionMode }
  | { type: 'stop' }
  | { type: 'input'; data: string; displayText?: string }
  | { type: 'prompt_response'; value: string | string[]; requestId?: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  | { type: 'get_diff'; scope?: DiffScope }
  | { type: 'discard_changes'; scope: DiffScope; paths?: string[]; statuses?: Record<string, DiffFileStatus> }
  | { type: 'move_to_worktree' }

// --- Diff viewer types ---

export type DiffScope = 'staged' | 'unstaged' | 'all'
export type DiffFileStatus = 'modified' | 'added' | 'deleted' | 'renamed'

export interface DiffFile {
  path: string
  status: DiffFileStatus
  oldPath?: string
  isBinary: boolean
  additions: number
  deletions: number
  hunks: DiffHunk[]
}

export interface DiffHunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffLine {
  type: 'add' | 'delete' | 'context'
  content: string
  oldLineNo?: number
  newLineNo?: number
}

export interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
  truncated: boolean
  truncationReason?: string
}

/** A selectable option in a permission or question prompt dialog. */
export interface PromptOption {
  label: string
  value: string
  description?: string
}

/** A single question in a multi-question AskUserQuestion prompt. */
export interface PromptQuestion {
  question: string
  header?: string
  options: PromptOption[]
  multiSelect: boolean
}
