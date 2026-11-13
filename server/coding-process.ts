/**
 * Abstract interface for AI coding assistant processes.
 *
 * Both ClaudeProcess (Claude Code CLI via stdin/stdout NDJSON) and
 * OpenCodeProcess (OpenCode server via HTTP/SSE) implement this interface,
 * allowing SessionManager to work with either provider transparently.
 *
 * The event interface mirrors ClaudeProcessEvents — all providers emit the
 * same set of typed events so the session layer and frontend need no
 * provider-specific branching for event handling.
 */

import type { EventEmitter } from 'events'
import type { ClaudeProcessEvents } from './claude-process.js'
import type { CodingProvider, TaskItem } from './protocol.js'

/** Supported AI coding assistant providers; defined with the wire protocol in protocol.ts. */
export type { CodingProvider }

/**
 * Minimum process interface consumed by SessionManager.
 *
 * Any provider process must:
 * 1. Emit typed events from ClaudeProcessEvents
 * 2. Accept user messages via sendMessage()
 * 3. Support lifecycle management (start/stop/isAlive)
 * 4. Respond to permission requests via sendControlResponse()
 *
 * ClaudeProcess already satisfies this (it extends EventEmitter<ClaudeProcessEvents>).
 * OpenCodeProcess implements it via HTTP/SSE under the hood.
 */
export interface CodingProcess extends EventEmitter<ClaudeProcessEvents> {
  /** Start the underlying process or connection. */
  start(): void

  /** Gracefully stop the process (SIGTERM then SIGKILL, or HTTP disconnect). */
  stop(): void

  /** Send a user message to the AI assistant. */
  sendMessage(content: string): void

  /** Write raw protocol data (used for control_response in Claude, no-op in OpenCode). */
  sendRaw(data: string): void

  /**
   * Respond to a permission/control request.
   * Claude: writes control_response JSON to stdin ('allow_always' = 'allow').
   * OpenCode: POSTs to /permission/:requestId/reply (once/always/reject).
   */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny' | 'allow_always', updatedInput?: Record<string, unknown>, message?: string): void

  /**
   * Optionally change the permission mode in-place without a restart.
   * Resolves true if the provider acknowledged the change. Providers that
   * don't support runtime mode changes omit this — callers fall back to restart.
   */
  setPermissionMode?(mode: import('./types.js').PermissionMode): Promise<boolean>

  /**
   * Optionally change the reasoning effort in-place without a restart
   * (undefined = harness default). Providers that can only take effort at
   * spawn time omit this — callers fall back to restart.
   */
  setEffort?(effort: string | undefined): void

  /** Seed task/todo state from a previous process's last known list (session restore). */
  seedTasks(tasks: TaskItem[]): void

  /** Whether the process is currently running and accepting input. */
  isAlive(): boolean

  /** Whether the process is fully initialized and ready to accept messages immediately. */
  isReady(): boolean

  /** The provider's internal session ID (used for resume). */
  getSessionId(): string

  /** Returns a promise that resolves when the process exits. */
  waitForExit(timeoutMs?: number): Promise<void>

  /** Which provider this process belongs to. */
  readonly provider: CodingProvider
}
