/**
 * Shared type definitions for the Codekin frontend.
 *
 * Covers repo/session models, WebSocket protocol messages (client↔server),
 * chat UI message types, and plugin/skill configuration.
 */

/** A slash-command skill available in a repo (loaded from .claude/skills/). */
export interface Skill {
  id: string
  name: string
  description: string
  /** The slash-command trigger, e.g. "/validate-gemini". */
  command: string
  /** The full skill prompt content (loaded lazily on selection). */
  content?: string
}

/** A context module that can be attached to a message for extra instructions. */
export interface Module {
  id: string
  name: string
  description: string
  content: string
}

/** A git repository available for Claude sessions. */
export interface Repo {
  id: string
  name: string
  /** Absolute path on the server filesystem. */
  path: string
  /** Working directory used when spawning Claude (usually same as path). */
  workingDir: string
  skills: Skill[]
  modules: Module[]
  tags: string[]
}

/** Response shape from the upload server's /repos endpoint. */
export interface RepoManifest {
  repos: Repo[]
  generatedAt: string
}

/** Client-side session info (subset of server Session, safe to serialize). */
export interface Session {
  id: string
  name: string
  created: string
  /** Whether a Claude CLI process is currently running for this session. */
  active: boolean
  /** Whether Claude is actively processing a user request in this session. */
  isProcessing?: boolean
  workingDir: string
  /** Optional grouping key for the UI (e.g. webhook sessions group under the original repo). */
  groupDir?: string
  connectedClients: number
  lastActivity: string
  /** How the session was created: manually by a user, by a GitHub webhook, or by a workflow. */
  source?: 'manual' | 'webhook' | 'workflow'
}

/**
 * Messages sent from the browser client to the WebSocket server.
 *
 * Each variant maps to an action the user or UI can trigger.
 */
export type WsClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'create_session'; name: string; workingDir: string; model?: string }
  | { type: 'join_session'; sessionId: string }
  | { type: 'leave_session' }
  | { type: 'start_claude'; options?: Record<string, unknown> }
  | { type: 'set_model'; model: string }
  | { type: 'stop' }
  | { type: 'input'; data: string; displayText?: string }
  | { type: 'prompt_response'; value: string | string[]; requestId?: string }
  | { type: 'resize'; cols: number; rows: number }
  | { type: 'ping' }
  | { type: 'get_diff'; scope?: DiffScope }
  | { type: 'discard_changes'; scope: DiffScope; paths?: string[]; statuses?: Record<string, DiffFileStatus> }

/** A tracked task item from Claude's TodoWrite tool. */
export interface TaskItem {
  id: string
  subject: string
  status: 'pending' | 'in_progress' | 'completed'
  /** Present-continuous label shown while task is in_progress (e.g. "Running tests"). */
  activeForm?: string
}

/**
 * Messages sent from the WebSocket server to the browser client.
 *
 * These drive the entire chat UI: streaming text, tool activity indicators,
 * prompt dialogs, session lifecycle events, and background webhook notifications.
 */
export type WsServerMessage =
  | { type: 'connected'; connectionId: string; claudeAvailable: boolean; claudeVersion: string; apiKeySet: boolean }
  | { type: 'session_created'; sessionId: string; sessionName: string; workingDir: string }
  | { type: 'session_joined'; sessionId: string; sessionName: string; workingDir: string; active: boolean; outputBuffer: WsServerMessage[] }
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
  | { type: 'sessions_updated' }
  | { type: 'diff_result'; files: DiffFile[]; summary: DiffSummary; branch: string; scope: DiffScope }
  | { type: 'diff_error'; message: string }

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

/**
 * UI-level chat message types rendered in ChatView.
 *
 * These are derived from WsServerMessage events by processMessage() / rebuildFromHistory()
 * in useChatSocket. Each variant maps to a distinct visual component in the chat.
 */
export type ChatMessage =
  | { type: 'assistant'; text: string; complete: boolean; ts?: number; key?: string }
  | { type: 'user'; text: string; ts?: number; key?: string }
  | { type: 'system'; subtype: 'init' | 'exit' | 'error' | 'restart' | 'stall' | 'notification' | 'trim'; text: string; model?: string; ts?: number; key?: string }
  | { type: 'tool_group'; tools: Array<{ name: string; summary?: string; active: boolean }>; ts?: number; key?: string }
  | { type: 'tool_output'; content: string; isError?: boolean; ts?: number; key?: string }
  | { type: 'image'; base64: string; mediaType: string; ts?: number; key?: string }
  | { type: 'planning_mode'; active: boolean; ts?: number; key?: string }
  | { type: 'todo_list'; tasks: TaskItem[]; ts?: number; key?: string }
  | { type: 'tentative'; text: string; index: number; ts?: number; key?: string }

/** WebSocket connection lifecycle state. */
export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

/** User-configurable settings stored in localStorage. */
export interface Settings {
  token: string
  fontSize: number
  theme: 'dark' | 'light'
}

/** Docs picker state passed through LeftSidebar → RepoSection. */
export interface DocsPickerProps {
  open?: boolean
  repoDir?: string | null
  files?: { path: string; pinned: boolean }[]
  loading?: boolean
  starredDocs?: string[]
  onSelect?: (filePath: string) => void
  onClose?: () => void
}

/** Mobile layout props for components that support responsive drawer mode. */
export interface MobileProps {
  isMobile?: boolean
  mobileOpen?: boolean
  onMobileClose?: () => void
}

