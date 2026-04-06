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

/**
 * Supported AI coding assistant providers.
 * - 'claude': Claude Code CLI (subprocess, NDJSON on stdin/stdout)
 * - 'opencode': OpenCode server (HTTP REST + SSE)
 */
export type CodingProvider = 'claude' | 'opencode'

/**
 * Capabilities that differ between providers. SessionManager and frontend
 * use this to gate features that aren't universally available.
 */
export interface ProviderCapabilities {
  /** Provider supports bidirectional streaming (true for both Claude and OpenCode). */
  streaming: boolean
  /** Provider supports multi-turn conversations within a single process. */
  multiTurn: boolean
  /** Provider supports programmatic permission control. */
  permissionControl: boolean
  /** Provider emits tool_active/tool_done events for real-time tool indicators. */
  toolEvents: boolean
  /** Provider emits thinking/reasoning deltas. */
  thinkingDisplay: boolean
  /** Provider supports multiple LLM backends (not just Anthropic). */
  multiProvider: boolean
  /** Provider supports plan mode (read-only agent). */
  planMode: boolean
}

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
   * Claude: writes control_response JSON to stdin.
   * OpenCode: POSTs to /permission/:requestId/reply.
   */
  sendControlResponse(requestId: string, behavior: 'allow' | 'deny', updatedInput?: Record<string, unknown>, message?: string): void

  /** Whether the process is currently running and accepting input. */
  isAlive(): boolean

  /** The provider's internal session ID (used for resume). */
  getSessionId(): string

  /** Returns a promise that resolves when the process exits. */
  waitForExit(timeoutMs?: number): Promise<void>

  /** Which provider this process belongs to. */
  readonly provider: CodingProvider

  /** Provider capability flags. */
  readonly capabilities: ProviderCapabilities
}

/** Default capabilities for the Claude Code CLI provider. */
export const CLAUDE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  multiTurn: true,
  permissionControl: true,
  toolEvents: true,
  thinkingDisplay: true,
  multiProvider: false,
  planMode: true,
}

/** Default capabilities for the OpenCode provider. */
export const OPENCODE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  multiTurn: true,
  permissionControl: true,
  toolEvents: true,
  thinkingDisplay: true,
  multiProvider: true,
  planMode: true,
}
