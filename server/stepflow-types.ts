/**
 * Types for Stepflow → Codekin webhook integration.
 *
 * Stepflow (https://www.npmjs.com/package/@multiplier-labs/stepflow) is a
 * durable workflow orchestration engine.  When a workflow step needs a Claude
 * session to work on a code repository it registers Codekin's endpoint as a
 * WebhookEventTransport target and emits a `claude.session.requested` event.
 *
 * ┌──────────────────────────────────────────────────────────────────────────┐
 * │  Integration overview                                                    │
 * │                                                                          │
 * │  Stepflow workflow step                                                  │
 * │    ctx.emit('claude.session.requested', { repo, branch, ... })          │
 * │    ↓  (WebhookEventTransport, signed with STEPFLOW_WEBHOOK_SECRET)       │
 * │  POST /api/webhooks/stepflow                                             │
 * │    → verify HMAC, filter, dedup, cap check                              │
 * │    → createWorkspace(repo, branch, headSha)                             │
 * │    → sessions.create(workspacePath, { source: 'stepflow' })             │
 * │    → sessions.sendInput(buildStepflowPrompt(payload.event.payload))     │
 * │    ↓  (session exit callback)                                            │
 * │  POST callbackUrl   (signed with callbackSecret)                        │
 * │    → Stepflow receives result, continues workflow                       │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * See also:
 *   stepflow-prompt.ts  — builds the initial Claude prompt
 *   stepflow-handler.ts — handles the full request/response lifecycle
 */

// ---------------------------------------------------------------------------
// Inbound payload (what Stepflow POSTs to us)
// ---------------------------------------------------------------------------

/**
 * Raw webhook payload sent by Stepflow's `WebhookEventTransport`.
 *
 * Register Codekin as an endpoint in your Stepflow setup:
 *
 * ```typescript
 * import { WebhookEventTransport } from '@multiplier-labs/stepflow'
 *
 * new WebhookEventTransport({
 *   endpoints: [{
 *     id: 'codekin',
 *     url: 'https://your-codekin/api/webhooks/stepflow',
 *     secret: process.env.STEPFLOW_WEBHOOK_SECRET,
 *     eventTypes: ['claude.session.requested'],
 *     // optionally filter to specific workflow kinds:
 *     // workflowKinds: ['code.fix', 'code.review'],
 *   }],
 * })
 * ```
 *
 * Stepflow signs each POST with HMAC-SHA256 in the `X-Webhook-Signature` header.
 */
export interface StepflowWebhookPayload {
  /** The Stepflow event that triggered this delivery. */
  event: {
    /** Stepflow workflow run ID — used for deduplication and callback correlation. */
    runId: string
    /** Workflow kind (e.g. `'code.fix'`, `'code.review'`). */
    kind: string
    /**
     * Event type string.
     * Only `'claude.session.requested'` is processed; all others are filtered.
     */
    eventType: string
    /** Step key within the workflow that emitted this event, if applicable. */
    stepKey?: string
    /**
     * Event payload.  For `claude.session.requested` events this must be a
     * `StepflowSessionRequest`.  Other event types may have any shape.
     */
    payload?: StepflowSessionRequest | unknown
    /** ISO timestamp when the event was emitted. */
    timestamp: string
  }
  /** ISO timestamp when Stepflow delivered this webhook. */
  deliveredAt: string
  /**
   * Unique delivery ID assigned by Stepflow — used as the primary dedup key.
   * Stepflow retries deliveries on non-2xx responses, so the same webhookId
   * may arrive multiple times.
   */
  webhookId: string
}

/**
 * Structured data the Stepflow workflow puts in `event.payload` when it needs
 * a Claude session.  Emitted from a step handler like:
 *
 * ```typescript
 * // Inside a Stepflow step handler:
 * ctx.emit('claude.session.requested', {
 *   repo: 'acme/my-app',
 *   cloneUrl: 'https://github.com/acme/my-app.git',
 *   branch: 'main',
 *   headSha: 'abc1234...',
 *   taskDescription: 'Fix the failing TypeScript type errors.',
 *   taskContext: 'This is part of a nightly maintenance workflow.',
 *   callbackUrl: `${CODEKIN_INTERNAL_URL}/api/stepflow-callback/${ctx.runId}`,
 *   callbackSecret: process.env.STEPFLOW_CALLBACK_SECRET,
 *   prNumber: 42,
 *   prTitle: 'feat: add new endpoint',
 * } satisfies StepflowSessionRequest)
 * ```
 */
export interface StepflowSessionRequest {
  // -------------------------------------------------------------------------
  // Required: workspace
  // -------------------------------------------------------------------------

  /**
   * Full repository name (`owner/repo`), e.g. `'acme/my-app'`.
   * Used to create the workspace via `createWorkspace()` and to name the session.
   */
  repo: string

  /**
   * HTTPS clone URL, e.g. `'https://github.com/acme/my-app.git'`.
   * Passed to `git clone` when creating a fresh bare mirror.
   */
  cloneUrl: string

  /** Branch to check out in the workspace. */
  branch: string

  /**
   * Exact commit SHA to pin the workspace to.
   * The workspace is reset to this commit with `git reset --hard <headSha>`
   * so Claude always works on the same code regardless of branch tip drift.
   */
  headSha: string

  // -------------------------------------------------------------------------
  // Required: task
  // -------------------------------------------------------------------------

  /**
   * The primary instruction sent to Claude.  Should be a clear, self-contained
   * description of the task.  Rendered as the "## Task" section of the prompt.
   *
   * Example: `'Fix the failing ESLint errors reported by CI.'`
   */
  taskDescription: string

  // -------------------------------------------------------------------------
  // Optional: extra context for Claude
  // -------------------------------------------------------------------------

  /**
   * Additional background information, constraints, or workflow context that
   * helps Claude understand the broader goal.  Rendered as the
   * "## Context" section of the prompt when present.
   *
   * Example: `'This task is part of a nightly automated maintenance workflow.
   * Only fix what is necessary; do not refactor unrelated code.'`
   */
  taskContext?: string

  // -------------------------------------------------------------------------
  // Optional: result callback
  // -------------------------------------------------------------------------

  /**
   * URL to POST the session result to when Claude exits.
   * The POST body is a `StepflowSessionResult`.
   * If omitted, no callback is made (fire-and-forget mode).
   *
   * Example: `'https://stepflow.internal/api/callbacks/run-abc123'`
   */
  callbackUrl?: string

  /**
   * HMAC-SHA256 secret used to sign the callback POST.
   * The signature is set in the `X-Stepflow-Signature` header of the callback
   * request, computed over the raw JSON body.
   * If omitted, the callback is sent unsigned.
   */
  callbackSecret?: string

  // -------------------------------------------------------------------------
  // Optional: associated PR / issue (surfaced in the prompt for context)
  // -------------------------------------------------------------------------

  /** Pull request number if this task is linked to a PR. */
  prNumber?: number
  /** Pull request title, for display in the Claude prompt. */
  prTitle?: string

  /** Issue number if this task is linked to a GitHub issue. */
  issueNumber?: number
  /** Issue title, for display in the Claude prompt. */
  issueTitle?: string
}

// ---------------------------------------------------------------------------
// Outbound callback (what we POST back to Stepflow when the session completes)
// ---------------------------------------------------------------------------

/**
 * POSTed to `StepflowSessionRequest.callbackUrl` when the Claude session exits.
 * Allows the Stepflow workflow to continue based on the outcome.
 *
 * The request is signed with HMAC-SHA256 if `callbackSecret` was provided:
 *   `X-Stepflow-Signature: sha256=<hmac>`
 *
 * Stepflow step handler example:
 * ```typescript
 * // In a Stepflow step that waits for the callback:
 * const result: StepflowSessionResult = ctx.results.wait_for_claude
 * if (result.status === 'error') {
 *   throw new Error(`Claude session failed: ${result.error}`)
 * }
 * ```
 */
export interface StepflowSessionResult {
  /** The Stepflow run ID from the originating webhook (for correlation). */
  runId: string
  /** The Codekin session ID that was created. */
  sessionId: string
  /** `'completed'` if Claude exited 0, `'error'` otherwise. */
  status: 'completed' | 'error'
  /** Claude process exit code. */
  exitCode: number
  /** Human-readable error description when `status === 'error'`. */
  error?: string
}

// ---------------------------------------------------------------------------
// Internal event tracking
// ---------------------------------------------------------------------------

/**
 * State machine for a single Stepflow webhook delivery.
 *
 * States:
 *   processing      → event accepted, workspace/session being created
 *   session_created → workspace ready, Claude session started, prompt sent
 *   completed       → Claude exited 0
 *   error           → workspace/session failed, or Claude exited non-zero
 *   filtered        → event type or config prevents processing (terminal)
 *   duplicate       → webhookId already processed (terminal)
 */
export type StepflowEventStatus =
  | 'processing'
  | 'session_created'
  | 'completed'
  | 'error'
  | 'filtered'
  | 'duplicate'

/**
 * In-memory record for a single Stepflow webhook delivery.
 * Stored in a ring buffer (last 100) for the management API.
 */
export interface StepflowEvent {
  /** Stepflow `webhookId` — primary dedup key. */
  id: string
  /** ISO timestamp when this webhook was received. */
  receivedAt: string
  /** Stepflow `event.runId`. */
  runId: string
  /** Stepflow workflow kind (e.g. `'code.fix'`). */
  kind: string
  /** Stepflow event type (e.g. `'claude.session.requested'`). */
  eventType: string
  /** Step key that emitted the event. */
  stepKey?: string
  /** Repository from `event.payload.repo`. */
  repo?: string
  /** Branch from `event.payload.branch`. */
  branch?: string
  /** Current processing status. */
  status: StepflowEventStatus
  /** Codekin session ID created for this event. */
  sessionId?: string
  /** Error description if `status === 'error'`. */
  error?: string
  /** If `status === 'filtered'`, the reason why. */
  filterReason?: string
  /** Callback URL from `event.payload.callbackUrl`. */
  callbackUrl?: string
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Runtime configuration for the Stepflow webhook handler.
 * Loaded from environment variables by `loadStepflowConfig()`.
 *
 * Environment variables:
 *   STEPFLOW_WEBHOOK_ENABLED      — `'true'` or `'1'` to enable (default: false)
 *   STEPFLOW_WEBHOOK_SECRET       — HMAC secret shared with Stepflow (required)
 *   STEPFLOW_WEBHOOK_MAX_SESSIONS — max concurrent Stepflow sessions (default: 3)
 */
export interface StepflowConfig {
  /** Master switch — when false, all webhook requests return 200 filtered. */
  enabled: boolean
  /** HMAC-SHA256 secret for verifying `X-Webhook-Signature`. */
  secret: string
  /** Maximum number of simultaneous Stepflow-sourced Claude sessions. */
  maxConcurrentSessions: number
}
